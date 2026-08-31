import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { AllegroAuthError } from "../lib/allegro/auth-error";
// Value import, not `import type`: `AllegroClient.isCommandTerminal` is called as a
// static below. A type-only import elides the binding at runtime and the call throws
// `AllegroClient is not defined`, which `runCommand` catches and reports as a per-offer
// failure - so every healthy push would look like a failed one.
import { AllegroClient } from "../lib/allegro/client";
import { AllegroApiError, describeError } from "../lib/allegro/errors";
import type { AllegroOffer } from "../lib/allegro/types";
import {
  clearFailureKey,
  isEmptyFailureState,
  isSystemicFailure,
  readFailureState,
  standingHealthLine,
  updateFailureState,
} from "../lib/sync/failure-state";
import type { FailureState } from "../lib/sync/failure-state";
import { formatAmount, parseAmount } from "../lib/sync/money";
import { modeNeedsAutomationRules, modeWrites } from "../lib/pricing-mode";
import type { PricingMode } from "../lib/pricing-mode";
import {
  decideFixedPriceAction,
  decideSyncAction,
  emptySkipCounts,
  evaluateSyncEligibility,
  promotionStateLabel,
  resolveExpectedRuleIds,
  resolvePriceMode,
  SYNC_SKIP_LABEL,
} from "../lib/sync/price-automation";
import type {
  AutomationRuleNames,
  OfferStatus,
  PriceMode,
  SyncBounds,
  SyncSkipReason,
} from "../lib/sync/price-automation";
import { ALLEGRO_MODULE } from "../modules/allegro";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import type { AllegroSyncOptions } from "../modules/allegro/service";
import type AllegroModuleService from "../modules/allegro/service";
import { listEligibleVariants } from "./lib/catalog";
import { listAllOffers } from "./lib/offers";
import type { OfferListing } from "./lib/offers";
import type { SrpSource } from "./lib/pricing";
import {
  buildBreakEvenResolver,
  buildCategoryRates,
  buildSrpBySku,
  buildVariantPriceBySku,
  resolveCommissionFraction,
  resolveSrp,
  resolveCostsService,
  resolveVariantPrice,
  warnOnMissingSrpSource,
} from "./lib/pricing";
import { resolvePromotionOverlay } from "./lib/promotion-overlay";
import type { PromoRuleOverride } from "./lib/promotion-overlay";
import { runUnderSyncClaim } from "./lib/run";
import { warnOnUnscopedCatalogue } from "./lib/scope-warnings";

/**
 * The armed price-sync loop.
 *
 * ## The three pricing modes
 *
 * What this loop does at all is a SETTING, not a property of the code (see
 * `src/lib/pricing-mode.ts`). The mode is resolved before the claim is taken, and
 * it decides which of three shapes the run has:
 *
 * - **`monitor`** works out the `[break-even, SRP]` bounds for every eligible
 *   linked offer, counts how many are currently priced outside them, and sends
 *   NOTHING to Allegro. It is a named, chosen state rather than the accidental
 *   one a disarmed writer produces, and it needs no automation rules configured.
 * - **`automation_rule`** keeps every eligible offer on the rule its promotion
 *   state calls for, attaching the rule where it is missing, switching it on a
 *   promotion flip, and re-asserting the bounds whenever they drift from the last
 *   successfully pushed ones. Allegro's engine picks the number inside the range.
 *   Allegro does not expose an attached rule's price range, so
 *   `allegro_price_push` is the only bounds memory there is (see
 *   `fetchLastSuccessfulBounds` and `decideSyncAction`).
 * - **`fixed_price`** sets each offer's Buy Now price to the price the variant
 *   already carries in Medusa, removing any attached rule first because a rule
 *   would recalculate straight over it. The bounds still gate the write: a Medusa
 *   price outside them is refused and counted, never clamped.
 *
 * The floor and the ceiling apply in every mode. They are the safety story of the
 * whole plugin, and a mode that skipped them would be a mode that can sell below
 * cost.
 *
 * ## The write-scope gap, and why it is not a failure
 *
 * The price-automation command endpoint needs `allegro:api:sale:offers:write`. A
 * connection granted without it answers HTTP 403 on every command. That is not a
 * bug and not a per-offer failure - it is ONE systemic condition, so the loop
 * records `write_scope_missing` on the state row, no-ops safely, and the admin
 * raises a persistent reconnect banner. The first run afterwards that reaches the
 * endpoint without a 403 clears the flag.
 *
 * Treating it as a per-offer failure instead would quarantine the entire catalogue
 * over a configuration problem one reconnect fixes.
 *
 * ## Safety machinery
 *
 * - **Fail-loud rule resolution.** The two rule names are resolved against the
 *   live rules list on every run. Missing, renamed, or ambiguous aborts the WHOLE
 *   run with nothing written. The plugin never guesses which rule an operator meant
 *   and never creates one.
 * - **Change cap.** At most `changeCap` commands per run, so a bug that mislabels
 *   the whole catalogue as drifting can reprice at most that many offers before a
 *   human sees the run and can flip the kill switch. The remainder waits.
 * - **Per-offer quarantine** after five consecutive failures, so one permanently
 *   bad offer cannot burn the run's budget every tick.
 * - **Circuit breaker.** A tick where every command failed, or where any command
 *   hit 429 / 5xx / an auth error / the 403 scope gap, is SYSTEMIC: nothing is
 *   quarantined, the run holds, the next tick retries. Quarantine is only safe on
 *   the evidence that the rest of the pipeline works.
 * - **Single-flight claim**, so a scheduled run and an operator's manual push
 *   cannot interleave on the same offer.
 */

export interface PriceSyncSummary {
  /** The pricing mode this run honoured, so a summary is never ambiguous about it. */
  mode: PricingMode;
  /** Set when the run did nothing. */
  skipped?: string;
  /** Linked offers considered this run. */
  scanned: number;
  /**
   * Monitor mode only: offers whose floor and ceiling both resolved, and how many
   * of those are currently priced outside them. This is what makes monitor a
   * useful state rather than an idle one - it is the report you read before
   * arming a mode that writes.
   */
  monitored: number;
  belowFloor: number;
  aboveCeiling: number;
  /** Commands Allegro confirmed applied. */
  synced: number;
  /** Offers already on the right rule with the right recorded bounds. */
  alreadyInSync: number;
  /** Commands submitted but not confirmed terminal within the poll budget. */
  pending: number;
  /** Per-offer command failures (not systemic). */
  failed: number;
  /** Offers skipped as ineligible, counted by reason. */
  skippedCounts: Record<SyncSkipReason, number>;
  /** Offers the loop has given up auto-retrying; a manual push is the remedy. */
  quarantined: string[];
  /** The run hit a systemic condition and held; nothing was quarantined. */
  systemic: boolean;
  /** The stored token cannot write offers; the reconnect banner is raised. */
  writeScopeMissing: boolean;
  /** The change cap was hit; the remainder waits for the next tick. */
  capped: boolean;
  /** Offers held out because their mapping row carries a conflict. */
  conflicted: number;
  error?: string;
}

export const emptyPriceSyncSummary = (mode: PricingMode): PriceSyncSummary => ({
  aboveCeiling: 0,
  alreadyInSync: 0,
  belowFloor: 0,
  capped: false,
  conflicted: 0,
  failed: 0,
  mode,
  monitored: 0,
  pending: 0,
  quarantined: [],
  scanned: 0,
  skippedCounts: emptySkipCounts(),
  synced: 0,
  systemic: false,
  writeScopeMissing: false,
});

/** A mapping row, as the price loop reads it. */
interface OfferRow {
  id: string;
  sku: string;
  offer_id?: string | null;
  category_id?: string | null;
  /** Three-state: true / false / NULL-or-absent meaning "not resolved". */
  promoted?: boolean | null;
  price_sync_enabled?: boolean;
  price_currency?: string | null;
  conflict?: string | null;
}

/** One offer to push, with everything the command and the audit row need. */
interface OfferPlan {
  sku: string;
  rowId: string;
  offerId: string;
  promoted: boolean;
  floor: number;
  ceiling: number;
  currency: string;
  observedRuleId?: string;
  observedRuleName?: string;
  observedMode: PriceMode;
  /**
   * Automation-rule mode only: the rule to end up on. Absent in fixed-price
   * mode, where the point of the write is that no rule governs the offer.
   */
  expectedRule?: string;
  expectedRuleId?: string;
  /** Fixed-price mode only: the exact Buy Now price to set. */
  price?: number;
  /**
   * What the write is:
   *
   * - `attach` / `switch` / `bounds` - automation-rule mode (see `decideSyncAction`).
   * - `price` - fixed-price mode, no rule in the way.
   * - `detach-and-price` - fixed-price mode on an offer that still carries a
   *   rule: remove it first, or Allegro's engine recalculates over the new price.
   */
  kind: "attach" | "switch" | "bounds" | "price" | "detach-and-price";
}

type CommandOutcome =
  | { kind: "success"; commandId?: string }
  | { kind: "failed"; error: string }
  | { kind: "pending"; commandId?: string; error: string }
  | { kind: "systemic"; scope: boolean; error: string };

/** Rows to read per page of the bounds-memory scan. */
const BOUNDS_PAGE_SIZE = 1000;
/**
 * Pages of bounds memory read per run.
 *
 * `allegro_price_push` is append-only, so this scan grows with HISTORY rather than with
 * the catalogue: without a cap every tick eventually reads every success row ever written.
 * 50k rows is far more than a healthy store accumulates between prunes, and overrunning it
 * is reported rather than absorbed.
 */
const BOUNDS_MAX_PAGES = 50;

/**
 * Bounds memory: the `[floor, ceiling]` recorded on the LAST SUCCESSFUL push per
 * offer, read back from this plugin's own audit.
 *
 * The offer API does not expose an attached rule's price range - it is writable
 * and unreadable - so this audit is the only record of what bounds landed. Two
 * consequences the scan has to honour:
 *
 * - Rows are read newest-first and only the FIRST success per offer counts. A
 *   latest success that carries no bounds still claims the slot, so it reads as "no
 *   bounds on record" and triggers a re-push, rather than letting an older row's
 *   stale bounds look current.
 * - Only `result: "success"` rows count. An `observed` row is the monitor recording
 *   state it did not write, and a `failed` row's bounds never landed.
 */
const fetchLastSuccessfulBounds = async (
  allegro: AllegroModuleService,
  logger: Logger,
): Promise<Map<string, SyncBounds>> => {
  const bounds = new Map<string, SyncBounds>();
  const seen = new Set<string>();

  for (let page = 0; page < BOUNDS_MAX_PAGES; page += 1) {
    // Offset pagination over our own table; each page depends on the previous.
    //
    // The `id` tiebreak is load-bearing, not cosmetic. Offset pagination over an
    // unstable sort is not a partition: `pushed_at` is a timestamp, a run pushes many
    // offers in quick succession, and rows sharing one timestamp may come back in a
    // different order on each page request. A row could then be returned on two pages
    // (harmless, `seen` dedupes it) or on NEITHER - and a skipped row is a lost bounds
    // record, which reads as "no bounds on record" and re-pushes an offer that was
    // already correct. Adding a unique second key makes the ordering total, so every
    // row appears exactly once across the pages.
    const rows = (await allegro.listAllegroPricePushes(
      { result: "success" },
      {
        order: { id: "DESC", pushed_at: "DESC" },
        skip: page * BOUNDS_PAGE_SIZE,
        take: BOUNDS_PAGE_SIZE,
      },
    )) as unknown as Record<string, unknown>[];

    for (const row of rows) {
      const offerId = row.offer_id as string | null;
      if (!offerId || seen.has(offerId)) {
        continue;
      }
      seen.add(offerId);
      const floor = parseAmount(row.bound_floor as string | null);
      const ceiling = parseAmount(row.bound_ceiling as string | null);
      if (floor !== undefined && ceiling !== undefined) {
        bounds.set(offerId, { ceiling, floor });
      }
    }

    if (rows.length < BOUNDS_PAGE_SIZE) {
      return bounds;
    }
  }

  // The audit is append-only, so this scan grows with history rather than with the
  // catalogue and would otherwise read every success row ever written on every tick.
  // Bounded and reported instead of unbounded: the consequence of stopping early is that
  // the oldest offers read as having no bounds on record and get re-pushed, which is
  // idempotent and merely wasteful - whereas an unbounded scan degrades every run
  // forever. A store that reaches this needs the audit pruned or the scan indexed.
  logger.warn(
    `[allegro-prices] the bounds-memory scan hit its page cap (${BOUNDS_MAX_PAGES} x ${BOUNDS_PAGE_SIZE} rows) without exhausting allegro_price_push. Offers whose last successful push is older than that read as having no recorded bounds and will be re-pushed once. Prune the audit table or add an index to keep this scan bounded.`,
  );
  return bounds;
};

/** Best-effort per-offer fail reason from the command's task report. */
const describeCommandFailure = async (
  client: AllegroClient,
  commandId: string,
): Promise<string> => {
  try {
    const { tasks } = await client.getOfferPriceAutomationCommandTasks(commandId);
    const failed = (tasks ?? []).find((task) => task.status === "FAIL");
    const detail =
      failed?.errors?.[0]?.userMessage ?? failed?.errors?.[0]?.message ?? failed?.message;
    return detail ? `command reported failure: ${detail}` : "command reported a failed task";
  } catch {
    return "command reported a failed task";
  }
};

/**
 * What a terminal command report proves, read the same way for every resource.
 *
 * Shared by the rule-assignment and the price-change paths because both answer
 * with Allegro's `GeneralReport` and both have exactly the same trap: success has
 * to be asserted on POSITIVE evidence, never on the absence of a failure.
 */
type CommandVerdict =
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "pending"; error: string };

/**
 * Read a terminal report into a verdict, and the audit patch that records it.
 *
 * Four shapes, and three of them used to read as success:
 *
 * - **Not terminal within the poll budget.** Submitted, unconfirmed. NOT a
 *   failure - a slow command must not build a streak toward quarantining a
 *   healthy offer - and crucially not a success either, so the row stays
 *   invisible to the bounds memory and the next run re-pushes, which is
 *   idempotent.
 * - **Terminal with failed tasks.** A real per-offer failure; the task report
 *   carries the reason.
 * - **Terminal with no task tally at all.** Nothing is confirmed, so it settles
 *   as pending and the next run re-checks.
 * - **Terminal with a tally that scheduled nothing** (`total: 0`, the offer
 *   criteria matched no offer). A command that scheduled no task did not change
 *   anything, which is a failure worth surfacing rather than a quiet success.
 */
const interpretCommandReport = async (
  terminal: { completedAt?: string | null; taskCount?: { failed: number; success: number; total: number } },
  commandId: string,
  describeFailure: () => Promise<string>,
): Promise<{ verdict: CommandVerdict; patch: Record<string, unknown> }> => {
  if (!AllegroClient.isCommandTerminal(terminal)) {
    return {
      patch: {
        allegro_command_id: commandId,
        error: "not terminal within the poll budget",
        result: "skipped",
      },
      verdict: { error: "command still pending", kind: "pending" },
    };
  }
  const tally = terminal.taskCount;
  if (tally && tally.failed > 0) {
    const detail = await describeFailure();
    return {
      patch: { allegro_command_id: commandId, error: detail },
      verdict: { error: detail, kind: "failed" },
    };
  }
  if (!tally) {
    return {
      patch: {
        allegro_command_id: commandId,
        error: "command reported terminal without a task tally, so nothing is confirmed",
        result: "skipped",
      },
      verdict: { error: "command terminal without a task tally", kind: "pending" },
    };
  }
  if (tally.success < 1) {
    const detail = "command completed without scheduling a task for the offer";
    return {
      patch: { allegro_command_id: commandId, error: detail },
      verdict: { error: detail, kind: "failed" },
    };
  }
  return {
    patch: { allegro_command_id: commandId, error: null, result: "success" },
    verdict: { kind: "success" },
  };
};

/**
 * Classify a thrown error into an outcome, and the line the audit row records.
 *
 * Shared by both command paths: the 403 write-scope gap, an auth failure and a
 * 429/5xx are systemic conditions about the connection rather than facts about
 * one offer, whichever resource surfaced them.
 */
const mapCommandError = (error: unknown): { outcome: CommandOutcome; auditError: string } => {
  if (error instanceof AllegroAuthError) {
    return {
      auditError: `auth: ${error.message}`,
      outcome: { error: `auth error: ${error.message}`, kind: "systemic", scope: false },
    };
  }
  if (error instanceof AllegroApiError) {
    if (error.isForbidden()) {
      return {
        auditError: `write scope missing (403): ${error.message}`,
        outcome: { error: "write scope missing (403)", kind: "systemic", scope: true },
      };
    }
    if (error.isSystemic()) {
      return {
        auditError: `systemic ${error.httpStatus}: ${error.message}`,
        outcome: {
          error: `HTTP ${error.httpStatus}: ${error.message}`,
          kind: "systemic",
          scope: false,
        },
      };
    }
    return { auditError: error.message, outcome: { error: error.message, kind: "failed" } };
  }
  const message = describeError(error);
  return { auditError: message, outcome: { error: message, kind: "failed" } };
};

/**
 * Open the audit row for one write, and hand back the way to close it.
 *
 * The row goes in FIRST, before any command. A push this plugin cannot record is
 * not one it wants to make: in automation-rule mode the row is the only bounds
 * memory, so a command whose bounds went unrecorded would be re-pushed on every
 * subsequent run forever. That ordering also makes an audit-insert failure a
 * per-offer failure rather than a systemic one - it is local to one row, and a
 * database blip must not hold the whole run.
 */
const openAuditRow = async (
  allegro: AllegroModuleService,
  row: Record<string, unknown>,
): Promise<
  { ok: true; finalize: (patch: Record<string, unknown>) => Promise<void> } | { ok: false; error: string }
> => {
  let pushId: string;
  try {
    const [created] = (await allegro.createAllegroPricePushes([row] as never)) as unknown as {
      id: string;
    }[];
    pushId = created.id;
  } catch (error) {
    return {
      error: `audit insert failed: ${describeError(error)}`,
      ok: false,
    };
  }
  return {
    finalize: async (patch: Record<string, unknown>): Promise<void> => {
      try {
        await allegro.updateAllegroPricePushes([{ id: pushId, ...patch }] as never);
      } catch {
        // Swallowed deliberately: the command has already happened, and throwing here
        // would report a successful push as a failure and re-push it next run.
      }
    },
    ok: true,
  };
};

/**
 * Automation-rule mode: insert the audit row, assign the rule with its price
 * range, poll to terminal, finalize the row.
 */
const runCommand = async (
  allegro: AllegroModuleService,
  client: AllegroClient,
  plan: OfferPlan,
  pushedBy: string,
  marketplaceId: string,
): Promise<CommandOutcome> => {
  if (!(plan.expectedRuleId && plan.expectedRule)) {
    // Unreachable through the planner, which only produces rule-shaped plans in
    // automation-rule mode. Stated rather than asserted with a non-null: a plan
    // that reached here without a rule is a bug, and inventing one is the single
    // thing this plugin promises never to do.
    return {
      error: "internal: an automation-rule command was planned without a resolved rule",
      kind: "failed",
    };
  }
  const opened = await openAuditRow(allegro, {
    // Text, exactly as it goes to Allegro. The audit has to record the bytes
    // that were sent, not a re-rendering of them.
    bound_ceiling: formatAmount(plan.ceiling),
    bound_floor: formatAmount(plan.floor),
    offer_id: plan.offerId,
    price_mode_new: "automated",
    price_mode_old: plan.observedMode,
    promotion_state: promotionStateLabel(plan.promoted),
    pushed_at: new Date(),
    pushed_by: pushedBy,
    // Written as `failed` and corrected on success. A crash between the insert
    // and the command leaves a row that overstates the damage, which is the
    // safe direction: it does not claim bounds landed that may not have.
    result: "failed",
    rule_id_new: plan.expectedRuleId,
    rule_id_old: plan.observedRuleId ?? null,
    rule_name_new: plan.expectedRule,
    rule_name_old: plan.observedRuleName ?? null,
    sku: plan.sku,
  });
  if (!opened.ok) {
    return { error: opened.error, kind: "failed" };
  }
  const { finalize } = opened;

  try {
    const report = await client.assignOfferPriceAutomation({
      bounds: {
        max: { amount: formatAmount(plan.ceiling), currency: plan.currency },
        min: { amount: formatAmount(plan.floor), currency: plan.currency },
      },
      marketplaceId,
      offerId: plan.offerId,
      ruleId: plan.expectedRuleId,
    });
    const terminal = await client.pollOfferPriceAutomationCommand(report.id);
    // `AllegroClient.isCommandTerminal`, never a local re-derivation - see
    // `interpretCommandReport`, which owns that test for both command paths.
    const { patch, verdict } = await interpretCommandReport(terminal, report.id, () =>
      describeCommandFailure(client, report.id),
    );
    await finalize(patch);
    return verdict.kind === "success"
      ? { commandId: report.id, kind: "success" }
      : verdict.kind === "pending"
        ? { commandId: report.id, error: verdict.error, kind: "pending" }
        : { error: verdict.error, kind: "failed" };
  } catch (error) {
    const { auditError, outcome } = mapCommandError(error);
    await finalize({ error: auditError });
    return outcome;
  }
};

/**
 * Fixed-price mode: insert the audit row, remove any attached rule, set the Buy
 * Now price, poll each command to terminal, finalize the row.
 *
 * Two Allegro commands where the automation path issues one, and the ORDER is
 * load-bearing. A price written under a live automation rule does not survive the
 * rule's next recalculation, so the rule comes off first. If the removal does not
 * confirm, the price is NOT sent: a half-applied pair that left the rule on and
 * the price changed would be exactly the fight with Allegro's engine this
 * sequencing exists to avoid, and re-running the pair next tick is idempotent.
 *
 * The audit row carries the price that was sent (`price_amount` /
 * `price_currency`) and deliberately leaves `bound_floor` / `bound_ceiling` NULL:
 * no price range was attached to anything, and writing the guard rails into those
 * columns would make `fetchLastSuccessfulBounds` report a rule range that does not
 * exist, so a later automation-rule run would skip an offer it should re-attach.
 */
const runFixedPriceCommand = async (
  allegro: AllegroModuleService,
  client: AllegroClient,
  plan: OfferPlan,
  pushedBy: string,
  marketplaceId: string,
): Promise<CommandOutcome> => {
  if (plan.price === undefined) {
    return { error: "internal: a fixed-price command was planned without a price", kind: "failed" };
  }
  const amount = formatAmount(plan.price);
  const opened = await openAuditRow(allegro, {
    offer_id: plan.offerId,
    price_amount: amount,
    price_currency: plan.currency,
    price_mode_new: "fixed",
    price_mode_old: plan.observedMode,
    promotion_state: promotionStateLabel(plan.promoted),
    pushed_at: new Date(),
    pushed_by: pushedBy,
    result: "failed",
    // The rule that was REMOVED, when one was. `rule_*_new` stays null: the point
    // of this write is that no rule governs the offer afterwards.
    rule_id_old: plan.observedRuleId ?? null,
    rule_name_old: plan.observedRuleName ?? null,
    sku: plan.sku,
  });
  if (!opened.ok) {
    return { error: opened.error, kind: "failed" };
  }
  const { finalize } = opened;

  try {
    if (plan.kind === "detach-and-price") {
      const removal = await client.removeOfferPriceAutomation({
        marketplaceId,
        offerId: plan.offerId,
      });
      const removalTerminal = await client.pollOfferPriceAutomationCommand(removal.id);
      const removalRead = await interpretCommandReport(removalTerminal, removal.id, () =>
        describeCommandFailure(client, removal.id),
      );
      if (removalRead.verdict.kind !== "success") {
        // The price is NOT sent. Reported verbatim so an operator reads "the rule
        // could not be removed" rather than a price failure that would send them
        // looking at the wrong thing.
        const detail = `the price-automation rule could not be removed, so the price was not set: ${removalRead.verdict.error}`;
        await finalize({ allegro_command_id: removal.id, error: detail });
        return removalRead.verdict.kind === "pending"
          ? { commandId: removal.id, error: detail, kind: "pending" }
          : { error: detail, kind: "failed" };
      }
    }

    // A caller-generated id, because the price resource is a PUT on the command
    // id rather than a POST that mints one. Fresh per attempt: reusing it across
    // runs would make a legitimate re-push answer 409 instead of applying.
    const commandId = crypto.randomUUID();
    const report = await client.changeOfferPrice({
      commandId,
      marketplaceId,
      offerId: plan.offerId,
      price: { amount, currency: plan.currency },
    });
    const reportId = report.id ?? commandId;
    const terminal = await client.pollOfferPriceChangeCommand(reportId);
    const { patch, verdict } = await interpretCommandReport(terminal, reportId, async () => {
      try {
        const { tasks } = await client.getOfferPriceChangeCommandTasks(reportId);
        const failed = (tasks ?? []).find((task) => task.status === "FAIL");
        const detail =
          failed?.errors?.[0]?.userMessage ?? failed?.errors?.[0]?.message ?? failed?.message;
        return detail ? `command reported failure: ${detail}` : "command reported a failed task";
      } catch {
        return "command reported a failed task";
      }
    });
    await finalize(patch);
    return verdict.kind === "success"
      ? { commandId: reportId, kind: "success" }
      : verdict.kind === "pending"
        ? { commandId: reportId, error: verdict.error, kind: "pending" }
        : { error: verdict.error, kind: "failed" };
  } catch (error) {
    const { auditError, outcome } = mapCommandError(error);
    await finalize({ error: auditError });
    return outcome;
  }
};

/** Issue the write one plan calls for, in whichever mode produced it. */
const runPlan = async (
  allegro: AllegroModuleService,
  client: AllegroClient,
  plan: OfferPlan,
  pushedBy: string,
  marketplaceId: string,
): Promise<CommandOutcome> =>
  plan.kind === "price" || plan.kind === "detach-and-price"
    ? await runFixedPriceCommand(allegro, client, plan, pushedBy, marketplaceId)
    : await runCommand(allegro, client, plan, pushedBy, marketplaceId);

/** Everything the planner needs, resolved once per run. */
interface PlanningInputs {
  ruleNames: Map<string, string>;
  /**
   * The two rules resolved to ids. Present ONLY in automation-rule mode - the
   * other two modes never attach a rule, and demanding two rule names from a
   * store that prices with fixed prices would be asking for configuration it has
   * no use for.
   */
  expectedIds?: { standardId: string; promotedId: string };
  rules?: AutomationRuleNames;
  /**
   * Per-SKU promotional rule overrides from an armed promotion. Absent for every SKU
   * no promotion covers, which is what makes reverting free: when a promotion ends
   * the SKU simply drops out of this map, the expected rule falls back to
   * `rules`, and the planner emits the switch back.
   */
  promoRulesBySku?: Map<string, PromoRuleOverride>;
  categoryRates: ReturnType<typeof buildCategoryRates>;
  breakEvenFor: (sku: string, commission: number | undefined) => Promise<number | undefined>;
  srp: SrpSource;
  /** The Medusa price per SKU per currency; the number fixed-price mode pushes. */
  variantPrices: Map<string, Map<string, number>>;
  lastBounds: Map<string, SyncBounds>;
}

/** The bounds and promotion state one offer resolved to, in any mode. */
interface OfferBounds {
  promoted: boolean;
  floor: number;
  ceiling: number;
  currency: string;
}

/**
 * The mode-independent half of planning: is this offer safe to price at all, and
 * between which two numbers?
 *
 * Shared by all three modes on purpose. The floor and the ceiling are not an
 * automation-rule detail - they are what stops this plugin selling below cost -
 * so monitoring, rule attachment and fixed pricing all go through exactly the
 * same eligibility ladder and get exactly the same counted skip reasons.
 */
const resolveOfferBounds = async (
  row: OfferRow,
  offer: AllegroOffer,
  inputs: PlanningInputs,
  opts: { ignoreDisabled?: boolean } = {},
): Promise<{ bounds: OfferBounds } | { skip: SyncSkipReason }> => {
  // The promoted flag selects BOTH the expected rule and the commission rate, so it is
  // resolved before anything else that depends on it.
  //
  // `?? undefined` collapses NULL and absent into the one value the eligibility ladder
  // treats as "not resolved". The column is deliberately nullable (see the model): NULL
  // is not "not promoted", and pricing it as though it were gives a promoted offer a
  // floor computed on the standard commission - below its true break-even, so the rule
  // may sell it at a loss. The `promotion-unresolved` gate below is what catches that,
  // and it was unreachable while the column defaulted to false.
  const promoted = row.promoted ?? undefined;
  // `promoted`, not `promoted ?? false`. Laundering an unresolved state into "standard"
  // picks the LOWER commission, which yields a floor below a promoted offer's true
  // break-even. The eligibility gate below refuses the offer regardless, so this was latent
  // rather than live - and latent is exactly how it comes back.
  const commission = resolveCommissionFraction(inputs.categoryRates, row.category_id, promoted);
  const breakEven =
    promoted === undefined ? undefined : await inputs.breakEvenFor(row.sku, commission);

  // The offer's own currency, resolved BEFORE eligibility because the SRP ceiling is
  // currency-specific: a price-list SRP in another currency is not a usable ceiling for this
  // offer, and using one is a mispricing rather than a rounding difference.
  const currency = row.price_currency ?? offer.sellingMode?.price?.currency ?? "PLN";

  const eligibility = evaluateSyncEligibility({
    breakEvenPrice: breakEven,
    offerLinked: true,
    offerStatus: offer.publication?.status as OfferStatus | undefined,
    priceSyncEnabled: opts.ignoreDisabled ? true : (row.price_sync_enabled ?? true),
    promoted,
    srp: resolveSrp(inputs.srp, row.sku, currency),
  });
  if (!eligibility.eligible) {
    return { skip: eligibility.reason };
  }
  return {
    bounds: {
      ceiling: eligibility.ceiling,
      currency,
      floor: eligibility.floor,
      promoted: eligibility.promoted,
    },
  };
};

/** The observed automation state of an offer, as both write planners read it. */
const observedRule = (
  offer: AllegroOffer,
  inputs: PlanningInputs,
): { id?: string; name?: string } => {
  const id = offer.sellingMode?.priceAutomation?.rule?.id;
  return { id, name: id ? inputs.ruleNames.get(id) : undefined };
};

/** The price mode this run observed on the offer, for the audit row. */
const observedPriceMode = (offer: AllegroOffer, ruleId?: string): PriceMode =>
  resolvePriceMode({
    attachedRuleId: ruleId,
    observed: true,
    status: offer.publication?.status as OfferStatus | undefined,
  });

/**
 * Automation-rule mode: build a plan for one mapping row plus its live offer, or
 * say why not.
 */
const planOffer = async (
  row: OfferRow,
  offer: AllegroOffer,
  inputs: PlanningInputs,
  opts: { ignoreDisabled?: boolean } = {},
): Promise<{ plan: OfferPlan } | { skip: SyncSkipReason } | { noop: true }> => {
  const resolved = await resolveOfferBounds(row, offer, inputs, opts);
  if ("skip" in resolved) {
    return resolved;
  }
  const { ceiling, currency, floor, promoted } = resolved.bounds;
  if (!(inputs.rules && inputs.expectedIds)) {
    // Unreachable: the caller only selects this planner in automation-rule mode,
    // where `resolvePlanningInputs` has already resolved both rules or aborted the
    // whole run. Stated rather than asserted away, because "attach whichever rule
    // seems likely" is the one behaviour this plugin promises never to have.
    return { skip: "sync-disabled" };
  }

  // An armed promotion swaps in its own pair of rule names for this SKU. Everything
  // downstream - the drift comparison, the switch, the cap, the audit - is unchanged,
  // which is why applying and reverting a promotion need no separate machinery.
  const promo = inputs.promoRulesBySku?.get(row.sku);
  const effectiveRules = promo?.names ?? inputs.rules;
  const effectiveIds = promo?.ids ?? inputs.expectedIds;

  const rule = observedRule(offer, inputs);
  const decision = decideSyncAction({
    attachedRuleId: rule.id,
    attachedRuleName: rule.name,
    desiredBounds: { ceiling, floor },
    lastPushedBounds: inputs.lastBounds.get(offer.id),
    promoted,
    rules: effectiveRules,
  });
  if (!decision.act) {
    return { noop: true };
  }

  return {
    plan: {
      ceiling,
      // The offer's own currency, as Allegro reported it. Allegro rejects a range
      // in any other currency, and defaulting to PLN would break a seller listing
      // on a non-PLN marketplace.
      currency,
      expectedRule: decision.expectedRule,
      expectedRuleId: promoted ? effectiveIds.promotedId : effectiveIds.standardId,
      floor,
      kind: decision.kind,
      observedMode: observedPriceMode(offer, rule.id),
      observedRuleId: rule.id,
      observedRuleName: rule.name,
      offerId: offer.id,
      promoted,
      rowId: row.id,
      sku: row.sku,
    },
  };
};

/**
 * Fixed-price mode: build a plan to put the Medusa price on this offer, or say
 * why not.
 *
 * Two failure modes of its own, both counted rather than silent: the variant has
 * no Medusa price in the offer's currency (`missing-medusa-price`), and the price
 * it does have sits outside the break-even floor or the SRP ceiling
 * (`price-outside-bounds`). The second is refused rather than clamped - see
 * `decideFixedPriceAction` - because clamping sells at a price the store never
 * set, and pushing sells below cost.
 */
const planFixedPriceOffer = async (
  row: OfferRow,
  offer: AllegroOffer,
  inputs: PlanningInputs,
  opts: { ignoreDisabled?: boolean } = {},
): Promise<{ plan: OfferPlan } | { skip: SyncSkipReason } | { noop: true }> => {
  const resolved = await resolveOfferBounds(row, offer, inputs, opts);
  if ("skip" in resolved) {
    return resolved;
  }
  const { ceiling, currency, floor, promoted } = resolved.bounds;

  const desiredPrice = resolveVariantPrice(inputs.variantPrices, row.sku, currency);
  if (desiredPrice === undefined) {
    return { skip: "missing-medusa-price" };
  }

  const rule = observedRule(offer, inputs);
  const decision = decideFixedPriceAction({
    attachedRuleId: rule.id,
    bounds: { ceiling, floor },
    desiredPrice,
    observedPrice: parseAmount(offer.sellingMode?.price?.amount ?? null),
  });
  if (!decision.act) {
    return "refuse" in decision ? { skip: decision.refuse } : { noop: true };
  }

  return {
    plan: {
      ceiling,
      currency,
      floor,
      kind: decision.kind,
      observedMode: observedPriceMode(offer, rule.id),
      observedRuleId: rule.id,
      observedRuleName: rule.name,
      offerId: offer.id,
      price: desiredPrice,
      promoted,
      rowId: row.id,
      sku: row.sku,
    },
  };
};

/** Plan one offer in whichever mode is in force. */
const planForMode = async (
  mode: PricingMode,
  row: OfferRow,
  offer: AllegroOffer,
  inputs: PlanningInputs,
  opts: { ignoreDisabled?: boolean } = {},
): Promise<{ plan: OfferPlan } | { skip: SyncSkipReason } | { noop: true }> =>
  mode === "fixed_price"
    ? await planFixedPriceOffer(row, offer, inputs, opts)
    : await planOffer(row, offer, inputs, opts);

/** Resolve everything a run plans against. */
const resolvePlanningInputs = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  client: AllegroClient,
  logger: Logger,
  options: AllegroSyncOptions,
  rules: AutomationRuleNames | undefined,
  skus: readonly string[],
): Promise<{ ok: true; inputs: PlanningInputs } | { ok: false; error: string }> => {
  // The account's rules are read in EVERY mode, but they are only RESOLVED to ids
  // in automation-rule mode. The names are what turn an offer's attached rule id
  // into something an operator can read, and monitor and fixed-price modes both
  // report that state - the first as an observation, the second on the audit row
  // for the rule it removed.
  const { rules: accountRules } = await client.listPriceAutomationRules();
  const ruleNames = new Map<string, string>();
  for (const rule of accountRules ?? []) {
    if (rule.id && rule.name) {
      ruleNames.set(rule.id, rule.name);
    }
  }

  let expectedIds: { promotedId: string; standardId: string } | undefined;
  if (rules) {
    const expected = resolveExpectedRuleIds(accountRules ?? [], rules);
    if (!expected.ok) {
      // The fail-loud abort. Nothing is written: this plugin does not guess which rule
      // an operator meant, and it never creates or edits one.
      return { error: expected.error, ok: false };
    }
    expectedIds = { promotedId: expected.promotedId, standardId: expected.standardId };
  }

  // The overlay only runs in automation-rule mode (it swaps rule names), and only
  // when its own toggle is armed. A refusal is logged and alerted inside, and leaves
  // the affected promotion simply not applied rather than failing the whole run:
  // ordinary drift correction for every other offer must keep working.
  let promoRulesBySku: Map<string, PromoRuleOverride> | undefined;
  if (rules) {
    const overlay = await resolvePromotionOverlay(container, client, rules);
    if (overlay.bySku.size > 0 || overlay.active > 0) {
      logger.info(
        `[allegro-prices] promotion overlay: ${overlay.active} armed promotion(s), ${overlay.bySku.size} SKU(s) on a promotional rule, ${overlay.refused.length} refused.`,
      );
    }
    promoRulesBySku = overlay.bySku;
  }

  warnOnMissingSrpSource(logger, options);
  warnOnUnscopedCatalogue(logger, options, "prices");
  const variants = await listEligibleVariants(container, options);
  const [rateRows, srpSource, lastBounds, breakEvenFor] = await Promise.all([
    allegro.listAllegroCategoryRates({}) as Promise<Record<string, unknown>[]>,
    buildSrpBySku(container, variants, options),
    fetchLastSuccessfulBounds(allegro, logger),
    buildBreakEvenResolver(resolveCostsService(container, options.costsModuleKey), skus),
  ]);

  return {
    inputs: {
      breakEvenFor,
      categoryRates: buildCategoryRates(rateRows),
      ...(expectedIds ? { expectedIds } : {}),
      lastBounds,
      ruleNames,
      ...(promoRulesBySku ? { promoRulesBySku } : {}),
      ...(rules ? { rules } : {}),
      srp: srpSource,
      variantPrices: buildVariantPriceBySku(variants),
    },
    ok: true,
  };
};

/** The `last_error` line for the admin, or null when the run was clean. */
const buildPriceSyncError = (summary: PriceSyncSummary, systemicError?: string): string | null => {
  const parts: string[] = [];
  if (summary.writeScopeMissing) {
    parts.push(
      "WRITE_SCOPE_MISSING: the stored Allegro token cannot write offers, so nothing was pushed. Reconnect Allegro with the offer write scope to enable price sync.",
    );
  }
  if (summary.systemic) {
    parts.push(
      `SYSTEMIC: ${systemicError ?? "a systemic condition"}; the run held and nothing was quarantined. The next tick retries.`,
    );
  } else if (summary.failed > 0) {
    parts.push(`${summary.failed} command(s) failed`);
  }
  if (summary.quarantined.length > 0) {
    parts.push(
      `${summary.quarantined.length} offer(s) quarantined after repeated failures and skipped by the loop: ${summary.quarantined.join(", ")}`,
    );
  }
  if (summary.conflicted > 0) {
    parts.push(
      `${summary.conflicted} offer(s) held out because their mapping carries a conflict; resolve them in the Allegro admin`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
};

/**
 * Count one offer against its bounds, for monitor mode.
 *
 * The whole output of a monitor run: how many offers are priced below the floor
 * they may not go under, and how many above the ceiling they may not exceed.
 * That is the report an operator reads before arming a mode that writes.
 */
const countAgainstBounds = (
  summary: PriceSyncSummary,
  offer: AllegroOffer,
  bounds: { floor: number; ceiling: number },
): void => {
  summary.monitored += 1;
  const observed = parseAmount(offer.sellingMode?.price?.amount ?? null);
  if (observed === undefined) {
    return;
  }
  if (observed < bounds.floor) {
    summary.belowFloor += 1;
  } else if (observed > bounds.ceiling) {
    summary.aboveCeiling += 1;
  }
};

/**
 * Run one price-sync tick, in whichever pricing mode is in force.
 *
 * `listing` may be supplied by a caller that already fetched the catalogue.
 *
 * The mode is resolved BEFORE the claim, because it decides whether this run has
 * a kill switch at all. In `monitor` the loop cannot write - there is no command
 * path to reach - so it runs regardless of the price-write toggle, exactly like
 * the read-only price-automation monitor already does. In the two writing modes
 * the toggle governs as it always has, and is re-read before every single
 * command.
 */
export const syncAllegroPrices = async (
  container: MedusaContainer,
  listing?: OfferListing,
): Promise<PriceSyncSummary> => {
  const allegroService = container.resolve<AllegroModuleService>(ALLEGRO_MODULE);
  const modeAtStart = await allegroService.getPricingMode();
  const summary = emptyPriceSyncSummary(modeAtStart);

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.PRICES,
    async ({ allegro, client, logger, mayContinue, state }) => {
      const options = await allegro.getSyncOptions();
      const mode = options.pricingMode;
      summary.mode = mode;
      const priorFailures = readFailureState(state.failures);
      const priorScopeMissing = state.write_scope_missing;
      summary.writeScopeMissing = priorScopeMissing;

      if (modeWrites(mode) && !modeWrites(modeAtStart)) {
        // The mode was changed between selecting this run's guard and taking the
        // claim. This run was started WITHOUT the price-write kill switch, because
        // monitor mode has nothing to switch off, so letting it write now would
        // write past a disarmed toggle. The next tick picks the new mode up with
        // the right guard attached.
        const message = `the pricing mode changed to \`${mode}\` while this run was starting, so it held rather than writing without its kill switch. The next run picks up the new mode.`;
        summary.error = message;
        return {
          outcome: { counts: toCounts(summary), lastError: message, status: "error" as const },
          value: undefined,
        };
      }

      if (modeNeedsAutomationRules(mode) && !options.automationRules) {
        // Inert by construction rather than by accident, and loudly so. Without two
        // rule names there is nothing to attach, and inventing one would attach the
        // wrong pricing policy to a live catalogue.
        const message =
          "the pricing mode is `automation_rule` but no two distinct rule names are configured, so no rule can be attached and nothing was written. Set the two rule names that exist on the Allegro account, or choose a different pricing mode.";
        summary.error = message;
        return {
          outcome: { counts: toCounts(summary), lastError: message, status: "error" as const },
          value: undefined,
        };
      }

      const rows = (await allegro.listAllegroOffers({})) as unknown as OfferRow[];
      const inputs = await resolvePlanningInputs(
        container,
        allegro,
        client,
        logger,
        options,
        modeNeedsAutomationRules(mode) ? options.automationRules : undefined,
        rows.map((row) => row.sku),
      );
      if (!inputs.ok) {
        summary.error = inputs.error;
        return {
          outcome: { counts: toCounts(summary), lastError: inputs.error, status: "error" as const },
          value: undefined,
        };
      }

      const offers = listing ?? (await listAllOffers(client));
      const offersById = new Map(offers.offers.map((offer) => [offer.id, offer]));
      const quarantinedNow = new Set(Object.keys(priorFailures.quarantined));

      const plans: OfferPlan[] = [];
      for (const row of rows) {
        if (row.conflict) {
          // A conflicted mapping is held out of every write path. Discovery already
          // cleared its `offer_id`, so this is belt and braces - and it is what the
          // admin count is built from.
          summary.conflicted += 1;
          continue;
        }
        if (!row.offer_id) {
          summary.skippedCounts["not-linked"] += 1;
          continue;
        }
        const offer = offersById.get(row.offer_id);
        if (!offer) {
          // Linked but absent from this listing. Not counted as a skip reason: the
          // link may simply be stale, and discovery's unlink pass owns that call.
          continue;
        }
        summary.scanned += 1;

        if (mode === "monitor") {
          // The same eligibility ladder the writing modes use, so a monitor run
          // reports exactly the skip reasons an armed run would hit. Nothing is
          // planned and nothing is quarantined: there is no command to fail.
          const resolved = await resolveOfferBounds(row, offer, inputs.inputs);
          if ("skip" in resolved) {
            summary.skippedCounts[resolved.skip] += 1;
            continue;
          }
          countAgainstBounds(summary, offer, resolved.bounds);
          continue;
        }

        const outcome = await planForMode(mode, row, offer, inputs.inputs);
        if ("skip" in outcome) {
          summary.skippedCounts[outcome.skip] += 1;
          continue;
        }
        if ("noop" in outcome) {
          summary.alreadyInSync += 1;
          continue;
        }
        // Quarantined offers are held out of the candidate list entirely rather than
        // attempted and failed: the point of quarantine is that they stop consuming
        // the run's budget.
        if (quarantinedNow.has(outcome.plan.offerId)) {
          continue;
        }
        plans.push(outcome.plan);
      }

      if (mode === "monitor") {
        // Settled here, before any of the write machinery below. A monitor run has
        // no commands, so it has no failures to quarantine, no scope to observe and
        // nothing to stamp - and running that machinery over an empty batch would
        // report a clean write run that never happened.
        logger.info(
          `[allegro-prices] monitor mode: ${summary.monitored} offer(s) priced, ${summary.belowFloor} below the break-even floor, ${summary.aboveCeiling} above the SRP ceiling. Nothing was sent to Allegro.`,
        );
        return {
          outcome: {
            counts: toCounts(summary),
            lastError: null,
            status: "ok" as const,
          },
          value: undefined,
        };
      }

      if (plans.length > options.changeCap) {
        summary.capped = true;
        logger.warn(
          `[allegro-prices] change cap (${options.changeCap}) hit; ${plans.length - options.changeCap} offer(s) wait for the next tick.`,
        );
      }
      const batch = plans.slice(0, options.changeCap);

      const succeeded = new Set<string>();
      const failed = new Map<string, string>();
      let systemic = false;
      let stoppedEarly = false;
      let systemicError: string | undefined;
      let scopeObserved: "present" | "missing" | "unknown" = "unknown";

      for (const plan of batch) {
        // Before each command, not just at the start of the run, and checking BOTH the claim
        // and the kill switch. A full-catalogue push is minutes of sequential commands, each
        // with its own 15s poll: the claim has to be re-asserted as the run proceeds, and the
        // switch has to be re-read because stopping a runaway mid-flight is the entire reason
        // it exists. Checking only the claim meant an operator who flipped the switch was
        // ignored until the run finished pushing everything.
        if (!(await mayContinue())) {
          stoppedEarly = true;
          systemic = true;
          systemicError =
            "the run was stopped mid-flight (the sync claim was taken over, or the kill switch was flipped), so the remaining commands were abandoned";
          break;
        }
        // Sequential on purpose: it keeps Allegro and database load flat, and the
        // circuit breaker has to stop on the FIRST systemic signal rather than
        // discovering it after a fan-out has already fired every command.
        const outcome = await runPlan(allegro, client, plan, "price-sync", options.marketplaceId);
        if (outcome.kind === "systemic") {
          systemic = true;
          systemicError = outcome.error;
          scopeObserved = outcome.scope ? "missing" : scopeObserved;
          break;
        }
        // Reaching a non-403 response proves the write scope is present.
        scopeObserved = "present";
        if (outcome.kind === "success") {
          summary.synced += 1;
          succeeded.add(plan.offerId);
        } else if (outcome.kind === "pending") {
          summary.pending += 1;
        } else {
          summary.failed += 1;
          failed.set(plan.offerId, outcome.error);
        }
      }

      // Every attempt failed and none succeeded: read as an outage rather than as a
      // set of bad offers. `pending` counts as neither, so a run of slow commands
      // does not look like an outage.
      if (!systemic && summary.pending === 0 && isSystemicFailure({ failed, succeeded })) {
        systemic = true;
        systemicError = `all ${failed.size} command(s) failed this run`;
      }
      summary.systemic = systemic;

      const { failures, quarantined } = updateFailureState(priorFailures, {
        failed,
        succeeded,
        systemic,
      });
      summary.quarantined = quarantined;

      // A 403 sets the flag, any non-403 command response clears it, and a run that
      // issued no command at all leaves it exactly as it was.
      let writeScopeMissing = priorScopeMissing;
      if (scopeObserved === "missing") {
        writeScopeMissing = true;
      } else if (scopeObserved === "present") {
        writeScopeMissing = false;
      }
      summary.writeScopeMissing = writeScopeMissing;

      const errorLine = buildPriceSyncError(summary, systemicError);
      summary.error = errorLine ?? undefined;
      // Skipped when the run was stopped mid-flight. If the claim was taken over, this row
      // belongs to the successor and stamping `price_synced_at` from here would be writing
      // over it; if the kill switch was flipped, the operator asked for no further writes.
      // Either way the offers that DID land are re-derived as already-in-sync next run from
      // the audit, so nothing is lost by not stamping.
      if (stoppedEarly) {
        logger.warn(
          `[allegro-prices] not stamping price_synced_at for ${succeeded.size} confirmed offer(s): the run was stopped mid-flight and must make no further writes.`,
        );
      } else {
        await stampSyncedOffers(allegro, batch, succeeded);
      }

      return {
        outcome: {
          counts: toCounts(summary),
          failures: isEmptyFailureState(failures) ? null : failures,
          lastError: errorLine,
          status: errorLine ? ("error" as const) : ("ok" as const),
          writeScopeMissing,
        },
        value: undefined,
      };
    },
    modeWrites(modeAtStart)
      ? {
          disabled: (allegro) => allegro.isPriceSyncDisabled(),
          reason:
            "price sync is disabled (the `priceSyncDisabled` option, or ALLEGRO_PRICE_SYNC_DISABLED). No price-affecting write was sent to Allegro.",
        }
      : undefined,
  );

  if (!run.ran) {
    summary.skipped = run.skip.reason;
  }
  return summary;
};

/** Stamp `price_synced_at` on the offers whose command Allegro confirmed. */
const stampSyncedOffers = async (
  allegro: AllegroModuleService,
  batch: readonly OfferPlan[],
  succeeded: ReadonlySet<string>,
): Promise<void> => {
  const updates = batch
    .filter((plan) => succeeded.has(plan.offerId))
    .map((plan) => ({ id: plan.rowId, last_error: null, price_synced_at: new Date() }));
  if (updates.length === 0) {
    return;
  }
  await allegro.updateAllegroOffers(updates as never);
};

/** The summary as a plain record, for the state row's `counts`. */
const toCounts = (summary: PriceSyncSummary): Record<string, unknown> => ({
  ...summary,
  skippedCounts: { ...summary.skippedCounts },
});

/**
 * What a successful manual push did, in the operator's terms.
 *
 * Mode-specific because the two writes are genuinely different acts: one hands
 * the offer to Allegro's engine between two bounds, the other sets an exact
 * price. Reporting "attached <rule>" after a fixed-price push would name a rule
 * that was in fact REMOVED.
 */
const describePushSuccess = (plan: OfferPlan): string => {
  if (plan.price === undefined) {
    return `Attached "${plan.expectedRule}" with bounds ${formatAmount(plan.floor)}-${formatAmount(plan.ceiling)} ${plan.currency}.`;
  }
  const removed =
    plan.kind === "detach-and-price"
      ? ` The price-automation rule${plan.observedRuleName ? ` "${plan.observedRuleName}"` : ""} was removed first, so it cannot recalculate over it.`
      : "";
  return `Set the price to ${formatAmount(plan.price)} ${plan.currency}, inside the ${formatAmount(plan.floor)}-${formatAmount(plan.ceiling)} ${plan.currency} bounds.${removed}`;
};

export interface SingleOfferPushResult {
  ok: boolean;
  /** What happened, so the admin can phrase it without parsing the message. */
  status: "synced" | "noop" | "skipped" | "pending" | "error" | "rate-limited";
  message: string;
}

/**
 * The rolling window the manual-push blast radius is measured over.
 *
 * One hour, matched to the hourly scheduled pass, so the two paths respect the same budget
 * over the same period.
 */
export const MANUAL_PUSH_WINDOW_MS = 60 * 60_000;

/**
 * `pushed_by` values that are this plugin's own loops rather than a human.
 *
 * The manual-push cap counts everything that is NOT one of these, so a new automated
 * writer must be added here or it will consume an operator's budget.
 */
export const AUTOMATED_PUSH_SOURCES = ["price-sync", "price-automation-monitor"];

/**
 * How many manual pushes have landed in the rolling window.
 *
 * `take` is the cap itself: the only question is whether the budget is already spent, so
 * reading one page bounded by the cap answers it without scanning the audit.
 */
const countRecentManualPushes = async (
  allegro: AllegroModuleService,
  cap: number,
): Promise<number> => {
  const rows = (await allegro.listAllegroPricePushes(
    {
      pushed_at: { $gte: new Date(Date.now() - MANUAL_PUSH_WINDOW_MS) },
      pushed_by: { $nin: AUTOMATED_PUSH_SOURCES },
    },
    { take: cap },
  )) as unknown as unknown[];
  return rows.length;
};

/**
 * Push one offer, on an explicit operator action.
 *
 * An override, so it ignores the PER-OFFER opt-out - the operator asked for this
 * specific offer - but it still respects the global kill switch, the eligibility
 * data checks, and the fail-loud rule resolution. It takes the same claim the loop
 * does, so it can never interleave with a concurrent tick on the same offer.
 *
 * A SUCCESSFUL manual push is also the quarantine remedy: it clears the offer from
 * both failure maps, so the loop resumes correcting it automatically from the next
 * tick instead of the operator having to repair it twice.
 *
 * ## The blast-radius cap
 *
 * Each call takes the claim, so calls serialise - but serialising is not bounding. Nothing
 * stopped an operator, or far more likely a script, from looping over this route and
 * repricing the entire catalogue: `changeCap` bounds the SCHEDULED loop to a number of
 * commands per run precisely so a bad plan cannot reprice everything before a human sees it,
 * and a loop over single-SKU calls walked straight around that. So manual pushes share the
 * same budget, counted over a rolling hour against `changeCap`, and a caller above it is
 * refused with `rate-limited` rather than served.
 *
 * The count comes from the audit table's `pushed_by`, which already distinguishes a human
 * from the loop, so the cap needs no new state and survives a restart.
 */
export const pushSingleAllegroOffer = async (
  container: MedusaContainer,
  sku: string,
  pushedBy: string,
): Promise<SingleOfferPushResult> => {
  let result: SingleOfferPushResult = {
    message: "the push did not complete",
    ok: false,
    status: "error",
  };

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.PRICES,
    async ({ allegro, client, logger, state }) => {
      const options = await allegro.getSyncOptions();
      const priorFailures = readFailureState(state.failures);
      const priorScopeMissing = state.write_scope_missing;

      /**
       * The provider-wide health line that must SURVIVE a single-offer action.
       *
       * Recomputed rather than nulled, so one per-offer action never wipes the quarantine
       * signal for every OTHER offer off the admin. It also carries the write-scope banner,
       * because that flag is provider-wide too: a manual push for one SKU that left the flag
       * set while erasing its explanatory line produced a raised banner with no text next to
       * it.
       */
      const standingLine = (scopeMissing: boolean): string | null => {
        const parts: string[] = [];
        if (scopeMissing) {
          parts.push(
            "WRITE_SCOPE_MISSING: the stored Allegro token cannot write offers. Reconnect Allegro with the offer write scope to enable price sync.",
          );
        }
        const quarantine = standingHealthLine(priorFailures, "offer");
        if (quarantine) {
          parts.push(quarantine);
        }
        return parts.length > 0 ? parts.join("; ") : null;
      };

      const settle = (
        outcome: SingleOfferPushResult,
        over: {
          failures?: FailureState | null;
          writeScopeMissing?: boolean;
          lastError?: string | null;
        } = {},
      ) => {
        result = outcome;
        const scopeMissing = over.writeScopeMissing ?? priorScopeMissing;
        const standing = standingLine(scopeMissing);
        // A FAILED action may never settle the provider row as `ok`. It used to: the failed
        // -command and no-mapping exits passed no `lastError`, so the row fell back to the
        // standing line - null on a healthy provider - and was written `status: "ok"`,
        // `last_error: null`, `last_synced_at: now`. That clobbered any standing SYSTEMIC or
        // WRITE_SCOPE line the scheduled loop had recorded, so a broken provider read as
        // freshly healthy because an operator's push had just failed against it.
        const failureLine = outcome.ok
          ? null
          : `the manual push for "${sku}" failed: ${outcome.message}`;
        // An explicit line wins VERBATIM. Callers that pass one have already composed the
        // right answer - the success path in particular recomputes it from the POST-clear
        // failures, so appending the pre-clear standing line here would re-report the very
        // offer that was just repaired. The composition below is only for the exits that
        // pass no line of their own, which is exactly where the `ok` downgrade used to
        // happen.
        const explicit = over.lastError;
        const lastError =
          explicit === undefined
            ? [failureLine, standing].filter(Boolean).join("; ") || null
            : explicit;
        return {
          outcome: {
            ...(over.failures === undefined ? {} : { failures: over.failures }),
            ...(over.writeScopeMissing === undefined
              ? {}
              : { writeScopeMissing: over.writeScopeMissing }),
            lastError,
            status: lastError ? ("error" as const) : ("ok" as const),
          },
          value: undefined,
        };
      };

      // Monitor mode has no write path at all, so an explicit push is refused
      // rather than quietly performed: an operator who chose "write nothing" must
      // not be able to write one offer by pressing a button on a product page.
      if (!modeWrites(options.pricingMode)) {
        return settle(
          {
            message:
              "The pricing mode is `monitor`, which never writes to Allegro. Choose a pricing mode that writes in Settings > Allegro before pushing an offer.",
            ok: false,
            status: "skipped",
          },
          { lastError: standingLine(priorScopeMissing) },
        );
      }

      if (modeNeedsAutomationRules(options.pricingMode) && !options.automationRules) {
        return settle(
          {
            message:
              "The pricing mode is `automation_rule` but no two distinct rule names are configured, so there is no rule to attach.",
            ok: false,
            status: "error",
          },
          { lastError: "no automation rule names are configured" },
        );
      }

      // Checked BEFORE any planning or Allegro read, so a script hammering this route is
      // refused as cheaply as possible rather than being allowed to burn the rate limit on
      // work that will not be used.
      const recentManual = await countRecentManualPushes(allegro, options.changeCap);
      if (recentManual >= options.changeCap) {
        return settle(
          {
            message: `Refused: ${recentManual} manual push(es) have already been made in the last hour, which is the \`changeCap\` budget (${options.changeCap}). Manual pushes share the scheduled loop's blast radius on purpose, so a script cannot reprice more of the catalogue than one run is allowed to. Wait for the window to roll, or raise \`changeCap\` deliberately.`,
            ok: false,
            status: "rate-limited",
          },
          // Explicitly the STANDING line, not a failure line. Nothing is wrong with the
          // provider - the caller was simply over budget - so this must neither invent a
          // provider error nor erase whatever the scheduled loop last reported.
          { lastError: standingLine(priorScopeMissing) },
        );
      }

      const [row] = (await allegro.listAllegroOffers(
        { sku },
        { take: 1 },
      )) as unknown as OfferRow[];
      if (!row) {
        return settle({
          message: `No Allegro mapping exists for SKU "${sku}".`,
          ok: false,
          status: "error",
        });
      }
      if (row.conflict) {
        return settle({
          message: `The mapping for "${sku}" carries an unresolved conflict (${row.conflict}), so nothing was pushed. Resolve it first.`,
          ok: false,
          status: "skipped",
        });
      }
      if (!row.offer_id) {
        return settle({
          message: `SKU "${sku}" is not linked to an Allegro offer.`,
          ok: false,
          status: "skipped",
        });
      }

      const inputs = await resolvePlanningInputs(
        container,
        allegro,
        client,
        logger,
        options,
        modeNeedsAutomationRules(options.pricingMode) ? options.automationRules : undefined,
        [sku],
      );
      if (!inputs.ok) {
        return settle(
          { message: inputs.error, ok: false, status: "error" },
          { lastError: inputs.error },
        );
      }

      const offer = await client.getOffer(row.offer_id);
      const planned = await planForMode(options.pricingMode, row, offer, inputs.inputs, {
        ignoreDisabled: true,
      });
      if ("skip" in planned) {
        return settle({
          message: `Skipped: ${SYNC_SKIP_LABEL[planned.skip]}.`,
          ok: true,
          status: "skipped",
        });
      }
      if ("noop" in planned) {
        return settle({
          message: "Already on the correct rule with the correct bounds. Nothing to push.",
          ok: true,
          status: "noop",
        });
      }

      const outcome = await runPlan(
        allegro,
        client,
        planned.plan,
        pushedBy,
        options.marketplaceId,
      );
      if (outcome.kind === "systemic") {
        return settle(
          {
            message: outcome.scope
              ? "Allegro rejected the write (403). Reconnect Allegro with the offer write scope to enable price sync."
              : `Systemic failure: ${outcome.error}. Try again shortly.`,
            ok: false,
            status: "error",
          },
          {
            lastError: outcome.scope
              ? "WRITE_SCOPE_MISSING: reconnect Allegro with the offer write scope to enable price sync."
              : `SYSTEMIC: ${outcome.error}`,
            writeScopeMissing: outcome.scope,
          },
        );
      }

      if (outcome.kind === "success") {
        // The remedy path: a repaired offer stops being quarantined AND does not
        // resume a stale streak, so the loop takes it back over next tick.
        const { cleared, failures } = clearFailureKey(priorFailures, planned.plan.offerId);
        // Recomputed from the POST-clear failures, so this offer stops being reported while
        // every other quarantined offer stays on the line. A successful command also proves
        // the write scope is present, so the banner text is dropped with the flag.
        const line = standingHealthLine(failures, "offer");
        await allegro.updateAllegroOffers([
          { id: row.id, last_error: null, price_synced_at: new Date() },
        ] as never);
        return settle(
          {
            message: describePushSuccess(planned.plan),
            ok: true,
            status: "synced",
          },
          {
            ...(cleared ? { failures: isEmptyFailureState(failures) ? null : failures } : {}),
            lastError: line,
            writeScopeMissing: false,
          },
        );
      }

      if (outcome.kind === "pending") {
        return settle(
          {
            message: "Command submitted; Allegro is still processing it. It will finalize shortly.",
            ok: true,
            status: "pending",
          },
          { writeScopeMissing: false },
        );
      }

      return settle(
        { message: `Push failed: ${outcome.error}`, ok: false, status: "error" },
        { writeScopeMissing: false },
      );
    },
    {
      disabled: (allegro) => allegro.isPriceSyncDisabled(),
      reason:
        "price sync is disabled (the `priceSyncDisabled` option, or ALLEGRO_PRICE_SYNC_DISABLED).",
    },
  );

  if (!run.ran) {
    return { message: run.skip.reason, ok: false, status: "error" };
  }
  return result;
};

const syncAllegroPricesStep = createStep(
  "sync-allegro-prices",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await syncAllegroPrices(container)),
);

/**
 * Price sync as a workflow, for the admin "run now" action.
 *
 * Deliberately NOT compensated. Every command it issues is an idempotent
 * re-assertion of a rule and a range, and "undoing" a price push would mean
 * restoring a range Allegro will not tell us. The audit row IS the record, and
 * the correction for a bad push is another push.
 */
export const syncAllegroPricesWorkflow = createWorkflow(
  "sync-allegro-prices",
  () => new WorkflowResponse(syncAllegroPricesStep()),
);
