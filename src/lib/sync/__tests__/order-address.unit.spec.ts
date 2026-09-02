import {
  fillAddressGaps,
  isUsableAddress,
  planOrderAddressRepair,
  readAddressFields,
} from "../order-address";

const full = { address_1: "Jagiellońska 4", city: "Zielonka", postal_code: "05-220" };
const NEITHER = {};
const BOTH = { billingAddress: full, shippingAddress: full };
/**
 * What an order created from an unfinished checkout form actually carries.
 *
 * `orUndefined` in `checkout-form` returns an address when ANY field is truthy, and
 * `createMedusaOrder` passes it through ungated - so a form that had only reached the
 * buyer's name and country creates THIS, and it is a billing address row that no
 * invoice can be built from.
 */
const partial = { country_code: "pl", first_name: "Jan" };

describe("isUsableAddress", () => {
  it("wants the three fields the invoice builder demands", () => {
    expect(isUsableAddress(full)).toBe(true);
    expect(isUsableAddress({ ...full, address_1: undefined })).toBe(false);
    expect(isUsableAddress({ ...full, city: undefined })).toBe(false);
    expect(isUsableAddress({ ...full, postal_code: undefined })).toBe(false);
  });

  it("treats whitespace as absent", () => {
    expect(isUsableAddress({ ...full, city: "  " })).toBe(false);
  });

  it("is false for no address at all", () => {
    expect(isUsableAddress(undefined)).toBe(false);
  });
});

describe("readAddressFields", () => {
  it("takes the address fields off a row that carries much more", () => {
    // The query graph hands back an id, timestamps and an `order_id` alongside the
    // address, and spreading those into an order write would send the module fields it
    // never asked for.
    expect(
      readAddressFields({
        city: "Zielonka",
        created_at: "2026-09-02T12:32:20.000Z",
        id: "ordaddr_1",
        metadata: null,
        order_id: "order_1",
      }),
    ).toEqual({ city: "Zielonka" });
  });

  it("is undefined for an order with no address there at all", () => {
    expect(readAddressFields(null)).toBeUndefined();
  });

  it("drops blanks, so a whitespace column is not mistaken for a value", () => {
    expect(readAddressFields({ city: "   ", postal_code: "05-220" })).toEqual({
      postal_code: "05-220",
    });
  });
});

describe("fillAddressGaps", () => {
  it("keeps what the order holds and fills only its blanks", () => {
    expect(
      fillAddressGaps({ company: "Ours", first_name: "Jan" }, { ...full, company: "Allegro's" }),
    ).toEqual({ ...full, company: "Ours", first_name: "Jan" });
  });

  it("is the candidate verbatim when the order has no address at all", () => {
    expect(fillAddressGaps(undefined, full)).toEqual(full);
  });

  it("never carries a field that is neither side's", () => {
    // Named fields rather than a walk over whatever the row happened to contain: an
    // `id` or an `order_id` merged into an address write is a field the order module
    // never asked for.
    expect(Object.keys(fillAddressGaps({ city: "Zielonka" }, { address_1: "X" }))).toEqual([
      "address_1",
      "city",
    ]);
  });
});

describe("planOrderAddressRepair", () => {
  it("fills both when the order has neither", () => {
    const plan = planOrderAddressRepair({ billingAddress: full, shippingAddress: full }, NEITHER);

    expect(plan.kind).toBe("write");
    expect(plan.kind === "write" && plan.fields).toEqual(["shipping_address", "billing_address"]);
  });

  it("NEVER overwrites an address the order already has", () => {
    // The property that matters most. A human may have corrected it, and reverting a
    // corrected invoice address to the marketplace's copy is worse than the gap.
    const plan = planOrderAddressRepair(
      { billingAddress: { ...full, city: "Somewhere else" }, shippingAddress: full },
      BOTH,
    );

    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" && plan.reason).toMatch(/already has both/u);
  });

  it("fills only the one that is absent", () => {
    const plan = planOrderAddressRepair(
      { billingAddress: full, shippingAddress: full },
      { billingAddress: full },
    );

    expect(plan.kind === "write" && plan.fields).toEqual(["shipping_address"]);
    expect(plan.kind === "write" && plan.patch.billing_address).toBeUndefined();
  });

  it("treats a PARTIAL billing address as a gap, not as an address", () => {
    // The latch this planner used to have. `snapshot.hasBillingAddress` read only
    // `billing_address.id`, so a row with a name and a country and no street read as
    // "the order already has both addresses" on every one of the ~20s passes - and the
    // street, city and postal code were never filled in, on any of them. The orders
    // that most needed the repair were the exact ones it refused.
    const plan = planOrderAddressRepair(
      { billingAddress: full, shippingAddress: full },
      { billingAddress: partial, shippingAddress: full },
    );

    expect(plan.kind === "write" && plan.fields).toEqual(["billing_address"]);
    expect(plan.kind === "write" && plan.patch.billing_address).toMatchObject({
      address_1: "Jagiellońska 4",
      city: "Zielonka",
      postal_code: "05-220",
    });
  });

  it("keeps every value the partial address already carried", () => {
    // Gap only, one field at a time. Writing Allegro's copy wholesale over a partial
    // row would revert a name or a company a human had corrected, on an order whose
    // only real problem was a missing street.
    const plan = planOrderAddressRepair(
      { billingAddress: { ...full, first_name: "Allegro's copy" } },
      { billingAddress: partial },
    );

    expect(plan.kind === "write" && plan.patch.billing_address).toMatchObject({
      country_code: "pl",
      first_name: "Jan",
    });
  });

  it("completes an address neither side could complete alone", () => {
    // The order holds a city, Allegro holds the street and the postal code. Testing
    // usability on either half alone would leave the order uninvoiceable over an
    // address that is, merged, perfectly complete.
    const plan = planOrderAddressRepair(
      { billingAddress: { address_1: "Jagiellońska 4", postal_code: "05-220" } },
      { billingAddress: { city: "Zielonka" } },
    );

    expect(plan.kind === "write" && plan.patch.billing_address).toMatchObject({
      address_1: "Jagiellońska 4",
      city: "Zielonka",
      postal_code: "05-220",
    });
  });

  it("refuses a partial address rather than writing half of one", () => {
    // Half an address on an invoice is wrong AND looks right, which is worse than an
    // absent one that parks the invoice loudly.
    const plan = planOrderAddressRepair(
      { shippingAddress: { ...full, postal_code: undefined } },
      NEITHER,
    );

    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" && plan.reason).toMatch(/street, a city and a postal code/u);
  });

  it("distinguishes 'nothing to write' from 'already complete'", () => {
    // They need different actions: one is fine, the other means Allegro still has
    // nothing usable and the order stays uninvoiceable.
    const nothing = planOrderAddressRepair({}, NEITHER);
    const complete = planOrderAddressRepair({ shippingAddress: full }, BOTH);

    expect(nothing.kind === "skip" && nothing.reason).not.toBe(
      complete.kind === "skip" && complete.reason,
    );
  });

  it("reproduces order #49: created with no address, form completed later", () => {
    const plan = planOrderAddressRepair({ shippingAddress: full }, NEITHER);

    expect(plan.kind === "write" && plan.fields).toEqual(["shipping_address"]);
    expect(plan.kind === "write" && plan.patch.shipping_address).toEqual(full);
  });
});
