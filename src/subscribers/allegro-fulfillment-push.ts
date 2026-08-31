import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { describeError } from "../lib/allegro/errors";
import { pushAllegroFulfillment } from "../workflows/push-allegro-fulfillment";

/**
 * The payload the two subscribed events carry. They deliberately disagree, and that
 * disagreement is the whole reason SENT never used to fire:
 *
 * - `order.fulfillment_created` is order-scoped and carries `{ order_id, fulfillment_id }`.
 * - `shipment.created` is fulfillment-scoped and carries `{ id }` - the FULFILLMENT id,
 *   with no order id anywhere in the payload.
 */
interface FulfillmentEventData {
  /** Present on `order.fulfillment_created`. */
  order_id?: string;
  /** Present on `shipment.created`: the fulfillment id, NOT an order id. */
  id?: string;
}

interface FulfillmentEvent {
  name: string;
  data?: FulfillmentEventData;
}

/**
 * Resolve the Medusa order id a fulfillment or shipment event belongs to.
 *
 * Medusa 2.18 core's `createOrderShipmentWorkflow` (in `@medusajs/core-flows`) emits
 * `FulfillmentWorkflowEvents.SHIPMENT_CREATED` - the string `"shipment.created"` - with
 * `data: { id: <fulfillmentId> }`. There is NO order id on that event, and core emits
 * no order-scoped shipment event at all. The previous handler read `event.data.order_id`
 * for both events, so for `shipment.created` it got `undefined`, returned early, and the
 * Allegro order was stranded at READY_FOR_SHIPMENT and never reached SENT.
 *
 * So the order id is taken straight from the event when it is order-scoped
 * (`order.fulfillment_created`), and otherwise the fulfillment id on `shipment.created`
 * is resolved to its order through the order<->fulfillment link (`fulfillment.order.id`,
 * the documented reverse relation). Best-effort: any failure yields `undefined` and the
 * caller no-ops, because a fulfillment write-back must never throw.
 */
export const resolveFulfillmentEventOrderId = async (
  container: MedusaContainer,
  event: FulfillmentEvent,
): Promise<string | undefined> => {
  const direct = event.data?.order_id;
  if (direct) {
    return direct;
  }

  const fulfillmentId = event.data?.id;
  if (!fulfillmentId) {
    return undefined;
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = (await query.graph({
    entity: "fulfillment",
    fields: ["order.id"],
    filters: { id: fulfillmentId },
  })) as { data: { order?: { id?: string | null } | null }[] };

  return data?.[0]?.order?.id ?? undefined;
};

/**
 * Tell Allegro when a Medusa fulfillment or shipment happens for an Allegro order.
 *
 * The only event-driven write in the plugin. Everything else is reconciliation-first
 * precisely because events can be missed, but a fulfillment is a point-in-time act
 * rather than reconcilable state - there is no "current fulfillment" for a periodic
 * sweep to compare - so the event is the only available signal.
 *
 * It never throws. The Medusa fulfillment has already been created by the time this
 * runs, so a failure here cannot be fixed by failing the subscriber; the reason is
 * recorded on the `allegro_order` row instead, and an operator can set the status by
 * hand on Allegro.
 *
 * `ordersSyncDisabled` deliberately does NOT gate this: that switch stops the drain
 * from CONSUMING the journal, and pausing an import is a different decision from
 * refusing to tell the buyer a shipment happened. The write-back has its OWN switch
 * instead - `fulfillmentWritebackEnabled`, resolved inside `pushAllegroFulfillment` at
 * the top of each event - so a store can stop this reaching the marketplace live,
 * without conflating it with the order drain and without pulling the subscriber. It
 * defaults OFF on a fresh install like every other writer, and the resolution happens
 * in the workflow rather than here so a redeploy-free flip is honoured on the next event.
 */
export default async function allegroFulfillmentPushSubscriber({
  container,
  event,
}: SubscriberArgs<FulfillmentEventData>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  try {
    const orderId = await resolveFulfillmentEventOrderId(container, event);
    if (!orderId) {
      // Not a silent no-op: for `shipment.created` this means the fulfillment id on
      // the event does not resolve to any order through the link - a stale id, a
      // link that has not propagated yet, or a fulfillment this store does not own.
      // That is exactly the shape of the defect this subscriber was rewritten to
      // fix (see `resolveFulfillmentEventOrderId`): an Allegro order stranded before
      // SENT with nothing in the logs to say why. Logged, never thrown - the
      // subscriber still has nothing to retry here.
      logger.warn(
        `[allegro-fulfillment] could not resolve an order for ${event.name} (${JSON.stringify(event.data ?? {})}); nothing was pushed to Allegro.`,
      );
      return;
    }
    await pushAllegroFulfillment(container, { eventName: event.name, orderId });
  } catch (error) {
    // Belt and braces: `pushAllegroFulfillment` already contains its own failures, so
    // reaching here means something unexpected (a container resolve, a database
    // outage, the order lookup). Still swallowed, for the same reason.
    logger.error(
      `[allegro-fulfillment] subscriber failed for ${event.name}: ${describeError(error)}`,
    );
  }
}

export const config: SubscriberConfig = {
  // Both, because they mean different things on Allegro: a fulfillment without a
  // shipment is READY_FOR_SHIPMENT, and a shipment is SENT. A store that creates a
  // fulfillment and a shipment in one action simply sends both, and the second wins.
  event: ["order.fulfillment_created", "shipment.created"],
};
