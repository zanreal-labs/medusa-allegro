import { repairOrderAddresses } from "../order-address";
import type { OrderAddressPlan } from "../../../lib/sync/order-address";

const ADDRESS = { address_1: "Jagiellońska 4", city: "Zielonka", country_code: "pl", postal_code: "05-220" };

const writePlan: OrderAddressPlan = {
  fields: ["shipping_address"],
  kind: "write",
  patch: { shipping_address: ADDRESS },
};

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

const harness = (order: Record<string, unknown> | undefined, updateImpl?: () => Promise<unknown>) => {
  const updateOrders = jest.fn(updateImpl ?? (async () => undefined));
  const listOrders = jest.fn(async () => (order ? [order] : []));
  const container = {
    resolve: jest.fn(() => ({ listOrders, updateOrders })),
  } as never;
  return { container, listOrders, updateOrders };
};

describe("repairOrderAddresses", () => {
  it("writes through the order module, not a workflow", async () => {
    const h = harness({ id: "order_1" });
    const log = logger();

    const result = await repairOrderAddresses(h.container, log as never, "order_1", writePlan);

    expect(result.repaired).toBe(true);
    expect(h.updateOrders).toHaveBeenCalledWith([{ id: "order_1", shipping_address: ADDRESS }]);
  });

  it("keeps the country code, which selects the VAT regime", async () => {
    // Omitting it would satisfy the workflow guard we are stepping around, and
    // would put an address with no country under a document that makes a tax
    // decision from it.
    const h = harness({ id: "order_1" });
    await repairOrderAddresses(h.container, logger() as never, "order_1", writePlan);

    const [[[patch]]] = h.updateOrders.mock.calls as unknown as [[[Record<string, never>]]];
    expect((patch.shipping_address as unknown as typeof ADDRESS).country_code).toBe("pl");
  });

  it("REFUSES to overwrite a COMPLETE address that appeared since planning", async () => {
    // The bypass removed the only downstream guard, so this re-check is the sole
    // thing between a repair and an overwrite. It must not depend on the caller
    // having planned correctly.
    const h = harness({ id: "order_1", shipping_address: { id: "addr_1", ...ADDRESS } });
    const log = logger();

    const result = await repairOrderAddresses(h.container, log as never, "order_1", writePlan);

    expect(result.repaired).toBe(false);
    expect(h.updateOrders).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("refusing to fill"));
  });

  it("fills the blanks of a PARTIAL address instead of refusing it", async () => {
    // The refusal used to be "a row exists", which is what an order created from an
    // unfinished checkout form has: a name and a country and no street, city or postal
    // code. Refusing on the row meant those three were never written, on any pass.
    const h = harness({
      id: "order_1",
      shipping_address: { country_code: "pl", first_name: "Jan", id: "addr_1" },
    });

    const result = await repairOrderAddresses(h.container, logger() as never, "order_1", writePlan);

    expect(result.repaired).toBe(true);
    expect(h.updateOrders).toHaveBeenCalledWith([
      { id: "order_1", shipping_address: { ...ADDRESS, first_name: "Jan" } },
    ]);
  });

  it("never overwrites a field the partial address already had", async () => {
    // Gap only, one field at a time, re-checked against the freshest read rather than
    // against the caller's plan.
    const h = harness({
      id: "order_1",
      shipping_address: { city: "Somewhere a human typed", id: "addr_1" },
    });

    await repairOrderAddresses(h.container, logger() as never, "order_1", writePlan);

    const [[[patch]]] = h.updateOrders.mock.calls as unknown as [[[Record<string, never>]]];
    expect((patch.shipping_address as unknown as typeof ADDRESS).city).toBe(
      "Somewhere a human typed",
    );
  });

  it("refuses the complete side and still fills the missing one", async () => {
    // Per side, not per plan. Refusing the whole write because ONE side was already
    // complete would leave the other absent for another pass.
    const h = harness({ id: "order_1", shipping_address: { id: "addr_1", ...ADDRESS } });

    const result = await repairOrderAddresses(h.container, logger() as never, "order_1", {
      fields: ["shipping_address", "billing_address"],
      kind: "write",
      patch: { billing_address: ADDRESS, shipping_address: ADDRESS },
    });

    expect(result.repaired).toBe(true);
    expect(h.updateOrders).toHaveBeenCalledWith([{ billing_address: ADDRESS, id: "order_1" }]);
  });

  it("is never fatal, even when resolving the module throws", async () => {
    // Documented as never fatal, and the resolve is inside the try for that
    // reason: a repair that cannot happen must leave the order where it was, not
    // take down the drain pass around it.
    const container = {
      resolve: () => {
        throw new Error("module not registered");
      },
    } as never;

    await expect(
      repairOrderAddresses(container, logger() as never, "order_1", writePlan),
    ).resolves.toMatchObject({ repaired: false });
  });

  it("renders a non-Error rejection as something actionable", async () => {
    const h = harness({ id: "order_1" }, async () => {
      throw { code: "invalid_data", message: "Country code cannot be changed" };
    });
    const log = logger();

    await repairOrderAddresses(h.container, log as never, "order_1", writePlan);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Country code cannot be changed"));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("[object Object]"));
  });

  it("does nothing at all for a skip plan", async () => {
    const h = harness({ id: "order_1" });
    const result = await repairOrderAddresses(h.container, logger() as never, "order_1", {
      kind: "skip",
      reason: "the order already has both addresses",
    });

    expect(result.repaired).toBe(false);
    expect(h.updateOrders).not.toHaveBeenCalled();
  });
});
