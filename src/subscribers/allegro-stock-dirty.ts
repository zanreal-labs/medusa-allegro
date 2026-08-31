import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  OrderWorkflowEvents,
  ReservationItemWorkflowEvents,
} from "@medusajs/framework/utils";
import { describeError } from "../lib/allegro/errors";
import { enqueueStockPush } from "../workflows/lib/stock-push-queue";

/**
 * Tell the quantity push that something moved, the moment it moves.
 *
 * ## Why this is an exception to "reconciliation first, events almost never"
 *
 * The plugin's standing rule is that a loop reads the whole relevant state and
 * computes the difference, so a missed event costs one cycle of staleness rather than
 * a permanently wrong figure. That rule is not being relaxed here: the 15-minute stock
 * reconciliation still runs and still reads everything, and it remains the thing that
 * makes the quantity on Allegro correct.
 *
 * What this adds is speed, and the reason it is worth adding is that for STOCK,
 * "one cycle of staleness" has a price nothing else on this plugin has. A price that
 * is fifteen minutes late is a price fifteen minutes late. A QUANTITY that is fifteen
 * minutes late is an item that sold out fifteen minutes ago and is still purchasable
 * on Allegro - an oversell, which costs a cancelled order, a buyer, and a seller
 * rating. So the events shorten the window, and the sweep still closes it.
 *
 * Because it is additive, a missed event costs exactly what it cost before: the next
 * reconciliation. That is why nothing here throws, retries, or persists.
 *
 * ## Why these events and not inventory events
 *
 * Medusa's inventory events are not a reliable trigger
 * ([medusa#11691](https://github.com/medusajs/medusa/issues/11691)), which is the
 * finding the whole reconciliation-first design is built on, and subscribing to them
 * would build the fast path on the one signal this plugin has already established it
 * cannot trust.
 *
 * Order and reservation lifecycle events are a different thing. They are emitted by
 * the order and reservation workflows themselves, they are what MOVE available
 * quantity (`retrieveAvailableQuantity` is stocked minus reserved), and they carry the
 * order the change belongs to. They are used as a HINT - "these SKUs are worth
 * re-reading now" - never as the value: the push re-reads Medusa's available quantity
 * and Allegro's offer for itself, so an event that lies about quantity cannot make it
 * write a wrong one.
 *
 * ## `order.placed` covers Allegro's own orders too, for free
 *
 * A marketplace sale drains through `GET /order/events` and lands as a Medusa order,
 * and `workflows/lib/order-placed-event` already emits core's `order.placed` for it -
 * precisely because `createOrderWorkflow` does not. So this subscriber sees an Allegro
 * sale on the same event as a web sale, with no coupling to the drain and no second
 * code path. A sale on either channel updates the quantity on the other.
 *
 * `order.canceled` is here for the opposite direction: a cancelled order returns
 * units, and an item that came back into stock but stays advertised as unavailable is
 * a lost sale rather than an oversell - quieter, but still wrong, and free to fix on
 * the same path.
 */

/**
 * The payloads the subscribed events carry.
 *
 * Order events are `{ id }` - the ORDER id. Reservation events are `{ id, order_id? }`
 * where `id` is the RESERVATION id, so the order id is the only field of the two that
 * this subscriber can use, and it is optional.
 */
interface StockDirtyEventData {
  /** Order events: the order id. Reservation events: the reservation id. */
  id?: string;
  /** Reservation events only, and only when an order flow caused them. */
  order_id?: string;
}

interface StockDirtyEvent {
  name: string;
  data?: StockDirtyEventData;
}

/** Events whose `data.id` is an order id rather than something else's. */
const ORDER_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  OrderWorkflowEvents.CANCELED,
  OrderWorkflowEvents.COMPLETED,
  OrderWorkflowEvents.PLACED,
]);

/**
 * The order id an event points at, or undefined when it points at nothing usable.
 *
 * A reservation event with no `order_id` is deliberately given up on rather than
 * resolved through the reservation to its inventory item and back to a variant. Such a
 * reservation was not created by an order flow - an operator adjusting stock by hand,
 * most likely - and the extra two queries would buy a faster update for the one case
 * where a human is already looking at the inventory screen. The reconciliation covers
 * it, on exactly the guarantee that applied before this path existed.
 */
export const resolveStockDirtyOrderId = (
  event: StockDirtyEvent,
): string | undefined => {
  if (ORDER_SCOPED_EVENTS.has(event.name)) {
    return event.data?.id ?? undefined;
  }
  return event.data?.order_id ?? undefined;
};

/**
 * The SKUs an order's lines are for.
 *
 * A line with no variant is skipped without comment, and that case is real rather than
 * defensive: the drain creates custom line items for Allegro lines whose sygnatura
 * matches no Medusa variant. Such a line has no SKU, therefore no mapping row and no
 * offer, so there is nothing to push for it.
 *
 * Best-effort. Any failure yields an empty list and the caller no-ops, because a
 * hint that could not be resolved must never fail an order flow's event.
 */
export const readOrderSkus = async (
  container: MedusaContainer,
  orderId: string,
): Promise<string[]> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = (await query.graph({
    entity: "order",
    fields: ["id", "items.variant.sku"],
    filters: { id: orderId },
  })) as {
    data: { items?: { variant?: { sku?: string | null } | null }[] | null }[];
  };

  const skus = new Set<string>();
  for (const item of data?.[0]?.items ?? []) {
    const sku = item?.variant?.sku?.trim();
    if (sku) {
      skus.add(sku);
    }
  }
  return [...skus];
};

/**
 * Mark the SKUs an order touched as dirty, so the next debounce window pushes them.
 *
 * Never throws. This is a hint attached to somebody else's event: a failure here must
 * not fail the order flow that emitted it, and it costs at most the staleness the
 * store already had.
 */
export default async function allegroStockDirtySubscriber({
  container,
  event,
}: SubscriberArgs<StockDirtyEventData>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  try {
    const orderId = resolveStockDirtyOrderId(event);
    if (!orderId) {
      // Debug, not warn: for a reservation raised outside an order flow this is the
      // expected and documented outcome, not a defect, and warning on it would train
      // an operator to ignore the log.
      logger.debug(
        `[allegro-stock] ${event.name} carried no order id; no SKU was marked dirty. The scheduled reconciliation still covers it.`,
      );
      return;
    }

    const skus = await readOrderSkus(container, orderId);
    if (skus.length === 0) {
      logger.debug(
        `[allegro-stock] ${event.name} for order ${orderId} named no variant-backed line; nothing marked dirty.`,
      );
      return;
    }
    enqueueStockPush(container, skus);
  } catch (error) {
    logger.warn(
      `[allegro-stock] could not mark stock dirty for ${event.name}: ${describeError(error)}. Nothing was pushed; the scheduled reconciliation still covers it.`,
    );
  }
}

export const config: SubscriberConfig = {
  /**
   * The lifecycle points at which available quantity moves.
   *
   * `order.placed` is the one that matters commercially - it is the sale, on either
   * channel - and the rest are the symmetric cases: a completed order settles what a
   * placed one reserved, a cancelled one gives units back, and a reservation event is
   * the signal for units reserved outside placement, which is how the reconciliation
   * sweep backfills reservations onto older Allegro orders.
   *
   * Overlap between them is deliberate and free: a web sale emits `order.placed` and a
   * `reservation-item.created` per line, and the queue coalesces all of it into one
   * push carrying each SKU once.
   */
  event: [
    OrderWorkflowEvents.PLACED,
    OrderWorkflowEvents.COMPLETED,
    OrderWorkflowEvents.CANCELED,
    ReservationItemWorkflowEvents.CREATED,
    ReservationItemWorkflowEvents.DELETED,
  ],
};
