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
import { AllegroApiError } from "../lib/allegro/errors";
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
import {
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
  resolveCommissionFraction,
  resolveSrp,
  resolveCostsService,
  warnOnMissingSrpSource,
} from "./lib/pricing";
import { runUnderSyncClaim } from "./lib/run";
import { warnOnUnscopedCatalogue } from "./lib/scope-warnings";

/**
 * The armed price-sync loop.
 *
 * Keeps every eligible linked ACTIVE offer on the rule its promotion state calls
 * for, attaching the rule where it is missing, switching it on a promotion flip,
 * and re-asserting the `[break-even, SRP]` bounds whenever they drift from the
 * last successfully pushed ones. Allegro does not expose an attached rule's price
 * range, so `allegro_price_push` is the only bounds memory there is (see
 * `fetchLastSuccessfulBounds` and `decideSyncAction`).
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
  /** Set when the run did nothing. */
  skipped?: string;
  /** Linked offers considered this run. */
  scanned: number;
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

export const emptyPriceSyncSummary = (): PriceSyncSummary => ({
  alreadyInSync: 0,
  capped: false,
  conflicted: 0,
  failed: 0,
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
  expectedRule: string;
  expectedRuleId: string;
  kind: "attach" | "switch" | "bounds";
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
 * Insert the audit row, issue the command, poll to terminal, finalize the row.
 *
 * The audit row goes in FIRST, before the command. A push this plugin cannot
 * record is not one it wants to make: the row is the only bounds memory, so a
 * command whose bounds went unrecorded would be re-pushed on every subsequent run
 * forever. That ordering also means an audit-insert failure is a per-offer failure
 * rather than systemic - it is local to one row, and a database blip must not hold
 * the whole run.
 */
const runCommand = async (
  allegro: AllegroModuleService,
  client: AllegroClient,
  plan: OfferPlan,
  pushedBy: string,
): Promise<CommandOutcome> => {
  let pushId: string;
  try {
    const [created] = (await allegro.createAllegroPricePushes([
      {
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
      },
    ] as never)) as unknown as { id: string }[];
    pushId = created.id;
  } catch (error) {
    return {
      error: `audit insert failed: ${error instanceof Error ? error.message : String(error)}`,
      kind: "failed",
    };
  }

  const finalize = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      await allegro.updateAllegroPricePushes([{ id: pushId, ...patch }] as never);
    } catch {
      // Swallowed deliberately: the command has already happened, and throwing here
      // would report a successful push as a failure and re-push it next run.
    }
  };

  try {
    const report = await client.assignOfferPriceAutomation({
      bounds: {
        max: { amount: formatAmount(plan.ceiling), currency: plan.currency },
        min: { amount: formatAmount(plan.floor), currency: plan.currency },
      },
      offerId: plan.offerId,
      ruleId: plan.expectedRuleId,
    });
    const terminal = await client.pollOfferPriceAutomationCommand(report.id);
    const tally = terminal.taskCount;

    // `AllegroClient.isCommandTerminal`, never a local re-derivation. The test this
    // replaces was `completedAt || taskCount.total > 0`, which is strictly WEAKER than
    // the poll loop's own exit condition: a command that has SCHEDULED one task and
    // finished none (total 1, success 0, failed 0) satisfies it. Such a report
    // arriving at the 15s poll budget therefore fell straight through to
    // `result: "success"` - which stamps `price_synced_at` and writes the bounds into
    // the only bounds memory this plugin has. `fetchLastSuccessfulBounds` then
    // reported bounds that may never have landed, `decideSyncAction` answered
    // `act: false` on every later run, and the offer was silently never corrected
    // again. The pending branch below was unreachable for exactly that shape.
    if (!AllegroClient.isCommandTerminal(terminal)) {
      // Submitted but not confirmed terminal within the poll budget. NOT a failure:
      // a slow command must not build a streak toward quarantining a healthy offer.
      // Settled as `skipped` - honest about what is known - and crucially NOT
      // `success`, so the row is invisible to the bounds memory and the next run
      // re-pushes, which is idempotent.
      await finalize({
        allegro_command_id: report.id,
        error: "not terminal within the poll budget",
        result: "skipped",
      });
      return { commandId: report.id, error: "command still pending", kind: "pending" };
    }
    if (tally && tally.failed > 0) {
      const detail = await describeCommandFailure(client, report.id);
      await finalize({ allegro_command_id: report.id, error: detail });
      return { error: detail, kind: "failed" };
    }
    // Success is asserted on POSITIVE evidence, never on the absence of a failure.
    // Two terminal reports carry no such evidence and both used to read as success:
    // one with `completedAt` set and no `taskCount` at all, and one whose tally
    // scheduled nothing (`total: 0`, i.e. the offer criteria matched no offer). The
    // first is unknown, so it settles as pending and the next run re-checks; the
    // second is a real failure worth surfacing, because a command that scheduled no
    // task did not attach anything.
    if (!tally) {
      await finalize({
        allegro_command_id: report.id,
        error: "command reported terminal without a task tally, so nothing is confirmed",
        result: "skipped",
      });
      return {
        commandId: report.id,
        error: "command terminal without a task tally",
        kind: "pending",
      };
    }
    if (tally.success < 1) {
      const detail = "command completed without scheduling a task for the offer";
      await finalize({ allegro_command_id: report.id, error: detail });
      return { error: detail, kind: "failed" };
    }
    await finalize({ allegro_command_id: report.id, error: null, result: "success" });
    return { commandId: report.id, kind: "success" };
  } catch (error) {
    if (error instanceof AllegroAuthError) {
      await finalize({ error: `auth: ${error.message}` });
      return { error: `auth error: ${error.message}`, kind: "systemic", scope: false };
    }
    if (error instanceof AllegroApiError) {
      if (error.isForbidden()) {
        await finalize({ error: `write scope missing (403): ${error.message}` });
        return { error: "write scope missing (403)", kind: "systemic", scope: true };
      }
      if (error.isSystemic()) {
        await finalize({ error: `systemic ${error.httpStatus}: ${error.message}` });
        return {
          error: `HTTP ${error.httpStatus}: ${error.message}`,
          kind: "systemic",
          scope: false,
        };
      }
      await finalize({ error: error.message });
      return { error: error.message, kind: "failed" };
    }
    const message = error instanceof Error ? error.message : String(error);
    await finalize({ error: message });
    return { error: message, kind: "failed" };
  }
};

/** Everything the planner needs, resolved once per run. */
interface PlanningInputs {
  ruleNames: Map<string, string>;
  expectedIds: { standardId: string; promotedId: string };
  rules: AutomationRuleNames;
  categoryRates: ReturnType<typeof buildCategoryRates>;
  breakEvenFor: (sku: string, commission: number | undefined) => Promise<number | undefined>;
  srp: SrpSource;
  lastBounds: Map<string, SyncBounds>;
}

/** Build a plan for one mapping row plus its live offer, or say why not. */
const planOffer = async (
  row: OfferRow,
  offer: AllegroOffer,
  inputs: PlanningInputs,
  opts: { ignoreDisabled?: boolean } = {},
): Promise<{ plan: OfferPlan } | { skip: SyncSkipReason } | { noop: true }> => {
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

  const observedRuleId = offer.sellingMode?.priceAutomation?.rule?.id;
  const observedRuleName = observedRuleId ? inputs.ruleNames.get(observedRuleId) : undefined;
  const decision = decideSyncAction({
    attachedRuleId: observedRuleId,
    attachedRuleName: observedRuleName,
    desiredBounds: { ceiling: eligibility.ceiling, floor: eligibility.floor },
    lastPushedBounds: inputs.lastBounds.get(offer.id),
    promoted: eligibility.promoted,
    rules: inputs.rules,
  });
  if (!decision.act) {
    return { noop: true };
  }

  return {
    plan: {
      ceiling: eligibility.ceiling,
      // The offer's own currency, as Allegro reported it. Allegro rejects a range
      // in any other currency, and defaulting to PLN would break a seller listing
      // on a non-PLN marketplace.
      currency,
      expectedRule: decision.expectedRule,
      expectedRuleId: eligibility.promoted
        ? inputs.expectedIds.promotedId
        : inputs.expectedIds.standardId,
      floor: eligibility.floor,
      kind: decision.kind,
      observedMode: resolvePriceMode({
        attachedRuleId: observedRuleId,
        observed: true,
        status: offer.publication?.status as OfferStatus | undefined,
      }),
      observedRuleId,
      observedRuleName,
      offerId: offer.id,
      promoted: eligibility.promoted,
      rowId: row.id,
      sku: row.sku,
    },
  };
};

/** Resolve everything a run plans against. */
const resolvePlanningInputs = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  client: AllegroClient,
  logger: Logger,
  options: AllegroSyncOptions,
  rules: AutomationRuleNames,
  skus: readonly string[],
): Promise<{ ok: true; inputs: PlanningInputs } | { ok: false; error: string }> => {
  const { rules: accountRules } = await client.listPriceAutomationRules();
  const expected = resolveExpectedRuleIds(accountRules ?? [], rules);
  if (!expected.ok) {
    // The fail-loud abort. Nothing is written: this plugin does not guess which rule
    // an operator meant, and it never creates or edits one.
    return { error: expected.error, ok: false };
  }

  const ruleNames = new Map<string, string>();
  for (const rule of accountRules ?? []) {
    if (rule.id && rule.name) {
      ruleNames.set(rule.id, rule.name);
    }
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
      expectedIds: { promotedId: expected.promotedId, standardId: expected.standardId },
      lastBounds,
      ruleNames,
      rules,
      srp: srpSource,
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
 * Run one price-sync tick.
 *
 * `listing` may be supplied by a caller that already fetched the catalogue.
 */
export const syncAllegroPrices = async (
  container: MedusaContainer,
  listing?: OfferListing,
): Promise<PriceSyncSummary> => {
  const summary = emptyPriceSyncSummary();

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.PRICES,
    async ({ allegro, client, heartbeat, logger, state }) => {
      const options = await allegro.getSyncOptions();
      const priorFailures = readFailureState(state.failures);
      const priorScopeMissing = state.write_scope_missing;
      summary.writeScopeMissing = priorScopeMissing;

      if (!options.automationRules) {
        // Inert by construction rather than by accident, and loudly so. Without two
        // rule names there is nothing to attach, and inventing one would attach the
        // wrong pricing policy to a live catalogue.
        const message =
          "the `automationRules` option is not configured, so no rule can be attached and nothing was written. Set the two rule names that exist on the Allegro account.";
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
        options.automationRules,
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
        const outcome = await planOffer(row, offer, inputs.inputs);
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
      let systemicError: string | undefined;
      let scopeObserved: "present" | "missing" | "unknown" = "unknown";

      for (const plan of batch) {
        // Before each command, not just at the start of the run. A full-catalogue push is
        // minutes of sequential commands, each with its own 15s poll, so the claim has to
        // be re-asserted as the run proceeds - and if it has been taken over, stopping HERE
        // is what prevents two runs issuing price commands for the same offers at once.
        if (!(await heartbeat())) {
          systemic = true;
          systemicError =
            "the sync claim was taken over mid-run, so the remaining commands were abandoned to avoid pushing concurrently with the run that replaced this one";
          break;
        }
        // Sequential on purpose: it keeps Allegro and database load flat, and the
        // circuit breaker has to stop on the FIRST systemic signal rather than
        // discovering it after a fan-out has already fired every command.
        const outcome = await runCommand(allegro, client, plan, "price-sync");
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
      await stampSyncedOffers(allegro, batch, succeeded);

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
    {
      disabled: (allegro) => allegro.isPriceSyncDisabled(),
      reason:
        "price sync is disabled (the `priceSyncDisabled` option, or ALLEGRO_PRICE_SYNC_DISABLED). No price-affecting write was sent to Allegro.",
    },
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

      if (!options.automationRules) {
        return settle(
          {
            message:
              "The `automationRules` plugin option is not configured, so there is no rule to attach.",
            ok: false,
            status: "error",
          },
          { lastError: "the `automationRules` option is not configured" },
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
        options.automationRules,
        [sku],
      );
      if (!inputs.ok) {
        return settle(
          { message: inputs.error, ok: false, status: "error" },
          { lastError: inputs.error },
        );
      }

      const offer = await client.getOffer(row.offer_id);
      const planned = await planOffer(row, offer, inputs.inputs, { ignoreDisabled: true });
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

      const outcome = await runCommand(allegro, client, planned.plan, pushedBy);
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
            message: `Attached "${planned.plan.expectedRule}" with bounds ${formatAmount(planned.plan.floor)}-${formatAmount(planned.plan.ceiling)} ${planned.plan.currency}.`,
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
