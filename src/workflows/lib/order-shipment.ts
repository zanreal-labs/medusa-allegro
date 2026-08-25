import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { ShipmentState } from "../../lib/sync/order-reconcile";

/**
 * Reading whether a Medusa order has actually shipped.
 *
 * The missing half of the fulfillment write-back. The subscriber fires once, on
 * `shipment.created`, and if that one call fails there is nothing left that knows a
 * shipment happened - which is precisely how a live Allegro order sat reading
 * `READY_FOR_SHIPMENT` for three days after the buyer had their licence key.
 *
 * `fulfillment.shipped_at` is the durable form of that same fact. It is set by core
 * when the shipment is created and it never goes away, so a sweep can compare it
 * against Allegro's status as often as it likes. That is the whole reason the
 * write-back can have a retry path at all.
 */

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

interface FulfillmentRow {
  shipped_at?: string | Date | null;
  canceled_at?: string | Date | null;
}

const toDate = (value: string | Date | null | undefined): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Read the newest live shipment behind each of these orders, in one round trip.
 *
 * Batched for the same reason the payment read is: the sweep asks this about every
 * row in its batch on every tick, and one round trip per order would make a cheap
 * local read the dominant cost of the sweep.
 *
 * **Cancelled fulfillments are ignored.** A cancelled shipment is not a shipment,
 * and counting one would push `SENT` for a delivery that was called back - a write
 * to a marketplace on a real buyer's order that nothing later undoes.
 *
 * **The newest `shipped_at` wins.** An order fulfilled in parts has several, and the
 * question this answers is "has anything shipped", not "when did shipping start".
 * Taking the newest also makes the grace window in `decideSentPush` behave: a second
 * shipment restarts the clock the subscriber is racing against, rather than letting
 * an old first parcel wave the sweep straight past it.
 *
 * A read that throws returns an EMPTY map rather than propagating. Nothing shipped,
 * as far as this sweep is concerned, so nothing is pushed - the same posture the
 * payment read takes, and for the same reason: inventing a marketplace write out of
 * a failed database read is worse than deferring it to the next tick.
 */
export const readOrderShipmentStates = async (
  container: MedusaContainer,
  logger: Logger,
  orderIds: readonly string[],
): Promise<Map<string, ShipmentState>> => {
  const states = new Map<string, ShipmentState>();
  if (orderIds.length === 0) {
    return states;
  }
  try {
    const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "fulfillments.id", "fulfillments.shipped_at", "fulfillments.canceled_at"],
      filters: { id: [...orderIds] },
    });
    for (const order of data) {
      const fulfillments = (order.fulfillments as FulfillmentRow[] | null) ?? [];
      let shippedAt: Date | undefined;
      for (const fulfillment of fulfillments) {
        if (fulfillment.canceled_at) {
          continue;
        }
        const shipped = toDate(fulfillment.shipped_at);
        if (shipped && (!shippedAt || shipped > shippedAt)) {
          shippedAt = shipped;
        }
      }
      states.set(order.id as string, shippedAt ? { shippedAt } : {});
    }
  } catch (error) {
    logger.warn(
      `[allegro-orders] could not read the shipment state of ${orderIds.length} Medusa order(s): ${
        error instanceof Error ? error.message : String(error)
      }. No fulfillment status is pushed to Allegro for a state that could not be read; the next sweep retries.`,
    );
  }
  return states;
};
