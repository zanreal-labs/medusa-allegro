import type { MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { AllegroClient } from "../lib/allegro/client";
import { AllegroApiError } from "../lib/allegro/errors";
import type { AllegroOffer } from "../lib/allegro/types";
import {
  computeDrift,
  isTransition,
  promotionStateLabel,
  resolvePriceMode,
} from "../lib/sync/price-automation";
import type { AutomationRuleNames, OfferStatus, PriceMode } from "../lib/sync/price-automation";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import type AllegroModuleService from "../modules/allegro/service";
import { isFeatureUnavailable, listAllOffers } from "./lib/offers";
import type { OfferListing } from "./lib/offers";
import { runUnderSyncClaim } from "./lib/run";

/**
 * The read-only price-automation monitor.
 *
 * Observes what each linked offer's pricing actually looks like on Allegro and
 * records it: `price_mode`, the attached rule's id and resolved name, when it was
 * observed, and whether it drifts from what the configured rules say it should be.
 * It writes NOTHING to Allegro.
 *
 * Running this before - and alongside - the write loop is the point. Drift is how
 * a promotion flip becomes visible, and seeing a catalogue's drift for a while
 * before anything is allowed to act on it is what makes arming the write loop a
 * decision rather than a leap. The monitor stays useful afterwards: it is the only
 * thing that records a rule being changed OUTSIDE this plugin.
 *
 * ## Why transitions, not sweeps, produce audit rows
 *
 * `allegro_price_push` is append-only and it is the only record of what bounds
 * were ever pushed, so it has to stay readable. A row per offer per sweep would
 * bury the handful of rows that matter under thousands that say "still the same",
 * and an hourly sweep over a 5,000-offer catalogue would add 120,000 rows a day.
 * So a row is appended only when the observed state actually MOVED against what
 * was stored, and a first observation is a baseline rather than a transition (see
 * `isTransition`).
 *
 * ## Systemic failure aborts the sweep rather than recording per-offer failures
 *
 * A 429 or a 5xx on the rules read means the whole observation is unreliable, not
 * that these offers have no rules. The sweep aborts with zero writes and the state
 * is simply not refreshed until the next run - `automation_synced_at` going stale
 * is the honest signal, where writing "no rule attached" across the catalogue
 * would be an actively false one that the write loop would then act on.
 */

const RULES_PATH = "GET /sale/price-automation/rules";

export interface PriceAutomationMonitorResult {
  /** Set when the run did nothing. */
  skipped?: string;
  /** The rules resource answered "Feature unavailable"; the sweep was skipped. */
  featureUnavailable: boolean;
  /** A 429/5xx aborted the sweep; nothing was written this run. */
  systemic: boolean;
  /** Linked offers observed this run. */
  scanned: number;
  /** Observed offers currently in drift. */
  drift: number;
  /** `observed` rows appended to the audit for a real transition. */
  transitions: number;
  /** Mapping rows whose automation columns changed. */
  updated: number;
  /** Per-row write failures. */
  failed: number;
  /** Linked offers absent from this run's listing, so left untouched. */
  notObserved: number;
  /** No `automationRules` option, so drift cannot be judged. */
  rulesNotConfigured: boolean;
  /**
   * Observed offers whose promotion state is unresolved, so drift could not be judged
   * for them either.
   *
   * Counted rather than folded into "no drift": promotion state selects the expected
   * rule, so without it the monitor has no expectation to compare against. A sweep that
   * reported `drift: 0` while half the catalogue was unresolved would read as a clean
   * catalogue, which is exactly the reassurance an operator must not be given.
   */
  promotionUnresolved: number;
  error?: string;
}

export const emptyPriceAutomationMonitorResult = (): PriceAutomationMonitorResult => ({
  drift: 0,
  failed: 0,
  featureUnavailable: false,
  notObserved: 0,
  promotionUnresolved: 0,
  rulesNotConfigured: false,
  scanned: 0,
  systemic: false,
  transitions: 0,
  updated: 0,
});

/** A mapping row, as the monitor reads and writes it. */
interface OfferRow {
  id: string;
  sku: string;
  offer_id?: string | null;
  /** Three-state: true / false / NULL-or-absent meaning "not resolved". */
  promoted?: boolean | null;
  price_mode?: PriceMode | null;
  automation_rule?: string | null;
  automation_rule_id?: string | null;
  automation_synced_at?: Date | null;
  price_automation_drift?: boolean | null;
  conflict?: string | null;
}

type RuleNamesResolution =
  | { ok: true; byId: Map<string, string> }
  | { ok: false; systemic: boolean; featureUnavailable: boolean; error?: string };

/**
 * The account's rule id -> name map.
 *
 * Needed because the per-offer read carries only the rule ID: Allegro removed the
 * rule type from several read resources in July 2025, so the rules list is the
 * only authoritative source of a rule's name - and the name is what drift is
 * judged on.
 */
export const fetchRuleNames = async (client: AllegroClient): Promise<RuleNamesResolution> => {
  try {
    const { rules } = await client.listPriceAutomationRules();
    const byId = new Map<string, string>();
    for (const rule of rules ?? []) {
      if (rule.id && rule.name) {
        byId.set(rule.id, rule.name);
      }
    }
    return { byId, ok: true };
  } catch (error) {
    if (!(error instanceof AllegroApiError)) {
      throw error;
    }
    if (error.isSystemic()) {
      return {
        error: `${RULES_PATH}: ${error.message}`,
        featureUnavailable: false,
        ok: false,
        systemic: true,
      };
    }
    if (isFeatureUnavailable(error)) {
      return { featureUnavailable: true, ok: false, systemic: false };
    }
    return {
      error: `${RULES_PATH}: ${error.message}`,
      featureUnavailable: false,
      ok: false,
      systemic: false,
    };
  }
};

/** The automation state a mapping row would take on, given the observed offer. */
interface ObservedState {
  priceMode: PriceMode;
  ruleId?: string;
  ruleName?: string;
  drift: boolean;
  /** True when drift could not be judged because promotion state is unresolved. */
  promotionUnresolved: boolean;
}

const observe = (
  offer: AllegroOffer,
  row: OfferRow,
  ruleNames: Map<string, string>,
  rules: AutomationRuleNames | undefined,
): ObservedState => {
  const attachedRuleId = offer.sellingMode?.priceAutomation?.rule?.id;
  const priceMode = resolvePriceMode({
    attachedRuleId,
    observed: true,
    status: offer.publication?.status as OfferStatus | undefined,
  });
  const ruleName = attachedRuleId ? ruleNames.get(attachedRuleId) : undefined;
  // Promotion state selects which rule is EXPECTED, so an unresolved one makes drift
  // unjudgeable rather than false. `row.promoted ?? false` was the silent-default bug
  // the nullable column exists to prevent: a genuinely promoted offer correctly sitting
  // on the promoted rule would be compared against the STANDARD rule name and reported
  // as drifting, and an operator chasing that finds nothing wrong.
  const promoted = row.promoted ?? undefined;
  const promotionUnresolved = promoted === undefined;
  return {
    // With no rules configured there is no expectation to drift FROM, and with no
    // resolved promotion state there is no way to say WHICH rule is expected. Both are
    // reported as "no drift" rather than guessed, and the unresolved case is counted so
    // it does not read as a clean sweep. The mode and the rule name are still recorded -
    // observing the catalogue is useful before the rules are chosen.
    drift:
      rules && !promotionUnresolved
        ? computeDrift({
            attachedRuleName: ruleName,
            priceMode,
            promoted: promoted as boolean,
            rules,
          })
        : false,
    priceMode,
    promotionUnresolved,
    ruleId: attachedRuleId,
    ruleName,
  };
};

/** True when the stored columns already match the freshly observed state. */
const isUnchanged = (row: OfferRow, next: ObservedState): boolean =>
  (row.price_mode ?? "unknown") === next.priceMode &&
  (row.automation_rule_id ?? undefined) === next.ruleId &&
  (row.automation_rule ?? undefined) === next.ruleName &&
  (row.price_automation_drift ?? false) === next.drift &&
  // A row that has never been observed must be written even when every other
  // column coincidentally matches, so `automation_synced_at` stops reading as
  // "never looked at".
  row.automation_synced_at !== null &&
  row.automation_synced_at !== undefined;

/** The append-only audit row for an observed rule transition. */
const transitionRow = (row: OfferRow, next: ObservedState): Record<string, unknown> => ({
  offer_id: row.offer_id ?? null,
  price_mode_new: next.priceMode,
  price_mode_old: row.price_mode ?? "unknown",
  promotion_state: promotionStateLabel(row.promoted),
  pushed_at: new Date(),
  pushed_by: "price-automation-monitor",
  // `observed`, not `success`: nothing was written to Allegro. The distinction is
  // what lets the bounds memory read only rows this plugin actually pushed.
  result: "observed",
  rule_id_new: next.ruleId ?? null,
  rule_id_old: row.automation_rule_id ?? null,
  rule_name_new: next.ruleName ?? null,
  rule_name_old: row.automation_rule ?? null,
  sku: row.sku,
});

/**
 * Run one monitor sweep.
 *
 * `listing` may be passed in by a caller that has already fetched the catalogue -
 * the scheduled job does exactly that, so discovery, the monitor and price sync
 * share one listing.
 */
export const runPriceAutomationMonitor = async (
  container: MedusaContainer,
  listing?: OfferListing,
): Promise<PriceAutomationMonitorResult> => {
  const result = emptyPriceAutomationMonitorResult();

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.PRICE_AUTOMATION,
    async ({ allegro, client }) => {
      const ruleNames = await fetchRuleNames(client);
      if (!ruleNames.ok) {
        result.featureUnavailable = ruleNames.featureUnavailable;
        result.systemic = ruleNames.systemic;
        result.error = ruleNames.error;
        // Zero writes. See the class comment: a stale `automation_synced_at` is an
        // honest signal, "no rule attached" across the catalogue is a false one.
        const message =
          ruleNames.error ??
          (ruleNames.featureUnavailable
            ? 'the price-automation rules resource answered "Feature unavailable"; automation state was not observed this run'
            : "price-automation rules could not be read");
        return {
          outcome: {
            counts: { ...result },
            lastError: message,
            status: "error" as const,
          },
          value: undefined,
        };
      }

      const options = await allegro.getSyncOptions();
      result.rulesNotConfigured = !options.automationRules;

      const offers = listing ?? (await listAllOffers(client));
      const offersById = new Map(offers.offers.map((offer) => [offer.id, offer]));
      const rows = (await allegro.listAllegroOffers({})) as unknown as OfferRow[];

      const auditRows: Record<string, unknown>[] = [];
      const updates: Record<string, unknown>[] = [];

      for (const row of rows) {
        if (!row.offer_id) {
          continue;
        }
        const offer = offersById.get(row.offer_id);
        if (!offer) {
          // Absent from this run's listing (vanished, or a transient read). Leave
          // the columns untouched: discovery's unlink pass owns clearing the link,
          // and it has the empty-response guard that makes that safe.
          result.notObserved += 1;
          continue;
        }
        result.scanned += 1;
        const next = observe(offer, row, ruleNames.byId, options.automationRules);
        if (next.drift) {
          result.drift += 1;
        }
        if (next.promotionUnresolved) {
          result.promotionUnresolved += 1;
        }

        if (
          isTransition(
            { priceMode: row.price_mode ?? "unknown", ruleId: row.automation_rule_id ?? undefined },
            { priceMode: next.priceMode, ruleId: next.ruleId },
          )
        ) {
          auditRows.push(transitionRow(row, next));
        }

        if (isUnchanged(row, next)) {
          continue;
        }
        updates.push({
          automation_rule: next.ruleName ?? null,
          automation_rule_id: next.ruleId ?? null,
          automation_synced_at: new Date(),
          id: row.id,
          price_automation_drift: next.drift,
          price_mode: next.priceMode,
        });
      }

      let firstError: string | undefined;
      if (updates.length > 0) {
        try {
          await allegro.updateAllegroOffers(updates as never);
          result.updated = updates.length;
        } catch (error) {
          result.failed += updates.length;
          firstError = `automation column update: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (auditRows.length > 0) {
        try {
          await allegro.createAllegroPricePushes(auditRows as never);
          result.transitions = auditRows.length;
        } catch (error) {
          result.failed += 1;
          firstError ??= `audit insert: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const errorLine = buildMonitorError(result, firstError);
      result.error = errorLine ?? undefined;
      return {
        outcome: {
          counts: { ...result },
          lastError: errorLine,
          status: errorLine ? ("error" as const) : ("ok" as const),
        },
        value: undefined,
      };
    },
    // No kill switch: the monitor writes nothing to Allegro, and it is the surface
    // an operator watches while the write loop is disabled.
  );

  if (!run.ran) {
    result.skipped = run.skip.reason;
  }
  return result;
};

const buildMonitorError = (
  result: PriceAutomationMonitorResult,
  firstError?: string,
): string | null => {
  const parts: string[] = [];
  if (firstError) {
    parts.push(firstError);
  }
  if (result.rulesNotConfigured) {
    parts.push(
      "the `automationRules` option is not configured, so drift cannot be judged and price sync stays inert. Set the two rule names that exist on the Allegro account",
    );
  }
  if (result.drift > 0) {
    // Drift is an error state even on a clean run: an offer priced by the wrong
    // rule is being sold on the wrong commission, and nothing else says so.
    parts.push(`${result.drift} offer(s) drift from the expected price-automation rule`);
  }
  if (result.promotionUnresolved > 0) {
    // Reported for the same reason drift is: these offers were NOT checked, so a
    // `drift: 0` sweep that silently skipped them would read as a clean catalogue.
    // Price sync skips them too, with `promotion-unresolved`, so the remedy is the same.
    parts.push(
      `${result.promotionUnresolved} offer(s) have an unresolved promotion state, so drift could not be judged and price sync skips them; a successful promo-options sweep fills it in`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
};

const runPriceAutomationMonitorStep = createStep(
  "run-price-automation-monitor",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await runPriceAutomationMonitor(container)),
);

/** The monitor as a workflow, for the admin "run now" action. */
export const runPriceAutomationMonitorWorkflow = createWorkflow(
  "run-price-automation-monitor",
  () => new WorkflowResponse(runPriceAutomationMonitorStep()),
);
