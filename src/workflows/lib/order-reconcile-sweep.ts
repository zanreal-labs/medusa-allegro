import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import type { AllegroClient } from "../../lib/allegro/client";
import {
  advanceReconcileMarks,
  classifyReconcileTier,
  decideSentPush,
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
  ShipmentState,
} from "../../lib/sync/order-reconcile";
import { mapCheckoutFormStatus } from "../../lib/sync/order-status";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type AllegroModuleService from "../../modules/allegro/service";
import { pushAllegroFulfillment } from "../push-allegro-fulfillment";
import { readOrderPaymentStates } from "./order-payment";
import { readOrderShipmentStates } from "./order-shipment";
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
 *
 * ## It is also the retry path for the fulfillment write-back
 *
 * The `shipment.created` subscriber is the fast path and stays the fast path, but it
 * had no retry of any kind: one failed marketplace call and the buyer's order read
 * `READY_FOR_SHIPMENT` forever. Every other hop in this chain reconciles; that one
 * did not, and it is the one that failed in production.
 *
 * The fix needs no new schedule, because this sweep already re-reads every open
 * Allegro order on a slow tier. It gains one more comparison - `fulfillment.shipped_at`
 * is set in Medusa but the form Allegro just returned is not `SENT` - and pushes
 * through `pushAllegroFulfillment`, the subscriber's own workflow. See `decideSentPush`
 * for the four refusals, `readOrderShipmentStates` for the fact it compares against,
 * and the grace window for why this does not race the subscriber it backs up.
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
  /**
   * Inventory reservations created this sweep.
   *
   * Counted apart from `repaired` for the same reason `customersNamed` is: an Allegro
   * order has NEVER had a reservation, because `createOrderWorkflow` does not create one,
   * so every order predating this code needs one and that says nothing about the event
   * journal. Each one is an order that core's fulfillment - the admin's button included -
   * would have refused with "No stock reservation found", and now will not.
   */
  reservationsCreated: number;
  /** Rows whose re-read threw. */
  failed: number;
  /**
   * Orders this sweep told Allegro were `SENT`.
   *
   * Counted apart from `repaired`, like `customersNamed` and `reservationsCreated`,
   * but for the opposite reason: a non-zero count here does NOT mean an Allegro order
   * event was lost. It means one of OUR writes to Allegro was, which is a different
   * fault with a different owner, and folding it into the journal's repair counter
   * would point an operator at Allegro's event feed instead of at our own subscriber.
   */
  fulfillmentsPushed: number;
  /**
   * Orders whose `SENT` push was attempted and failed.
   *
   * Each one also carries the reason on its own `allegro_order.last_error`, so the
   * count is a pointer rather than the record.
   */
  fulfillmentPushFailures: number;
  /** Set when the write-back kill switch was off, so the whole pass was skipped. */
  fulfillmentPushSkipped?: string;
  /** Marks to persist, so the slow tier's clock survives a restart. */
  marks: ReconcileMarks;
}

const emptySweep = (marks: ReconcileMarks): ReconcileSweepResult => ({
  checked: 0,
  customersNamed: 0,
  failed: 0,
  fulfillmentPushFailures: 0,
  fulfillmentsPushed: 0,
  marks,
  paymentsRegistered: 0,
  repaired: 0,
  reservationsCreated: 0,
  tiers: [],
});

/** The bookkeeping row as this sweep reads it back off the module service. */
interface SweepRow extends ReconcileRow {
  allegro_status?: string | null;
}

/**
 * Tell Allegro one order shipped, when Medusa says it did and Allegro does not.
 *
 * Goes through `pushAllegroFulfillment` - the subscriber's own workflow, with the
 * subscriber's own event name - rather than calling the Allegro client here. There is
 * one way to write a fulfillment status to Allegro and this is not a second one: the
 * kill switch, the `last_error` recording and the `READY_FOR_SHIPMENT`/`SENT` mapping
 * all live in that workflow, and a parallel implementation would drift from it.
 *
 * **It never throws.** A failure is counted and recorded, exactly like the sweep's own
 * per-row failures: one marketplace call that will not go through must not stop the
 * sweep re-checking the orders behind it.
 *
 * **A failure is never silent.** That was the specific hole in the incident - when the
 * order could not be resolved, the workflow returned without writing anything at all,
 * so the stranded order looked healthy. Here the row is always the one the sweep is
 * already holding, so the one case the workflow cannot record for itself - it found no
 * row to record on - is written here instead.
 */
const pushSentIfShipped = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  logger: Logger,
  row: SweepRow,
  medusaOrderId: string,
  derived: ReturnType<typeof mapCheckoutFormStatus>,
  shipment: ShipmentState | undefined,
  now: number,
  graceMs: number,
  result: ReconcileSweepResult,
): Promise<void> => {
  const decision = decideSentPush({ derived, graceMs, now, shipment });
  if (!decision.push) {
    return;
  }

  let outcome: Awaited<ReturnType<typeof pushAllegroFulfillment>>;
  try {
    outcome = await pushAllegroFulfillment(container, {
      // The same event the subscriber would have carried. `pushAllegroFulfillment` maps
      // the event to the status, so naming the event is how the sweep asks for `SENT`
      // without knowing that mapping itself.
      eventName: "shipment.created",
      orderId: medusaOrderId,
    });
  } catch (error) {
    outcome = { attempted: true, error: error instanceof Error ? error.message : String(error) };
  }

  if (outcome.status === "SENT" && !outcome.error) {
    result.fulfillmentsPushed += 1;
    // WARN, like the sweep's other repairs, and for the same reason: the subscriber
    // should have done this at the moment of shipment. Reaching here means that write
    // never landed, and a silent catch-up would hide a broken write-back for good.
    logger.warn(
      `[allegro-orders] reconciliation set checkout form ${row.checkout_form_id} to SENT (Medusa order ${medusaOrderId}), which shipped at ${
        shipment?.shippedAt?.toISOString() ?? "an unknown time"
      }. The shipment.created subscriber had not told Allegro, so the buyer was reading a stale status.`,
    );
    return;
  }

  result.fulfillmentPushFailures += 1;
  const reason =
    outcome.error ??
    outcome.skipped ??
    "the fulfillment write-back attempted nothing and gave no reason";
  if (!outcome.error && !outcome.skipped) {
    // The workflow found no bookkeeping row to write to, which is the exact shape of
    // the original incident. The sweep is holding that row, so it records what the
    // workflow could not.
    await allegro
      .updateAllegroOrders([
        {
          id: row.id,
          last_error: `fulfillment sweep: ${reason} for Medusa order ${medusaOrderId}`,
        },
      ] as never)
      .catch((error: unknown) => {
        logger.error(
          `[allegro-orders] could not record the failed SENT push on allegro_order ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
  logger.warn(
    `[allegro-orders] reconciliation could not set checkout form ${row.checkout_form_id} to SENT (Medusa order ${medusaOrderId}): ${reason}. The reason is on the order row and the next sweep retries it.`,
  );
};

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

  // Resolved ONCE for the whole sweep rather than per row. `pushAllegroFulfillment`
  // re-checks it too - it has to, because the subscriber calls it directly - but
  // reading it here as well is what lets a disarmed store skip the batched shipment
  // read entirely instead of paying for it and discarding the answer.
  const writebackDisabled = await allegro.isFulfillmentWritebackDisabled();
  if (writebackDisabled) {
    result.fulfillmentPushSkipped =
      "the fulfillment write-back is disabled, so no shipped order was pushed to Allegro";
  }
  // Scoped to the BATCH, not to the 500-row scan: this is the set the sweep will
  // actually re-read, so anything wider is a read for rows nothing will act on.
  const shipments = writebackDisabled
    ? new Map<string, ShipmentState>()
    : await readOrderShipmentStates(
        container,
        logger,
        batch
          .map((candidate) => candidate.medusa_order_id)
          .filter((id): id is string => Boolean(id)),
      );

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
      if ((applied.reservationsCreated ?? 0) > 0) {
        // INFO, not WARN, and not counted as a repair - see `reservationsCreated`. The
        // order is now fulfillable by the admin's Fulfill button and by every plugin that
        // calls `createOrderFulfillmentWorkflow`; nothing about the event journal is
        // implicated.
        result.reservationsCreated += applied.reservationsCreated ?? 0;
        logger.info(
          `[allegro-orders] reconciliation reserved inventory for ${applied.reservationsCreated} line item(s) behind checkout form ${row.checkout_form_id} (Medusa order ${
            applied.medusaOrderId ?? "none"
          }), which was created before the order pipeline reserved stock. It can now be fulfilled; no manual repair is needed for the rest.`,
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

      // The fulfillment write-back's retry path. AFTER the apply, deliberately: the
      // apply has just written `derived_status` from this very form, so the status
      // compared here is the one on the row rather than the one from before the sweep.
      if (!writebackDisabled && applied.medusaOrderId) {
        await pushSentIfShipped(
          container,
          allegro,
          logger,
          row,
          applied.medusaOrderId,
          mapCheckoutFormStatus(form),
          shipments.get(applied.medusaOrderId),
          now,
          cadence.sentGraceMs,
          result,
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
