import { classifyVariantMargin, isMarginGap } from "../variant-margin";
import type { OfferRow } from "../types";

const offer = (economics?: OfferRow["economics"]): OfferRow => ({
  economics,
  id: "algoffer_1",
  sku: "SKU-1",
});

describe("classifyVariantMargin", () => {
  it("resolves a margin measured on the live Allegro price", () => {
    const margin = classifyVariantMargin(
      offer({
        commission_amount: 36.53,
        commission_rate: 0.1,
        cost_gross: 123,
        currency: "PLN",
        margin_amount: 205.78,
        margin_pct: 0.5632,
        net_cost: 100,
        selling_price: 365.31,
      }),
    );
    expect(margin).toEqual({
      amount: 205.78,
      commissionAmount: 36.53,
      commissionRate: 0.1,
      costGross: 123,
      currency: "PLN",
      pct: 0.5632,
      sellingPrice: 365.31,
      state: "resolved",
    });
  });

  it("reports an unmapped SKU as no-offer, which is not a gap to fix", () => {
    // Listing on Allegro is manual at this store, so most of the catalogue is
    // legitimately unmapped. It must not shout.
    const margin = classifyVariantMargin(null);
    expect(margin).toEqual({ state: "no-offer" });
    expect(isMarginGap(margin)).toBe(false);
  });

  it("reports a mapped offer with no observed price as no-price", () => {
    expect(classifyVariantMargin(offer({ currency: "PLN" }))).toEqual({ state: "no-price" });
  });

  it("treats a row fetched without economics=1 as no-price rather than a blank margin", () => {
    // A caller that forgot the flag should see a gap, not a confident nothing.
    expect(classifyVariantMargin(offer())).toEqual({ state: "no-price" });
    expect(classifyVariantMargin(offer(null))).toEqual({ state: "no-price" });
  });

  it("names a missing purchase cost before a missing commission", () => {
    // Filling in a category rate would not help a SKU nobody has costed.
    expect(
      classifyVariantMargin(offer({ commission_rate: 0.1, selling_price: 100 })),
    ).toEqual({ state: "no-cost" });
  });

  it("reports an unknown commission rather than reading it as zero", () => {
    // A commission of "unknown" read as 0% overstates what the offer earns, and
    // this is a number the owner prices against.
    const margin = classifyVariantMargin(offer({ net_cost: 50, selling_price: 100 }));
    expect(margin).toEqual({ state: "no-commission" });
    expect(isMarginGap(margin)).toBe(true);
  });

  it("falls back to no-cost when every input was present but no figure came back", () => {
    // In practice a costs plugin with no VAT rate configured.
    expect(
      classifyVariantMargin(
        offer({ commission_rate: 0.1, net_cost: 50, selling_price: 100 }),
      ),
    ).toEqual({ state: "no-cost" });
  });

  it("carries a negative margin through rather than hiding a loss", () => {
    const margin = classifyVariantMargin(
      offer({
        commission_rate: 0.1,
        currency: "PLN",
        margin_amount: -12.5,
        margin_pct: -0.125,
        net_cost: 90,
        selling_price: 100,
      }),
    );
    expect(margin).toMatchObject({ amount: -12.5, state: "resolved" });
  });

  it("flags every unresolved state except an unmapped SKU as a gap", () => {
    expect(isMarginGap({ state: "no-price" })).toBe(true);
    expect(isMarginGap({ state: "no-cost" })).toBe(true);
    expect(isMarginGap({ state: "no-commission" })).toBe(true);
    expect(isMarginGap({ state: "no-offer" })).toBe(false);
  });
});
