import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { AllegroClient } from "../../lib/allegro/client";
import { ALLEGRO_MODULE } from "../../modules/allegro";
import type AllegroModuleService from "../../modules/allegro/service";
import type {
  AllegroSyncProvider,
  AllegroSyncStateRow,
  AllegroSyncStatePatch,
} from "../../modules/allegro/service";
import { SYNC_CLAIM_HELD, SYNC_HEARTBEAT_INTERVAL_MS } from "../../modules/allegro/service";

/**
 * The claim lifecycle every sync loop shares.
 *
 * Each loop needs the same five things in the same order, and getting the order
 * wrong is how a loop wedges itself:
 *
 * 1. Refuse to start when its kill switch is on.
 * 2. Refuse to start when Allegro is not connected, and RECORD that - a state row
 *    reading "ok" with no error while the sync has quietly stopped importing is
 *    the failure this repo has already been bitten by once.
 * 3. Take the claim, or report the collision as retryable rather than as failure.
 * 4. Run, with the pre-claim cursor and failure state.
 * 5. Release exactly once, with a PESSIMISTIC default - if the run dies in a way
 *    that skips the assignment, the released state says "error", never a
 *    misleading "ok".
 *
 * Step 5 is why this is a wrapper and not a checklist. A loop that returns early
 * from any of a dozen branches will eventually forget to release, and a claim that
 * is never released blocks the loop until the staleness window expires on every
 * subsequent tick.
 */

/** What a loop reports back to the wrapper. */
export interface SyncRunOutcome {
  status: "ok" | "error";
  lastError?: string | null;
  cursor?: string | null;
  counts?: Record<string, unknown> | null;
  failures?: AllegroSyncStatePatch["failures"];
  writeScopeMissing?: boolean;
}

/** Context handed to a loop that holds the claim. */
export interface SyncRunContext {
  container: MedusaContainer;
  logger: Logger;
  allegro: AllegroModuleService;
  client: AllegroClient;
  /** The state row as it was BEFORE the claim: the cursor and failures to resume from. */
  state: AllegroSyncStateRow;
  /**
   * Re-assert the claim, and report whether this run still holds it.
   *
   * Call it freely between units of work - per command, per form, per poll. It throttles
   * itself to `SYNC_HEARTBEAT_INTERVAL_MS`, so calling it per item costs one cheap update a
   * minute rather than one update per item.
   *
   * A `false` answer means the claim was LOST: another run took it over as stale and is
   * executing right now. The correct response is to stop immediately and write nothing
   * further, because continuing would issue Allegro commands concurrently with that run -
   * exactly what single-flight exists to prevent. The wrapper also refuses to write the
   * state row once this has happened, since the row belongs to the successor.
   */
  heartbeat: () => Promise<boolean>;
}

/** Why a run did not happen. `claimHeld` is retryable; the others are not. */
export type SyncRunSkip =
  | { kind: "disabled"; reason: string }
  | { kind: "not-connected"; reason: string }
  | { kind: "claim-held"; reason: string };

export type SyncRunResult<T> =
  | { ran: true; outcome: SyncRunOutcome; value: T }
  | { ran: false; skip: SyncRunSkip };

/**
 * Run one loop under its claim.
 *
 * `killSwitch` is a predicate rather than a boolean so the switch is re-read at
 * the moment of the run: an operator setting `ALLEGRO_*_SYNC_DISABLED` is
 * responding to an incident, and a value captured at boot would ignore them until
 * a restart. Omit it for a read-only loop, which has nothing to disable.
 */
export const runUnderSyncClaim = async <T>(
  container: MedusaContainer,
  provider: AllegroSyncProvider,
  body: (context: SyncRunContext) => Promise<{ outcome: SyncRunOutcome; value: T }>,
  killSwitch?: {
    disabled: (allegro: AllegroModuleService) => Promise<boolean>;
    reason: string;
  },
): Promise<SyncRunResult<T>> => {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const allegro = container.resolve<AllegroModuleService>(ALLEGRO_MODULE);

  // The two PRE-claim exits below write through `writeSyncStateIfUnclaimed`, and that
  // guard is load-bearing rather than tidy. They run before this call has any claim, so the
  // row may belong to a run that is in flight - and an unconditional
  // `writeSyncState(provider, { status: "idle" })` on such a row makes the NEXT tick's
  // claim succeed, so two runs execute concurrently. That is the exact failure single-flight
  // exists to prevent, reached by the code meant to report a skip. A skipped write is logged
  // rather than swallowed, because "nothing happened and nothing was recorded" is the state
  // this repo has been bitten by before.
  const recordPreClaim = async (patch: AllegroSyncStatePatch, what: string): Promise<void> => {
    const written = await allegro.writeSyncStateIfUnclaimed(provider, patch);
    if (!written) {
      logger.warn(
        `[allegro-${provider}] ${what}, but the state row is held by a run currently in flight, so it was left untouched. The reason was not recorded to avoid releasing that run's claim.`,
      );
    }
  };

  if (killSwitch && (await killSwitch.disabled(allegro))) {
    // Recorded, not silent. "Disabled" and "broken" are both "nothing happened"
    // from the outside, and an operator needs to tell them apart at a glance.
    await recordPreClaim(
      { last_error: killSwitch.reason, status: "idle" },
      "the kill switch is on",
    );
    return { ran: false, skip: { kind: "disabled", reason: killSwitch.reason } };
  }

  const client = await allegro.getClient();
  if (!client) {
    const reason =
      "Allegro is not connected: no usable stored token. Reconnect Allegro from the admin settings.";
    await recordPreClaim({ last_error: reason, status: "error" }, "Allegro is not connected");
    return { ran: false, skip: { kind: "not-connected", reason } };
  }

  const claim = await allegro.claimSyncRun(provider);
  if (!(claim.acquired && claim.state && claim.token)) {
    return { ran: false, skip: { kind: "claim-held", reason: claim.reason ?? SYNC_CLAIM_HELD } };
  }
  const { token } = claim;

  // Throttled here rather than in the service, so a loop can call it per item without
  // thinking about cost, and so "lost the claim" is remembered for the `finally` below.
  //
  // Deliberately starts at 0 so the FIRST call really checks rather than being throttled
  // away. The gap between taking the claim and the first write is not small: it includes
  // paging the whole offer catalogue, which on a large seller is minutes on its own and is
  // easily long enough to have lost the claim before a single command is issued. One extra
  // row update per run is a trivial price for verifying ownership before the first write
  // instead of assuming it.
  let lastBeat = 0;
  let claimLost = false;
  const heartbeat = async (): Promise<boolean> => {
    if (claimLost) {
      return false;
    }
    if (Date.now() - lastBeat < SYNC_HEARTBEAT_INTERVAL_MS) {
      return true;
    }
    const held = await allegro.touchSyncClaim(provider, token);
    lastBeat = Date.now();
    if (!held) {
      claimLost = true;
      logger.error(
        `[allegro-${provider}] LOST the sync claim mid-run: another run took it over as stale and is executing now. Stopping without writing anything further, so this run cannot issue Allegro commands concurrently with it.`,
      );
    }
    return held;
  };

  let outcome: SyncRunOutcome = {
    lastError: `the "${provider}" sync run did not complete`,
    status: "error",
  };
  try {
    const result = await body({
      allegro,
      client,
      container,
      heartbeat,
      logger,
      state: claim.state,
    });
    ({ outcome } = result);
    return { outcome, ran: true, value: result.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[allegro-${provider}] run failed: ${message}`);
    outcome = { lastError: message, status: "error" };
    throw error;
  } finally {
    // Exactly once, by the owner, whatever happened above. A cursor is only
    // persisted when the loop explicitly returned one, so a crashed run replays
    // rather than skipping.
    //
    // Skipped entirely once the claim is known lost: the row now describes the run that
    // took over, and writing this run's counters, cursor and status over it would both
    // report the wrong thing and release a claim it does not hold.
    if (claimLost) {
      logger.error(
        `[allegro-${provider}] not writing the outcome of a run whose claim was taken over; the state row belongs to its successor.`,
      );
    } else {
      const written = await allegro.writeSyncState(
        provider,
        {
          ...(outcome.counts === undefined ? {} : { counts: outcome.counts }),
          ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
          ...(outcome.failures === undefined ? {} : { failures: outcome.failures }),
          ...(outcome.writeScopeMissing === undefined
            ? {}
            : { write_scope_missing: outcome.writeScopeMissing }),
          // Released with the outcome: the token is cleared so the row holds no claim, and
          // the status stops reading `running`.
          claim_token: null,
          last_error: outcome.lastError ?? null,
          last_synced_at: new Date(),
          status: outcome.status,
        },
        { token },
      );
      if (!written) {
        // Conditioned on the token, so a zero-row write means the claim was taken over
        // between the last heartbeat and here. Same conclusion as above, reached later.
        logger.error(
          `[allegro-${provider}] the sync claim was taken over before this run could record its outcome, so nothing was written. The state row belongs to the run that replaced it.`,
        );
      }
    }
  }
};

/** Turn a skip into the one-line message an admin or a job log shows. */
export const describeSkip = (skip: SyncRunSkip): string => skip.reason;
