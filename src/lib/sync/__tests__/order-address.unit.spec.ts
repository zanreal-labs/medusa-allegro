import { isUsableAddress, planOrderAddressRepair } from "../order-address";

const full = { address_1: "Jagiellońska 4", city: "Zielonka", postal_code: "05-220" };
const NEITHER = { hasBillingAddress: false, hasShippingAddress: false };
const BOTH = { hasBillingAddress: true, hasShippingAddress: true };

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
      { hasBillingAddress: true, hasShippingAddress: false },
    );

    expect(plan.kind === "write" && plan.fields).toEqual(["shipping_address"]);
    expect(plan.kind === "write" && plan.patch.billing_address).toBeUndefined();
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
