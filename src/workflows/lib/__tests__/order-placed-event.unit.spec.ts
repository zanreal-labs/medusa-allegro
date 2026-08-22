import { EventPriority, Modules, OrderWorkflowEvents } from "@medusajs/framework/utils";
import { emitOrderPlaced, ORDER_PLACED_EVENT, orderPlacedMessage } from "../order-placed-event";

/**
 * The event Medusa does not emit for an order it did not get from a cart.
 *
 * `createOrderWorkflow` emits nothing; `order.placed` is emitted BESIDE the create by
 * `completeCartWorkflow` and `convertDraftOrderWorkflow`. An order the Allegro drain
 * creates therefore never announced itself, and every consumer of that event - starting
 * with the store's Slack announcer - was deaf to marketplace sales while looking
 * completely healthy from the outside.
 *
 * What is worth testing here is the part a subscriber can be broken by: the NAME and the
 * PAYLOAD have to be core's, because subscribers are written against core's shape and
 * must not have to know which channel an order came from.
 */

const fakeLogger = (logs: string[]) => ({
  debug: (message: string) => logs.push(`debug: ${message}`),
  error: (message: string) => logs.push(`error: ${message}`),
  info: (message: string) => logs.push(`info: ${message}`),
  warn: (message: string) => logs.push(`warn: ${message}`),
});

describe("orderPlacedMessage", () => {
  it("is core's event name, not one of this plugin's own", () => {
    // A plugin-specific name would fix exactly the consumers that knew to subscribe to it,
    // and leave every future one with the same bug.
    expect(ORDER_PLACED_EVENT).toBe(OrderWorkflowEvents.PLACED);
    expect(ORDER_PLACED_EVENT).toBe("order.placed");
  });

  it("carries `{ id }` and nothing else, exactly as `completeCartWorkflow` does", () => {
    // Read from @medusajs/core-flows rather than guessed:
    //   emitEventStep({ eventName: OrderWorkflowEvents.PLACED, data: { id: createdOrder.id },
    //                   options: { priority: EventPriority.CRITICAL } })
    // Anything richer here would be a payload only Allegro orders carry, which is exactly
    // the difference a consumer must never have to care about.
    expect(orderPlacedMessage("order_1")).toEqual({
      data: { id: "order_1" },
      name: "order.placed",
      options: { priority: EventPriority.CRITICAL },
    });
  });
});

describe("emitOrderPlaced", () => {
  it("emits through the event bus module", async () => {
    const emitted: unknown[] = [];
    const container = {
      resolve: (key: string) => {
        expect(key).toBe(Modules.EVENT_BUS);
        return { emit: (message: unknown) => {
          emitted.push(message);
          return Promise.resolve();
        } };
      },
    };

    await expect(emitOrderPlaced(container as never, fakeLogger([]) as never, "order_1")).resolves.toBe(
      true,
    );
    expect(emitted).toEqual([orderPlacedMessage("order_1")]);
  });

  it("warns and carries on when the event bus is unavailable", async () => {
    // The order EXISTS by the time this runs. Failing the form over an undelivered
    // notification would hold the Allegro event cursor and stall every later order behind
    // it - and the retry would find the order already created and (correctly) not emit
    // anyway, so the announcement would be lost regardless.
    const logs: string[] = [];
    const container = {
      resolve: () => {
        throw new Error("event_bus is not registered");
      },
    };

    await expect(
      emitOrderPlaced(container as never, fakeLogger(logs) as never, "order_1"),
    ).resolves.toBe(false);
    expect(logs.join("\n")).toContain("could not emit");
    expect(logs.join("\n")).toContain("order_1");
  });

  it("does not throw when the emit itself rejects", async () => {
    const logs: string[] = [];
    const container = {
      resolve: () => ({ emit: () => Promise.reject(new Error("redis is down")) }),
    };

    await expect(
      emitOrderPlaced(container as never, fakeLogger(logs) as never, "order_1"),
    ).resolves.toBe(false);
    expect(logs.join("\n")).toContain("redis is down");
  });
});
