import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { pushAllegroFulfillment } from "../workflows/push-allegro-fulfillment";

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
}: SubscriberArgs<{ order_id?: string }>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const orderId = event.data?.order_id;
  if (!orderId) {
    return;
  }

  try {
    await pushAllegroFulfillment(container, { eventName: event.name, orderId });
  } catch (error) {
    // Belt and braces: `pushAllegroFulfillment` already contains its own failures, so
    // reaching here means something unexpected (a container resolve, a database
    // outage). Still swallowed, for the same reason.
    logger.error(
      `[allegro-fulfillment] subscriber failed for order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const config: SubscriberConfig = {
  // Both, because they mean different things on Allegro: a fulfillment without a
  // shipment is READY_FOR_SHIPMENT, and a shipment is SENT. A store that creates a
  // fulfillment and a shipment in one action simply sends both, and the second wins.
  event: ["order.fulfillment_created", "shipment.created"],
};
