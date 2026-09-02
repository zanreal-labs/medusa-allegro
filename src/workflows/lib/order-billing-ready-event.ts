import type { IEventBusModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { EventPriority, Modules } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";

/**
 * `allegro.order.billing_ready`, for the moment an Allegro order can actually be
 * invoiced.
 *
 * ## The failure this exists for
 *
 * An Allegro order is created in Medusa from a checkout form snapshot taken BEFORE the
 * buyer has finished the form, so it has no billing address. The buyer's details land
 * minutes later, on a later drain pass. Meanwhile the payment finalises and
 * `payment.captured` fires, and the invoicing plugin - which subscribes to that - builds
 * an invoice against an order with no address, fails its own completeness gate and parks
 * the order for a human. Measured on order `order_01M1H1PA8BHJMKFPBZWA78F5XQ`:
 *
 *   12:32:22  order created (no billing address; the buyer had not paid yet)
 *   12:36:22  payment captured
 *   12:36:24  medusa-infakt queued the order off `payment.captured`
 *   12:36:25  medusa-infakt: "buyer address is incomplete (missing: street, city, postal_code)"
 *   12:36:41  the drain writes the real billing address - 16 s too late
 *
 * Nothing was broken in either plugin. The invoicing side subscribed to the event that
 * carries the fact it needs first, rather than the event that carries the DATA it needs.
 *
 * ## Why an event and not a retry
 *
 * The house rule is that everything is event-driven and crons are safety nets, never the
 * mechanism. Letting the invoicing plugin re-poll a parked order would have made a sweep
 * the mechanism for issuing invoices. The fact "this order's billing data is now
 * complete" was already known here, on the pass that wrote it, and was simply never
 * announced: `repairOrderAddresses` and `fillOrderTaxId` both write through the Order
 * MODULE SERVICE rather than `updateOrderWorkflow` (see the docblock on
 * `lib/order-address` and medusajs/medusa#16636), so no `order.updated` - and no event of
 * any kind - is emitted when the billing data lands. This is that announcement.
 *
 * ## What the event means, and what it does NOT mean
 *
 * It means exactly one thing: the order's billing address now carries the street, city
 * and postal code an invoice needs (`isUsableAddress`), and it did not before this pass.
 * It is a statement about DATA, not an instruction to issue anything - a subscriber still
 * decides for itself whether the order is paid, cancelled or already invoiced. Reading it
 * as "invoice this now" would make it fire on cancelled and unpaid orders too, which is
 * not what the name says.
 *
 * ## Additive, and named for this plugin
 *
 * `order.placed` keeps meaning what core means by it, and nothing that consumes it
 * changes. This is a new name in the plugin's own namespace rather than a second
 * `order.updated`, because a consumer that hears it should be able to rely on the
 * specific fact above rather than re-deriving it from a generic update.
 *
 * ## The payload is `{ id }`, like core's
 *
 * The same shape `order.placed` carries, so a Medusa subscriber consumes it the same way:
 * read `event.data.id`, re-query the order, decide. Anything richer would be a payload
 * that goes stale between the emit and the read.
 */

/** The event name, so callers and tests never spell it twice. */
export const ORDER_BILLING_READY_EVENT = "allegro.order.billing_ready";

/** The message, for one order id. */
export const orderBillingReadyMessage = (
  orderId: string,
): { name: string; data: { id: string }; options: { priority: number } } => ({
  data: { id: orderId },
  name: ORDER_BILLING_READY_EVENT,
  // CRITICAL, matching `order.placed`. An invoice is a legal document with a deadline,
  // and the whole point of this event is that the order has been waiting for it.
  options: { priority: EventPriority.CRITICAL },
});

/**
 * Announce that an Allegro order's billing data is complete.
 *
 * Never throws, for the same reason `emitOrderPlaced` never throws: the data is already
 * written by the time this runs, and failing the drain pass over an event bus that is
 * momentarily unavailable would hold the Allegro event cursor and stall every later
 * order to retry a notification. Worse, the retry would re-run `applyCheckoutForm`,
 * which would find the billing data already complete and correctly not emit - so the
 * announcement is lost either way, and the only difference is whether the pipeline
 * stalled first.
 *
 * The safety net underneath a lost emit is the invoicing plugin's own parked-order
 * queue, which is exactly what it is for: a net, not the mechanism.
 *
 * Returns whether the event was emitted, which is what the drain's tests assert on.
 */
export const emitOrderBillingReady = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
): Promise<boolean> => {
  try {
    const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS);
    await eventBus.emit(orderBillingReadyMessage(orderId) as never);
    return true;
  } catch (error) {
    logger.warn(
      `[allegro-orders] Medusa order ${orderId} now has complete billing data but \`${ORDER_BILLING_READY_EVENT}\` could not be emitted: ${describeError(error)}. The order is fine; anything waiting to invoice it will not have heard, and falls back to its own retry.`,
    );
    return false;
  }
};
