import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * The write-back's SENT step never fired because Medusa 2.18 core emits
 * `shipment.created` with `{ id: <fulfillmentId> }` and NO order id, while the old
 * subscriber only ever read `event.data.order_id`. These pin the resolution: an
 * order-scoped event uses its `order_id` directly, and a shipment event resolves the
 * fulfillment id to its order through the link before the push runs. The push
 * workflow's own spec covers the eventName -> Allegro status mapping
 * (`shipment.created` -> SENT, `order.fulfillment_created` -> READY_FOR_SHIPMENT), so
 * here we only assert that each event reaches the push with the right order id.
 */

const pushAllegroFulfillment = jest.fn((..._args: unknown[]) =>
  Promise.resolve({ attempted: true }),
);
jest.mock("../../workflows/push-allegro-fulfillment", () => ({
  pushAllegroFulfillment: (...args: unknown[]) => pushAllegroFulfillment(...args),
}));

import allegroFulfillmentPushSubscriber, {
  resolveFulfillmentEventOrderId,
} from "../allegro-fulfillment-push";

const fakeContainer = (
  graph?: jest.Mock,
  logs: string[] = [],
): MedusaContainer =>
  ({
    resolve: (key: string) => {
      if (key === "query") {
        return { graph };
      }
      if (key === "logger") {
        const record = (level: string) => (message: string) => {
          logs.push(`${level}: ${message}`);
        };
        return { error: record("error"), info: record("info"), warn: record("warn") };
      }
      throw new Error(`unexpected container key ${key}`);
    },
  }) as unknown as MedusaContainer;

beforeEach(() => {
  pushAllegroFulfillment.mockClear();
});

describe("resolveFulfillmentEventOrderId", () => {
  it("uses order_id directly for an order-scoped fulfillment event", async () => {
    const graph = jest.fn();
    const orderId = await resolveFulfillmentEventOrderId(fakeContainer(graph), {
      data: { order_id: "order_1" },
      name: "order.fulfillment_created",
    });

    expect(orderId).toBe("order_1");
    // No lookup needed when the event already carries the order id.
    expect(graph).not.toHaveBeenCalled();
  });

  it("resolves the order from the fulfillment id on shipment.created", async () => {
    const graph = jest.fn(() =>
      Promise.resolve({ data: [{ order: { id: "order_9" } }] }),
    );

    const orderId = await resolveFulfillmentEventOrderId(fakeContainer(graph), {
      data: { id: "ful_1" },
      name: "shipment.created",
    });

    expect(orderId).toBe("order_9");
    expect(graph).toHaveBeenCalledWith({
      entity: "fulfillment",
      fields: ["order.id"],
      filters: { id: "ful_1" },
    });
  });

  it("returns undefined when the fulfillment has no resolvable order", async () => {
    const graph = jest.fn(() => Promise.resolve({ data: [] }));

    expect(
      await resolveFulfillmentEventOrderId(fakeContainer(graph), {
        data: { id: "ful_missing" },
        name: "shipment.created",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the event carries neither an order id nor a fulfillment id", async () => {
    const graph = jest.fn();

    expect(
      await resolveFulfillmentEventOrderId(fakeContainer(graph), {
        data: {},
        name: "shipment.created",
      }),
    ).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
  });
});

describe("allegroFulfillmentPushSubscriber", () => {
  it("drives SENT: a shipment event resolves the order and pushes shipment.created", async () => {
    const graph = jest.fn(() =>
      Promise.resolve({ data: [{ order: { id: "order_9" } }] }),
    );

    await allegroFulfillmentPushSubscriber({
      container: fakeContainer(graph),
      event: { data: { id: "ful_1" }, name: "shipment.created" },
    } as never);

    expect(pushAllegroFulfillment).toHaveBeenCalledTimes(1);
    expect(pushAllegroFulfillment).toHaveBeenCalledWith(expect.anything(), {
      eventName: "shipment.created",
      orderId: "order_9",
    });
  });

  it("drives READY_FOR_SHIPMENT: a fulfillment event pushes order.fulfillment_created without a lookup", async () => {
    const graph = jest.fn();

    await allegroFulfillmentPushSubscriber({
      container: fakeContainer(graph),
      event: {
        data: { fulfillment_id: "ful_1", order_id: "order_1" },
        name: "order.fulfillment_created",
      },
    } as never);

    expect(graph).not.toHaveBeenCalled();
    expect(pushAllegroFulfillment).toHaveBeenCalledWith(expect.anything(), {
      eventName: "order.fulfillment_created",
      orderId: "order_1",
    });
  });

  it("no-ops when the shipment's order cannot be resolved", async () => {
    const graph = jest.fn(() => Promise.resolve({ data: [] }));

    await allegroFulfillmentPushSubscriber({
      container: fakeContainer(graph),
      event: { data: { id: "ful_missing" }, name: "shipment.created" },
    } as never);

    expect(pushAllegroFulfillment).not.toHaveBeenCalled();
  });

  it("never throws: a lookup failure is swallowed and logged", async () => {
    const logs: string[] = [];
    const graph = jest.fn(() => Promise.reject(new Error("db down")));

    await expect(
      allegroFulfillmentPushSubscriber({
        container: fakeContainer(graph, logs),
        event: { data: { id: "ful_1" }, name: "shipment.created" },
      } as never),
    ).resolves.toBeUndefined();

    expect(pushAllegroFulfillment).not.toHaveBeenCalled();
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });
});
