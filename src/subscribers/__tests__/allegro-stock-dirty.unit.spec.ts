import allegroStockDirtySubscriber, {
  config,
  readOrderSkus,
  resolveStockDirtyOrderId,
} from "../allegro-stock-dirty";
import { enqueueStockPush } from "../../workflows/lib/stock-push-queue";

jest.mock("../../workflows/lib/stock-push-queue", () => ({
  enqueueStockPush: jest.fn(),
}));

const enqueued = enqueueStockPush as jest.MockedFunction<typeof enqueueStockPush>;

/** A container exposing just the logger and the query the subscriber reaches for. */
const fakeContainer = (input: {
  orders?: Record<string, { items?: { variant?: { sku?: string | null } | null }[] }>;
  queryThrows?: Error;
}) => {
  const logs: string[] = [];
  const record = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };
  return {
    logs,
    resolve: (key: string) => {
      if (key === "logger") {
        return {
          debug: record("debug"),
          error: record("error"),
          info: record("info"),
          warn: record("warn"),
        };
      }
      if (key === "query") {
        return {
          graph: (args: { filters?: { id?: string } }) => {
            if (input.queryThrows) {
              return Promise.reject(input.queryThrows);
            }
            const order = input.orders?.[args.filters?.id ?? ""];
            return Promise.resolve({ data: order ? [order] : [] });
          },
        };
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  };
};

beforeEach(() => {
  enqueued.mockClear();
});

describe("resolveStockDirtyOrderId", () => {
  it("reads the order id straight off an order-scoped event", () => {
    expect(resolveStockDirtyOrderId({ data: { id: "order_1" }, name: "order.placed" })).toBe(
      "order_1",
    );
  });

  it("reads order_id off a reservation event, never its reservation id", () => {
    // `data.id` on a reservation event is the RESERVATION, and treating it as an order
    // is the exact defect that made the fulfillment write-back silently no-op.
    expect(
      resolveStockDirtyOrderId({
        data: { id: "resitem_1", order_id: "order_9" },
        name: "reservation-item.created",
      }),
    ).toBe("order_9");
  });

  it("gives up on a reservation raised outside an order flow", () => {
    expect(
      resolveStockDirtyOrderId({ data: { id: "resitem_1" }, name: "reservation-item.created" }),
    ).toBeUndefined();
  });
});

describe("readOrderSkus", () => {
  it("returns each line's SKU once", async () => {
    const container = fakeContainer({
      orders: {
        order_1: {
          items: [
            { variant: { sku: "SKU-1" } },
            { variant: { sku: "SKU-2" } },
            { variant: { sku: "SKU-1" } },
          ],
        },
      },
    });
    expect(await readOrderSkus(container as never, "order_1")).toEqual(["SKU-1", "SKU-2"]);
  });

  it("skips a custom line item that has no variant", async () => {
    // Real rather than defensive: the drain creates custom line items for Allegro lines
    // whose sygnatura matches no Medusa variant. There is no offer to push for one.
    const container = fakeContainer({
      orders: {
        order_1: { items: [{ variant: null }, { variant: { sku: "SKU-1" } }] },
      },
    });
    expect(await readOrderSkus(container as never, "order_1")).toEqual(["SKU-1"]);
  });
});

describe("allegroStockDirtySubscriber", () => {
  it("marks the SKUs a sale touched", async () => {
    const container = fakeContainer({
      orders: { order_1: { items: [{ variant: { sku: "SKU-1" } }] } },
    });

    await allegroStockDirtySubscriber({
      container,
      event: { data: { id: "order_1" }, name: "order.placed" },
    } as never);

    expect(enqueued).toHaveBeenCalledWith(container, ["SKU-1"]);
  });

  it("never throws when the order lookup fails", async () => {
    const container = fakeContainer({ queryThrows: new Error("database is down") });

    // This is a hint attached to somebody else's event. Failing here would fail the
    // order flow that emitted it, to avoid a staleness the sweep already covers.
    await expect(
      allegroStockDirtySubscriber({
        container,
        event: { data: { id: "order_1" }, name: "order.placed" },
      } as never),
    ).resolves.toBeUndefined();
    expect(enqueued).not.toHaveBeenCalled();
    expect(container.logs.join("\n")).toContain("could not mark stock dirty");
  });

  it("pushes nothing for an order with no variant-backed line", async () => {
    const container = fakeContainer({ orders: { order_1: { items: [{ variant: null }] } } });

    await allegroStockDirtySubscriber({
      container,
      event: { data: { id: "order_1" }, name: "order.placed" },
    } as never);

    expect(enqueued).not.toHaveBeenCalled();
  });

  it("subscribes to the lifecycle points where available quantity moves", () => {
    // `order.placed` covers a web sale AND an Allegro sale, because the drain emits
    // core's event for the orders it creates. Asserted so that coupling is not broken
    // silently by someone trimming this list.
    expect(config.event).toEqual([
      "order.placed",
      "order.completed",
      "order.canceled",
      "reservation-item.created",
      "reservation-item.deleted",
    ]);
  });
});
