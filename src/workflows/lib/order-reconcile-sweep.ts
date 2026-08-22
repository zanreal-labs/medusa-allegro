import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import type { AllegroClient } from "../../lib/allegro/client";
import {
  advanceReconcileMarks,
  classifyReconcileTier,
  dueReconcileTiers,
  resolveReconcileCadence,
  selectReconcileBatch,
} from "../../lib/sync/order-reconcile";
import type {
  OrderPaymentState,
  ReconcileCadence,
  ReconcileMarks,
  ReconcileRow,
  ReconcileTier,
} from "../../lib/sync/order-reconcile";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type AllegroModuleService from "../../modules/allegro/service";
import { readOrderPaymentStates } from "./order-payment";
import { applyCheckoutForm } from "./order-upsert";

/**
 * The reconciliation sweep, as it runs.
 *
 * Re-reads every open Allegro order from Allegro and re-applies it. That is the
 * whole design: no separate repair logic, no second way to write an order. It calls
 * the same `applyCheckoutForm` the event drain calls, so anything the drain can fix
 * the sweep can fix, and a form that is already consistent writes nothing.
 *
 * That is also what makes it the backfill for the customer-name gap: `applyCheckoutForm`
 * fills an empty `first_name` / `last_name` / `company_name` on the order's customer on
 * every pass, so the customers created before it did heal the next time their order is
 * swept, with no separate migration and no manual patching.
 *
 * Runs inside the drain's claim, immediately after it, for the same reason the
 * invoice sweep does: it writes the rows the drain writes, so it must not run
 * concurrently with it. Sharing the claim rather than taking a second one is what
 * makes "two passes interleaving on one order" impossible rather than unlikely.
 */

/** How many bookkeeping rows one sweep looks at before classifying. */
const DEFAULT_SCAN_LIMIT = 500;

export interface ReconcileSweepResult {
  /** Tiers actually swept this run. */
  tiers: ReconcileTier[];
  /** Rows re-read from Allegro. */
  checked: number;
  /** Rows whose re-read changed something: a payment, a status, or a first order. */
  repaired: number;
  /** Payments recorded this sweep. Each one is an event the drain lost. */
  paymentsRegistered: number;
  /**
   * Customers given a name they were missing.
   *
   * Counted apart from `repaired`, and deliberately so. Every other repair this sweep
   * makes means an Allegro event was lost; a missing customer name means the order was
   * created before this plugin knew how to write one, so folding it in would report a
   * healthy event journal as broken for as long as the backfill runs.
   */
  customersNamed: number;
  /** Rows whose re-read threw. */
  failed: number;
  /** Marks to persist, so the slow tier's clock survives a restart. */
  marks: ReconcileMarks;
}

const emptySweep = (marks: ReconcileMarks): ReconcileSweepResult => ({
  checked: 0,
  customersNamed: 0,
  failed: 0,
  marks,
  paymentsRegistered: 0,
  repaired: 0,
  tiers: [],
});

/** The bookkeeping row as this sweep reads it back off the module service. */
interface SweepRow extends ReconcileRow {
  allegro_status?: string | null;
}

export const sweepOpenAllegroOrders = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  client: AllegroClient,
  logger: Logger,
  options: AllegroSyncOptions,
  marks: ReconcileMarks,
  /**
   * Checkout forms the drain already applied on this same tick.
   *
   * Excluded rather than re-read. The drain applied them seconds ago from the same
   * upstream state, so a re-read costs an Allegro request to reach the identical
   * conclusion - and it would also stamp a second set of writes over the first, which
   * is what makes "the watermark is the last write of an apply" stop being true.
   */
  appliedThisRun: ReadonlySet<string>,
  mayContinue: () => Promise<boolean>,
  cadence: ReconcileCadence = resolveReconcileCadence(),
): Promise<ReconcileSweepResult> => {
  const now = Date.now();
  const due = dueReconcileTiers(now, marks, cadence);
  if (due.size === 0) {
    return emptySweep(marks);
  }

  // A bounded scan, oldest-touched first, rather than a filtered query. The filter would
  // have to express "not terminal, OR never got a status at all", and a row that never got
  // a status is the most urgent case there is - an order that exists on Allegro and is
  // represented by nothing here. Getting that predicate subtly wrong hides exactly the rows
  // this loop was built for, so the classification happens in memory where it is testable.
  // Ordering by `updated_at` ascending makes the scan round-robin: a row the sweep just
  // touched goes to the back.
  const rows = (await allegro.listAllegroOrders(
    {},
    { order: { updated_at: "ASC" }, take: DEFAULT_SCAN_LIMIT },
  )) as unknown as SweepRow[];

  // One batched read for the whole scan. The payment state is what decides the tier, and
  // it is read from Medusa rather than inferred from `derived_status`, so an order whose
  // payment write failed stays urgent no matter how healthy its status looks.
  const orderIds = rows
    .map((row) => row.medusa_order_id)
    .filter((id): id is string => Boolean(id));
  const payments = await readOrderPaymentStates(container, logger, orderIds);
  const paymentFor = (row: SweepRow): OrderPaymentState | undefined =>
    row.medusa_order_id ? payments.get(row.medusa_order_id) : undefined;

  const batch = selectReconcileBatch(
    rows.filter((candidate) => !appliedThisRun.has(candidate.checkout_form_id)),
    due,
    paymentFor,
    cadence.batchLimit,
  );
  const result = emptySweep(advanceReconcileMarks(now, marks, due));
  result.tiers = [...due];
  if (batch.length === 0) {
    return result;
  }

  for (const row of batch) {
    // Fenced per row, not per sweep: a sweep of the batch limit is up to `batchLimit`
    // Allegro reads plus the order writes behind them, which is long enough to lose the
    // claim or to have the kill switch flipped underneath it.
    if (!(await mayContinue())) {
      break;
    }
    const tier = classifyReconcileTier(row, paymentFor(row));
    try {
      const form = await client.getCheckoutForm(row.checkout_form_id);
      const applied = await applyCheckoutForm(container, allegro, logger, options, form);
      result.checked += 1;
      if (applied.paymentRegistered) {
        result.paymentsRegistered += 1;
      }
      if (applied.customerNamed) {
        // INFO, not WARN, and not counted as a repair. See `customersNamed`: this is the
        // backfill of a field the create path used to leave NULL, so it says nothing
        // about whether the event journal is working.
        result.customersNamed += 1;
        logger.info(
          `[allegro-orders] reconciliation named the customer behind checkout form ${row.checkout_form_id} (Medusa order ${
            applied.medusaOrderId ?? "none"
          }), which was created before the order pipeline wrote customer names. No manual repair is needed for the rest.`,
        );
      }
      if (applied.created || applied.paymentRegistered || applied.statusChanged) {
        result.repaired += 1;
        // WARN, and this is the line the whole loop exists to produce. The event drain
        // should have applied this already; that it had not means an event was lost or
        // never arrived, and a silent repair would hide a broken journal indefinitely.
        logger.warn(
          `[allegro-orders] reconciliation repaired checkout form ${row.checkout_form_id} (${tier} tier, Medusa order ${
            applied.medusaOrderId ?? "none"
          }): ${
            [
              applied.created ? "created the missing Medusa order" : "",
              applied.paymentRegistered ? "recorded the buyer's payment" : "",
              applied.statusChanged ? "moved the status" : "",
            ]
              .filter(Boolean)
              .join(", ")
          }. The event drain had not applied this, so an order event was lost or never arrived.`,
        );
      }
    } catch (error) {
      result.failed += 1;
      // Warn rather than throw. The sweep is a safety net, and one unreadable form must not
      // stop it re-checking the rest - least of all the paid order sitting behind it.
      logger.warn(
        `[allegro-orders] reconciliation could not re-read checkout form ${row.checkout_form_id}: ${
          error instanceof Error ? error.message : String(error)
        }. The next sweep retries it.`,
      );
    }
  }

  return result;
};
