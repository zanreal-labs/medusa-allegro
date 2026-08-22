import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ensureOrderReservations } from "../lib/order-reservations";

/**
 * The reservation write path.
 *
 * What is under test here is the Medusa wiring the pure planner cannot see: that the
 * quantities are read through the relation the serializer cannot drop, that the existing
 * reservations are actually queried before anything is created, and - the property the
 * whole design rests on - that NOTHING here ever throws. An unreservable order must not
 * hold the Allegro event cursor.
 */

// eslint-disable-next-line no-var, vars-on-top -- must be hoisted with the jest.mock factory
var coreFlows: {
  reservations: Record<string, unknown>[][];
  error?: Error;
} = { reservations: [] };

jest.mock("@medusajs/medusa/core-flows", () => ({
  createReservationsWorkflow: () => ({
    run: ({ input }: { input: { reservations: Record<string, unknown>[] } }) => {
      if (coreFlows.error) {
        return Promise.reject(coreFlows.error);
      }
      coreFlows.reservations.push(input.reservations);
      return Promise.resolve({ result: input.reservations.map((_, i) => ({ id: `res_${i}` })) });
    },
  }),
}));

interface Seed {
  /** Absent means the order cannot be read at all. */
  order?: Record<string, unknown>;
  reservations?: Record<string, unknown>[];
  orderQueryThrows?: boolean;
}

const harness = (seed: Seed) => {
  const logs: string[] = [];
  const queries: string[] = [];
  const logger = {
    error: (message: string) => logs.push(`error: ${message}`),
    info: (message: string) => logs.push(`info: ${message}`),
    warn: (message: string) => logs.push(`warn: ${message}`),
  } as unknown as Logger;
  const container = {
    resolve: (key: string) => {
      if (key !== "query") {
        throw new Error(`unexpected container key ${key}`);
      }
      return {
        graph: ({ entity }: { entity: string }) => {
          queries.push(entity);
          if (entity === "order") {
            if (seed.orderQueryThrows) {
              return Promise.reject(new Error("the order could not be read"));
            }
            return Promise.resolve({ data: seed.order ? [seed.order] : [] });
          }
          if (entity === "reservations") {
            return Promise.resolve({ data: seed.reservations ?? [] });
          }
          return Promise.resolve({ data: [] });
        },
      };
    },
  } as unknown as MedusaContainer;
  return { container, logger, logs, queries };
};

/** A managed line as `query.graph` returns it, quantities on `detail` and nowhere else. */
const managedLine = (over: Record<string, unknown> = {}) => ({
  detail: { fulfilled_quantity: 0, quantity: 2 },
  id: "ordli_1",
  title: "A licence",
  variant: {
    allow_backorder: false,
    inventory_items: [
      {
        inventory: {
          location_levels: [
            {
              location_id: "sloc_1",
              reserved_quantity: 0,
              stock_locations: { id: "sloc_1", sales_channels: [{ id: "sc_allegro" }] },
              stocked_quantity: 5,
            },
          ],
        },
        inventory_item_id: "iitem_1",
        required_quantity: 1,
      },
    ],
    manage_inventory: true,
  },
  ...over,
});

const order = (items: Record<string, unknown>[]) => ({
  id: "order_1",
  items,
  sales_channel_id: "sc_allegro",
});

beforeEach(() => {
  coreFlows.reservations = [];
  coreFlows.error = undefined;
});

describe("ensureOrderReservations", () => {
  it("creates the missing reservation for an unreserved order", async () => {
    const { container, logger } = harness({ order: order([managedLine()]) });
    const result = await ensureOrderReservations(container, logger, "order_1");
    expect(result).toEqual({ created: 1, gaps: 0 });
    expect(coreFlows.reservations).toEqual([
      [
        {
          allow_backorder: false,
          description: "Allegro order order_1",
          inventory_item_id: "iitem_1",
          line_item_id: "ordli_1",
          location_id: "sloc_1",
          quantity: 2,
        },
      ],
    ]);
  });

  it("reads the quantity through `detail`, which the serializer cannot drop", async () => {
    // Medusa drops the computed `items.quantity` whenever another line-item scalar rides
    // in the same selection - bisected live on production. A reader that trusted it would
    // see quantity 0 here and reserve nothing, silently leaving the order unfulfillable.
    const { container, logger } = harness({
      order: order([managedLine({ detail: { quantity: 4 }, quantity: undefined })]),
    });
    await ensureOrderReservations(container, logger, "order_1");
    expect(coreFlows.reservations[0]?.[0]?.quantity).toBe(4);
  });

  it("writes nothing when the order is already fully reserved", async () => {
    // The sweep runs this on every pass over every open order. A healthy order has to
    // cost two reads and no writes, or the sweep would churn the inventory table forever.
    const { container, logger } = harness({
      order: order([managedLine()]),
      reservations: [
        { inventory_item_id: "iitem_1", line_item_id: "ordli_1", quantity: 2 },
      ],
    });
    const result = await ensureOrderReservations(container, logger, "order_1");
    expect(result).toEqual({ created: 0, gaps: 0 });
    expect(coreFlows.reservations).toEqual([]);
  });

  it("reads a BigNumber reservation quantity rather than treating it as zero", async () => {
    // Reservation quantities come back as BigNumber instances like every other numeric
    // column. Misreading one as zero would re-reserve stock that is already held.
    const { container, logger } = harness({
      order: order([managedLine()]),
      reservations: [
        {
          inventory_item_id: "iitem_1",
          line_item_id: "ordli_1",
          quantity: { numeric: 2, raw: { value: "2" } },
        },
      ],
    });
    expect(await ensureOrderReservations(container, logger, "order_1")).toEqual({
      created: 0,
      gaps: 0,
    });
  });

  it("warns and skips a line with no stock level, without throwing", async () => {
    const { container, logger, logs } = harness({
      order: order([
        managedLine({
          variant: {
            allow_backorder: false,
            inventory_items: [
              { inventory: { location_levels: [] }, inventory_item_id: "iitem_1" },
            ],
            manage_inventory: true,
          },
        }),
      ]),
    });
    const result = await ensureOrderReservations(container, logger, "order_1");
    expect(result).toEqual({ created: 0, gaps: 1 });
    expect(coreFlows.reservations).toEqual([]);
    expect(logs.some((entry) => entry.startsWith("warn:") && entry.includes("no stock level"))).toBe(
      true,
    );
  });

  it("returns the error rather than throwing when the reservation write fails", async () => {
    // The order stands, the licence work is unaffected, and the next sweep retries. A
    // throw here would hold the event cursor and stall every later Allegro order.
    coreFlows.error = new Error("Not enough stock");
    const { container, logger, logs } = harness({ order: order([managedLine()]) });
    const result = await ensureOrderReservations(container, logger, "order_1");
    expect(result.created).toBe(0);
    expect(result.error).toBe("Not enough stock");
    expect(logs.some((entry) => entry.includes("No stock reservation found"))).toBe(true);
  });

  it("returns the error rather than throwing when the order cannot be read", async () => {
    const { container, logger } = harness({ orderQueryThrows: true });
    const result = await ensureOrderReservations(container, logger, "order_1");
    expect(result.created).toBe(0);
    expect(result.error).toBe("the order could not be read");
  });

  it("does nothing for an order that does not exist", async () => {
    const { container, logger, queries } = harness({});
    expect(await ensureOrderReservations(container, logger, "order_1")).toEqual({
      created: 0,
      gaps: 0,
    });
    // Not even a reservation lookup: there are no line items to look one up for.
    expect(queries).toEqual(["order"]);
  });

  it("ignores an unmanaged line, which core's fulfillment never asks a reservation for", async () => {
    const { container, logger } = harness({
      order: order([
        managedLine({ variant: { inventory_items: [], manage_inventory: false } }),
      ]),
    });
    expect(await ensureOrderReservations(container, logger, "order_1")).toEqual({
      created: 0,
      gaps: 0,
    });
  });
});
