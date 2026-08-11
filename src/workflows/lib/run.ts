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
import { SYNC_CLAIM_HELD } from "../../modules/allegro/service";

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

  if (killSwitch && (await killSwitch.disabled(allegro))) {
    // Recorded, not silent. "Disabled" and "broken" are both "nothing happened"
    // from the outside, and an operator needs to tell them apart at a glance.
    await allegro.writeSyncState(provider, { last_error: killSwitch.reason, status: "idle" });
    return { ran: false, skip: { kind: "disabled", reason: killSwitch.reason } };
  }

  const client = await allegro.getClient();
  if (!client) {
    const reason =
      "Allegro is not connected: no usable stored token. Reconnect Allegro from the admin settings.";
    await allegro.writeSyncState(provider, { last_error: reason, status: "error" });
    return { ran: false, skip: { kind: "not-connected", reason } };
  }

  const claim = await allegro.claimSyncRun(provider);
  if (!(claim.acquired && claim.state)) {
    return { ran: false, skip: { kind: "claim-held", reason: claim.reason ?? SYNC_CLAIM_HELD } };
  }

  let outcome: SyncRunOutcome = {
    lastError: `the "${provider}" sync run did not complete`,
    status: "error",
  };
  try {
    const result = await body({ allegro, client, container, logger, state: claim.state });
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
    await allegro.writeSyncState(provider, {
      ...(outcome.counts === undefined ? {} : { counts: outcome.counts }),
      ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
      ...(outcome.failures === undefined ? {} : { failures: outcome.failures }),
      ...(outcome.writeScopeMissing === undefined
        ? {}
        : { write_scope_missing: outcome.writeScopeMissing }),
      last_error: outcome.lastError ?? null,
      last_synced_at: new Date(),
      status: outcome.status,
    });
  }
};

/** Turn a skip into the one-line message an admin or a job log shows. */
export const describeSkip = (skip: SyncRunSkip): string => skip.reason;
