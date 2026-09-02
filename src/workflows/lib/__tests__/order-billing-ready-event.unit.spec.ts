import { EventPriority, Modules } from "@medusajs/framework/utils";
import {
  emitOrderBillingReady,
  ORDER_BILLING_READY_EVENT,
  orderBillingReadyMessage,
} from "../order-billing-ready-event";

/**
 * The announcement nothing else makes.
 *
 * An Allegro order's billing address and tax id are written through the Order module
 * service, deliberately bypassing `updateOrderWorkflow` (medusajs/medusa#16636), so they
 * land with no `order.updated` and no event of any kind. Meanwhile `payment.captured`
 * has already fired and sent the invoicing plugin at an order with no address.
 *
 * What is worth testing here is what a subscriber can be broken by: the NAME and the
 * PAYLOAD, and that a bus that is down costs an announcement rather than a drain pass.
 */

const fakeLogger = (logs: string[]) => ({
  debug: (message: string) => logs.push(`debug: ${message}`),
  error: (message: string) => logs.push(`error: ${message}`),
  info: (message: string) => logs.push(`info: ${message}`),
  warn: (message: string) => logs.push(`warn: ${message}`),
});

describe("orderBillingReadyMessage", () => {
  it("is named in this plugin's own namespace", () => {
    // Not a second `order.updated`: a consumer that hears this should be able to rely on
    // the specific fact - the billing address now carries what an invoice needs - rather
    // than re-deriving it from a generic update it would also get for a status change.
    expect(ORDER_BILLING_READY_EVENT).toBe("allegro.order.billing_ready");
  });

  it("carries `{ id }` and nothing else, like core's own order events", () => {
    // The same shape `order.placed` carries, so a Medusa subscriber consumes it the same
    // way. Anything richer would be a payload that goes stale between emit and read.
    expect(orderBillingReadyMessage("order_1")).toEqual({
      data: { id: "order_1" },
      name: "allegro.order.billing_ready",
      options: { priority: EventPriority.CRITICAL },
    });
  });
});

describe("emitOrderBillingReady", () => {
  it("emits through the event bus module", async () => {
    const emitted: unknown[] = [];
    const container = {
      resolve: (key: string) => {
        expect(key).toBe(Modules.EVENT_BUS);
        return {
          emit: (message: unknown) => {
            emitted.push(message);
            return Promise.resolve();
          },
        };
      },
    };

    await expect(
      emitOrderBillingReady(container as never, fakeLogger([]) as never, "order_1"),
    ).resolves.toBe(true);
    expect(emitted).toEqual([orderBillingReadyMessage("order_1")]);
  });

  it("warns and carries on when the event bus is unavailable", async () => {
    // The billing data is already WRITTEN by the time this runs. Failing the form over an
    // undelivered notification would hold the Allegro event cursor and stall every later
    // order - and the retry would find the billing data already complete and correctly
    // not emit, so the announcement is lost either way.
    const logs: string[] = [];
    const container = {
      resolve: () => {
        throw new Error("event_bus is not registered");
      },
    };

    await expect(
      emitOrderBillingReady(container as never, fakeLogger(logs) as never, "order_1"),
    ).resolves.toBe(false);
    expect(logs.join("\n")).toContain("could not be emitted");
    expect(logs.join("\n")).toContain("order_1");
  });

  it("does not throw when the emit itself rejects", async () => {
    const logs: string[] = [];
    const container = {
      resolve: () => ({ emit: () => Promise.reject(new Error("redis is down")) }),
    };

    await expect(
      emitOrderBillingReady(container as never, fakeLogger(logs) as never, "order_1"),
    ).resolves.toBe(false);
    expect(logs.join("\n")).toContain("redis is down");
  });
});
