import type { IEventBusModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { EventPriority, Modules, OrderWorkflowEvents } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";

/**
 * `order.placed`, for orders that were placed on Allegro.
 *
 * ## Why this exists at all
 *
 * Medusa 2.18 does NOT emit `order.placed` from `createOrderWorkflow`. Only two core
 * flows emit it - `completeCartWorkflow` (storefront checkout) and
 * `convertDraftOrderWorkflow` - and both do it themselves, next to the create, rather
 * than inside it. Read from `@medusajs/core-flows` rather than assumed:
 *
 *   cart/workflows/complete-cart.js       -> emitEventStep({ eventName: OrderWorkflowEvents.PLACED, … })
 *   draft-order/workflows/convert-draft-order.js -> emitEventStep({ eventName: OrderWorkflowEvents.PLACED, … })
 *   order/workflows/create-order.js       -> emits nothing
 *
 * The drain creates its orders through `createOrderWorkflow`, so an Allegro sale has
 * never produced an `order.placed` at all. Every consumer of that event - the Slack
 * announcer, and anything a store adds later - is structurally deaf to marketplace
 * orders, and nothing about it looks broken: the subscriber is registered, the order
 * exists, no error is logged anywhere.
 *
 * ## Why the fix is emission here rather than a second subscription elsewhere
 *
 * A consumer subscribing to some Allegro-specific event would fix exactly that one
 * consumer, and every future consumer would have to learn the same lesson. Emitting the
 * event core would have emitted fixes all of them at once, and keeps "an order was
 * placed" meaning one thing in this store regardless of which channel it came from.
 *
 * ## The payload is core's, verbatim
 *
 * `{ id }` and nothing else, with `EventPriority.CRITICAL`, exactly as `emitEventStep`
 * builds it in `completeCartWorkflow`. Subscribers are written against core's shape -
 * `medusa-slack` reads `event.data.id` and re-queries the order - so anything richer
 * here would be a payload only this plugin's orders carry, which is the difference a
 * consumer must never have to care about.
 *
 * ## Emitted after the pass has landed, not inside the create
 *
 * `createOrderWorkflow` takes an email and creates the customer from that alone, with
 * every name column NULL; the buyer's payment is registered afterwards too. A consumer
 * that re-queries the order the instant it is created therefore sees a nameless customer
 * and an unpaid order. So the emission is the last thing `applyCheckoutForm` does, once
 * the name, the payment and the status action have all been applied.
 */

/** The event name, so callers and tests never spell it twice. */
export const ORDER_PLACED_EVENT = OrderWorkflowEvents.PLACED;

/** The message core emits, for one order id. */
export const orderPlacedMessage = (
  orderId: string,
): { name: string; data: { id: string }; options: { priority: number } } => ({
  data: { id: orderId },
  name: ORDER_PLACED_EVENT,
  options: { priority: EventPriority.CRITICAL },
});

/**
 * Emit `order.placed` for an order this pass genuinely created.
 *
 * Never throws, and deliberately never sets `last_error`. The order EXISTS by the time
 * this runs; failing the form over an event bus that is momentarily unavailable would
 * hold the Allegro event cursor - stalling every later order - to retry a notification,
 * and the retry would re-run `applyCheckoutForm`, which would then find the order
 * already created and (correctly) not emit anyway. A missed announcement is worth a
 * warning, not a stalled pipeline.
 *
 * Returns whether the event was emitted, which is what the drain's tests assert on.
 */
export const emitOrderPlaced = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
): Promise<boolean> => {
  try {
    const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS);
    await eventBus.emit(orderPlacedMessage(orderId) as never);
    return true;
  } catch (error) {
    logger.warn(
      `[allegro-orders] created Medusa order ${orderId} but could not emit \`${ORDER_PLACED_EVENT}\`: ${describeError(error)}. The order is fine; anything listening for new orders (a Slack announcement, for instance) will not have heard about this one.`,
    );
    return false;
  }
};
