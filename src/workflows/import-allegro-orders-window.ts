import type { MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { describeError } from "../lib/allegro/errors";
import { readFailureState, standingHealthLine } from "../lib/sync/failure-state";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import { applyCheckoutForm } from "./lib/order-upsert";
import { runUnderSyncClaim } from "./lib/run";

/**
 * Import Allegro orders by `updatedAt` window, paging `GET /order/checkout-forms`.
 *
 * The disaster-recovery path, and the ONLY way to obtain an order the event journal
 * never named. The journal is the sole scheduled input and Allegro retains roughly
 * 60 days of events, so a drain disabled longer than that, a restored or fresh
 * database, or a lost cursor all leave orders otherwise unreachable. It is also
 * what "import history" is built on: the drain deliberately bootstraps its cursor
 * without consuming anything, so a new installation starts tracking from now and
 * bringing in the past is an explicit operator decision.
 *
 * Deliberately NOT scheduled. Reinstating a periodic `updatedAt` sweep is precisely
 * what the drain-only design removed, and for a concrete reason: Allegro does not
 * reliably bump a checkout form's `updatedAt` when only its fulfillment status
 * changed, so such a sweep cannot see the most common status change there is. It
 * would burn a request budget re-fetching unchanged forms while still missing the
 * thing it was reinstated to catch. Here the window is one an operator chooses,
 * bounded and explicit, rather than a cursor that drifts.
 */

export interface ImportOrdersWindowInput {
  /** ISO timestamp; forms updated at or after this are considered. */
  since: string;
  /** Optional upper bound, for importing one slice at a time. */
  until?: string;
  pageLimit?: number;
  maxPages?: number;
}

export interface ImportOrdersWindowResult {
  /** Set when the run did nothing. */
  skipped?: string;
  fetched: number;
  imported: number;
  created: number;
  failed: number;
  /** True when the page cap was hit; re-run with a later `since`. */
  truncated: boolean;
  /** Checkout-form ids that could not be applied, so an operator can chase them. */
  failedFormIds: string[];
  error?: string;
}

const DEFAULT_PAGE_LIMIT = 100;
/**
 * Pages per invocation. Bounds one run rather than the whole import: 30 pages of
 * 100 is 3,000 orders, and an operator importing more re-runs with a later `since`.
 * An unbounded loop here would hold the sync claim for as long as the import takes,
 * which blocks the per-minute drain from importing anything new in the meantime.
 */
const DEFAULT_MAX_PAGES = 30;

export const importAllegroOrdersWindow = async (
  container: MedusaContainer,
  input: ImportOrdersWindowInput,
): Promise<ImportOrdersWindowResult> => {
  const pageLimit = input.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  let result: ImportOrdersWindowResult = {
    created: 0,
    failed: 0,
    failedFormIds: [],
    fetched: 0,
    imported: 0,
    truncated: false,
  };

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.ORDERS,
    async ({ allegro, client, heartbeat, logger, state }) => {
      const options = await allegro.getSyncOptions();
      // The provider-wide quarantine line has to SURVIVE an import. The import composed its
      // error line from its own findings only, so a clean import wrote `last_error: null,
      // status: "ok"` over any standing quarantine the per-minute drain had recorded - and
      // the orders that had been set aside for manual repair silently vanished from the
      // admin. Recomputed here exactly as `repairAllegroOrder` does it.
      const standingLine = standingHealthLine(readFailureState(state.failures), "order");
      const failedFormIds: string[] = [];
      let fetched = 0;
      let imported = 0;
      let created = 0;
      let truncated = false;

      for (let page = 0; page < maxPages; page += 1) {
        // Offset pagination; each page depends on the previous.
        const { checkoutForms, totalCount } = await client.listCheckoutForms({
          limit: pageLimit,
          offset: page * pageLimit,
          sort: "updatedAt",
          "updatedAt.gte": input.since,
          ...(input.until ? { "updatedAt.lte": input.until } : {}),
        });
        const forms = checkoutForms ?? [];
        fetched += forms.length;

        for (const form of forms) {
          // Per form. An import walks up to 30 pages of 100 orders, each a multi-step write,
          // so without this the claim goes stale long before the import finishes and a
          // concurrent drain starts interleaving on the same orders.
          if (!(await heartbeat())) {
            truncated = true;
            break;
          }
          // Sequential: each form is a multi-step write, and a fan-out would put a
          // whole page of order creations in flight at once.
          try {
            const applied = await applyCheckoutForm(container, allegro, logger, options, form);
            imported += 1;
            if (applied.created) {
              created += 1;
            }
          } catch (error) {
            // Counted and NAMED, never aborting the import. One unapplyable order out
            // of three thousand must not stop the other 2,999, and an operator needs
            // the ids to chase what is left.
            failedFormIds.push(form.id);
            logger.error(
              `[allegro-orders-import] checkout form ${form.id} failed: ${describeError(error)}`,
            );
          }
        }

        if (forms.length < pageLimit || fetched >= totalCount) {
          break;
        }
        if (page === maxPages - 1) {
          truncated = true;
        }
      }

      const parts: string[] = [];
      if (failedFormIds.length > 0) {
        parts.push(
          `${failedFormIds.length} order(s) in the imported window could not be applied: ${failedFormIds.slice(0, 20).join(", ")}${failedFormIds.length > 20 ? ", ..." : ""}`,
        );
      }
      if (truncated) {
        parts.push(
          `the page cap (${maxPages} x ${pageLimit}) was hit; re-run the import with a later \`since\` to continue`,
        );
      }
      if (standingLine) {
        parts.push(standingLine);
      }
      const errorLine = parts.length > 0 ? parts.join("; ") : null;

      result = {
        created,
        error: errorLine ?? undefined,
        failed: failedFormIds.length,
        failedFormIds,
        fetched,
        imported,
        truncated,
      };
      return {
        outcome: {
          // The cursor is deliberately NOT touched. An import fills a gap behind the
          // cursor; moving it would skip live events the drain has not consumed yet.
          counts: { ...result, failedFormIds: [...failedFormIds] },
          lastError: errorLine,
          status: errorLine ? ("error" as const) : ("ok" as const),
        },
        value: undefined,
      };
    },
    // No kill switch: this is an explicit, bounded operator action, and an operator
    // who disabled the schedule to stop a runaway still needs the recovery path. The
    // switch stops the cron, not the human.
  );

  if (!run.ran) {
    return { ...result, skipped: run.skip.reason };
  }
  return result;
};

const importAllegroOrdersWindowStep = createStep(
  "import-allegro-orders-window",
  async (input: ImportOrdersWindowInput, { container }: { container: MedusaContainer }) =>
    new StepResponse(await importAllegroOrdersWindow(container, input)),
);

/**
 * The import window as a workflow, for the admin dialog.
 *
 * Deliberately NOT compensated: it creates orders that really were placed on
 * Allegro, and the repair for a bad import is fixing the order, not deleting it.
 */
export const importAllegroOrdersWindowWorkflow = createWorkflow(
  "import-allegro-orders-window",
  (input: ImportOrdersWindowInput) => new WorkflowResponse(importAllegroOrdersWindowStep(input)),
);
