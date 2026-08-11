import { EMPHASIZED_PACKAGE_IDS, resolveOfferPromotion } from "../promo";

describe("resolveOfferPromotion", () => {
  it("reads an emphasized base package as promoted", () => {
    expect(resolveOfferPromotion({ basePackage: { id: "emphasized1d" } })).toBe(true);
    expect(resolveOfferPromotion({ basePackage: { id: "emphasized10d" } })).toBe(true);
    expect(resolveOfferPromotion({ basePackage: { id: "promoPackage" } })).toBe(true);
  });

  it("reads an emphasized extra package as promoted", () => {
    expect(
      resolveOfferPromotion({
        basePackage: { id: "base" },
        extraPackages: [{ id: "emphasized10d" }],
      }),
    ).toBe(true);
  });

  it("is not promoted for a package that is not emphasized", () => {
    expect(resolveOfferPromotion({ basePackage: { id: "base" } })).toBe(false);
  });

  it("is not promoted for an offer with no packages at all", () => {
    // This is what clears a stale promoted flag: an offer absent from the sweep's
    // response carries no packages.
    expect(resolveOfferPromotion({})).toBe(false);
  });

  it("is not promoted for an absent payload", () => {
    expect(resolveOfferPromotion()).toBe(false);
  });

  it("tolerates a package with no id", () => {
    expect(resolveOfferPromotion({ basePackage: {}, extraPackages: [{}] })).toBe(false);
  });

  it("pins the emphasized package ids", () => {
    // These select the promoted commission rate, which sets the price floor. A
    // silent change here silently mis-floors the whole promoted catalogue.
    expect([...EMPHASIZED_PACKAGE_IDS].toSorted()).toEqual([
      "emphasized10d",
      "emphasized1d",
      "promoPackage",
    ]);
  });
});
