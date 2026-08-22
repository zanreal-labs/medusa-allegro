import { planOrderReservations, readQuantity } from "../order-reservations";
import type {
  ExistingReservationView,
  InventoryLevelView,
  OrderLineView,
} from "../order-reservations";

/**
 * The reservation planner.
 *
 * The properties under test are the three the production incident needs: a plan is
 * idempotent (an order already reserved plans nothing, which is what makes the
 * reconciliation sweep able to run it forever), it never reserves more than the order
 * still owes, and a line with nowhere to hold stock is REPORTED rather than thrown -
 * because an unreservable line must not lose the sale.
 */

const level = (over: Partial<InventoryLevelView> = {}): InventoryLevelView => ({
  available: 10,
  locationId: "sloc_1",
  salesChannelIds: ["sc_allegro"],
  ...over,
});

const line = (over: Partial<OrderLineView> = {}): OrderLineView => ({
  allowBackorder: false,
  fulfilledQuantity: 0,
  id: "ordli_1",
  inventoryItems: [{ inventoryItemId: "iitem_1", levels: [level()], requiredQuantity: 1 }],
  manageInventory: true,
  quantity: 2,
  title: "A licence",
  ...over,
});

const plan = (lines: OrderLineView[], existing: ExistingReservationView[] = [], salesChannelId?: string) =>
  planOrderReservations({
    existing,
    lines,
    orderId: "order_1",
    ...(salesChannelId ? { salesChannelId } : {}),
  });

describe("readQuantity", () => {
  it("reads a Medusa BigNumber instance, the shape query.graph actually returns", () => {
    // The same object shape `parseAmount` was taught to read after it turned a real order
    // total into "unreadable". A quantity arrives identically.
    expect(readQuantity({ numeric: 3, raw: { value: "3" } })).toBe(3);
    expect(readQuantity({ value: "2", precision: 20 } as never)).toBe(2);
  });

  it("treats an unreadable quantity as zero rather than one", () => {
    // Reserving a unit against a quantity nobody could read holds stock for an order
    // that never asked for it. Zero plans nothing, which is the recoverable direction.
    expect(readQuantity(undefined)).toBe(0);
    expect(readQuantity("not a number")).toBe(0);
    expect(readQuantity(-1)).toBe(0);
  });
});

describe("planOrderReservations", () => {
  it("reserves the ordered quantity for a managed line with no reservation yet", () => {
    const { create, gaps } = plan([line()]);
    expect(gaps).toEqual([]);
    expect(create).toEqual([
      {
        allow_backorder: false,
        description: "Allegro order order_1",
        inventory_item_id: "iitem_1",
        line_item_id: "ordli_1",
        location_id: "sloc_1",
        quantity: 2,
      },
    ]);
  });

  it("plans nothing when the line is already fully reserved", () => {
    // Idempotency, and the reason the reconciliation sweep can call this on every pass:
    // a healthy order writes nothing at all.
    const { create } = plan(
      [line()],
      [{ inventoryItemId: "iitem_1", lineItemId: "ordli_1", quantity: 2 }],
    );
    expect(create).toEqual([]);
  });

  it("tops up only the shortfall when a partial reservation exists", () => {
    const { create } = plan(
      [line({ quantity: 5 })],
      [{ inventoryItemId: "iitem_1", lineItemId: "ordli_1", quantity: 2 }],
    );
    expect(create).toHaveLength(1);
    expect(create[0]?.quantity).toBe(3);
  });

  it("subtracts the already-fulfilled units", () => {
    // Fulfilled units have already consumed their reservation - core deletes or shrinks it
    // as it fulfils - so reserving against them again would hold stock that has shipped.
    const { create } = plan([line({ fulfilledQuantity: 1, quantity: 3 })]);
    expect(create[0]?.quantity).toBe(2);
  });

  it("plans nothing for a fully fulfilled line", () => {
    expect(plan([line({ fulfilledQuantity: 2, quantity: 2 })]).create).toEqual([]);
  });

  it("ignores a line whose variant does not manage inventory", () => {
    // Core's fulfillment never demands a reservation for one, so creating it would hold
    // stock nobody is tracking.
    const { create, gaps } = plan([line({ manageInventory: false })]);
    expect(create).toEqual([]);
    expect(gaps).toEqual([]);
  });

  it("multiplies by the inventory item's required quantity", () => {
    const { create } = plan([
      line({
        inventoryItems: [
          { inventoryItemId: "iitem_1", levels: [level()], requiredQuantity: 3 },
        ],
        quantity: 2,
      }),
    ]);
    expect(create[0]?.quantity).toBe(6);
  });

  it("reserves every inventory item behind a bundle variant", () => {
    const { create } = plan([
      line({
        inventoryItems: [
          { inventoryItemId: "iitem_1", levels: [level()], requiredQuantity: 1 },
          { inventoryItemId: "iitem_2", levels: [level({ locationId: "sloc_2" })], requiredQuantity: 1 },
        ],
        quantity: 1,
      }),
    ]);
    expect(create.map((row) => [row.inventory_item_id, row.location_id])).toEqual([
      ["iitem_1", "sloc_1"],
      ["iitem_2", "sloc_2"],
    ]);
  });

  it("prefers a location the order's sales channel actually serves", () => {
    // A reservation at a location the channel does not serve holds stock without
    // protecting the sale: no availability calculation the storefront makes can see it.
    const { create } = plan(
      [
        line({
          inventoryItems: [
            {
              inventoryItemId: "iitem_1",
              levels: [
                level({ locationId: "sloc_other", salesChannelIds: ["sc_web"] }),
                level({ locationId: "sloc_allegro", salesChannelIds: ["sc_allegro"] }),
              ],
              requiredQuantity: 1,
            },
          ],
        }),
      ],
      [],
      "sc_allegro",
    );
    expect(create[0]?.location_id).toBe("sloc_allegro");
  });

  it("falls back to a location with stock when the channel's own has none", () => {
    const { create } = plan(
      [
        line({
          inventoryItems: [
            {
              inventoryItemId: "iitem_1",
              levels: [
                level({ available: 0, locationId: "sloc_allegro", salesChannelIds: ["sc_allegro"] }),
                level({ available: 9, locationId: "sloc_warehouse", salesChannelIds: ["sc_web"] }),
              ],
              requiredQuantity: 1,
            },
          ],
        }),
      ],
      [],
      "sc_allegro",
    );
    expect(create[0]?.location_id).toBe("sloc_warehouse");
  });

  it("still reserves at a level with too little stock rather than refusing the line", () => {
    // The sale already happened on Allegro. An oversold level is a stock problem for a
    // human; refusing to record where the stock is does not fix it and leaves the order
    // unfulfillable on top.
    const { create, gaps } = plan([
      line({
        inventoryItems: [
          { inventoryItemId: "iitem_1", levels: [level({ available: 0 })], requiredQuantity: 1 },
        ],
      }),
    ]);
    expect(gaps).toEqual([]);
    expect(create[0]?.location_id).toBe("sloc_1");
  });

  it("reports - and does not throw on - an inventory item stocked nowhere", () => {
    const { create, gaps } = plan([
      line({
        inventoryItems: [{ inventoryItemId: "iitem_1", levels: [], requiredQuantity: 1 }],
      }),
    ]);
    expect(create).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.lineItemId).toBe("ordli_1");
    expect(gaps[0]?.reason).toContain("no stock level at any location");
  });

  it("reports a managed variant that has no inventory item at all", () => {
    const { create, gaps } = plan([line({ inventoryItems: [] })]);
    expect(create).toEqual([]);
    expect(gaps[0]?.reason).toContain("no inventory item");
  });

  it("keeps planning the other lines around an unreservable one", () => {
    // The whole point of reporting rather than throwing: one broken catalogue row must
    // not cost the rest of the order its reservations.
    const { create, gaps } = plan([
      line({ id: "ordli_bad", inventoryItems: [], title: "Broken" }),
      line({ id: "ordli_good" }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(create.map((row) => row.line_item_id)).toEqual(["ordli_good"]);
  });

  it("carries the line's backorder flag onto the reservation", () => {
    const { create } = plan([line({ allowBackorder: true })]);
    expect(create[0]?.allow_backorder).toBe(true);
  });

  it("does not confuse two lines that share an inventory item", () => {
    // The subtraction is per LINE as well as per inventory item. Keying only on the
    // inventory item would let one line's reservation satisfy another's need, and the
    // second line would then fail fulfillment with the very error this fixes.
    const { create } = plan(
      [line({ id: "ordli_1", quantity: 1 }), line({ id: "ordli_2", quantity: 1 })],
      [{ inventoryItemId: "iitem_1", lineItemId: "ordli_1", quantity: 1 }],
    );
    expect(create).toHaveLength(1);
    expect(create[0]?.line_item_id).toBe("ordli_2");
  });
});
