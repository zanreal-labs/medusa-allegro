import type { MedusaContainer } from "@medusajs/framework/types";
import { pushAllegroFulfillment } from "../push-allegro-fulfillment";

/**
 * The fulfillment write-back is the one event-driven write, and the one that had no
 * kill switch before. These pin its NEW gate: it resolves the persisted toggle at the
 * top of the handler and short-circuits before touching the database or Allegro when
 * the writer is disarmed, so an operator's flip stops it on the very next event.
 */

interface FakeAllegro {
  isFulfillmentWritebackDisabled: () => Promise<boolean>;
  listAllegroOrders: jest.Mock;
  updateAllegroOrders: jest.Mock;
  getClient: jest.Mock;
}

const fakeContainer = (allegro: FakeAllegro, logs: string[] = []): MedusaContainer => {
  const record = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };
  return {
    resolve: (key: string) => {
      if (key === "allegro") {
        return allegro;
      }
      if (key === "logger") {
        return { error: record("error"), info: record("info"), warn: record("warn") };
      }
      throw new Error(`unexpected container key ${key}`);
    },
  } as unknown as MedusaContainer;
};

describe("pushAllegroFulfillment", () => {
  it("does nothing, and touches neither the database nor Allegro, when disarmed", async () => {
    const allegro: FakeAllegro = {
      getClient: jest.fn(() => Promise.resolve({})),
      isFulfillmentWritebackDisabled: () => Promise.resolve(true),
      listAllegroOrders: jest.fn(),
      updateAllegroOrders: jest.fn(),
    };

    const result = await pushAllegroFulfillment(fakeContainer(allegro), {
      eventName: "shipment.created",
      orderId: "order_1",
    });

    expect(result.attempted).toBe(false);
    expect(result.skipped).toContain("disabled");
    // The gate is BEFORE the lookup, so a disarmed writer costs nothing.
    expect(allegro.listAllegroOrders).not.toHaveBeenCalled();
    expect(allegro.getClient).not.toHaveBeenCalled();
  });

  it("pushes the mapped status once armed and connected", async () => {
    const updateCheckoutFormFulfillment = jest.fn(() => Promise.resolve());
    const allegro: FakeAllegro = {
      getClient: jest.fn(() => Promise.resolve({ updateCheckoutFormFulfillment })),
      isFulfillmentWritebackDisabled: () => Promise.resolve(false),
      listAllegroOrders: jest.fn(() =>
        Promise.resolve([{ checkout_form_id: "cf_1", id: "algorder_1" }]),
      ),
      updateAllegroOrders: jest.fn(() => Promise.resolve([])),
    };

    const result = await pushAllegroFulfillment(fakeContainer(allegro), {
      eventName: "shipment.created",
      orderId: "order_1",
    });

    expect(result).toEqual({ attempted: true, status: "SENT" });
    expect(updateCheckoutFormFulfillment).toHaveBeenCalledWith("cf_1", "SENT");
  });

  it("stays a no-op for an order that did not come from Allegro", async () => {
    const allegro: FakeAllegro = {
      getClient: jest.fn(() => Promise.resolve({})),
      isFulfillmentWritebackDisabled: () => Promise.resolve(false),
      listAllegroOrders: jest.fn(() => Promise.resolve([])),
      updateAllegroOrders: jest.fn(),
    };

    const result = await pushAllegroFulfillment(fakeContainer(allegro), {
      eventName: "order.fulfillment_created",
      orderId: "order_2",
    });

    expect(result).toEqual({ attempted: false });
    expect(allegro.getClient).not.toHaveBeenCalled();
  });
});
