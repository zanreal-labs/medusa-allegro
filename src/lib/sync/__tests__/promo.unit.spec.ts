import { resolveOfferPromoted } from "../../../workflows/lib/offers";
import type { PromoSweepResult } from "../../../workflows/lib/offers";
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

describe("resolveOfferPromoted: a non-ACTIVE offer does not record a hard false", () => {
  const sweep = (over: Partial<PromoSweepResult> = {}): PromoSweepResult => ({
    featureUnavailable: false,
    promotedByOffer: new Map(),
    ...over,
  });

  it("resolves an INACTIVE offer to NULL, not false", () => {
    // A hard `false` outlived the state that justified it. Discovery upserts offers of every
    // status, so an INACTIVE offer had `promoted: false` recorded as a RESOLVED fact - and
    // when the seller re-activated it and bought a promotion, the next run with an unresolved
    // sweep wrote nothing, so the stale `false` survived and was believed. Price sync then
    // floored a promoted offer on the STANDARD commission, below its true break-even, and the
    // monitor read it as drift and switched it onto the standard rule.
    const resolved = resolveOfferPromoted(
      { id: "o1", publication: { status: "INACTIVE" } },
      sweep({ promotedByOffer: null }),
    );

    expect(resolved.promoted).toBeNull();
    expect(resolved.unresolved).toBe(false);
  });

  it("resolves an ENDED offer to NULL even when the sweep says it carries a package", () => {
    // The sweep is not consulted for a non-ACTIVE offer, and that stays true - but the answer
    // is "not established" rather than "not promoted".
    const resolved = resolveOfferPromoted(
      { id: "o1", publication: { status: "ENDED" } },
      sweep({ promotedByOffer: new Map([["o1", true]]) }),
    );

    expect(resolved.promoted).toBeNull();
  });

  it("still resolves an ACTIVE offer from the sweep", () => {
    expect(
      resolveOfferPromoted(
        { id: "o1", publication: { status: "ACTIVE" } },
        sweep({ promotedByOffer: new Map([["o1", true]]) }),
      ),
    ).toEqual({ promoted: true, unresolved: false });
  });

  it("still clears an ACTIVE offer absent from a COMPLETE sweep", () => {
    // The complete map doubles as the "not promoted" signal, which is the one place a hard
    // `false` is a real fact rather than an assumption.
    expect(
      resolveOfferPromoted({ id: "o1", publication: { status: "ACTIVE" } }, sweep()),
    ).toEqual({ promoted: false, unresolved: false });
  });

  it("leaves an ACTIVE offer untouched when the sweep could not be resolved", () => {
    const resolved = resolveOfferPromoted(
      { id: "o1", publication: { status: "ACTIVE" } },
      sweep({ promotedByOffer: null }),
    );
    expect(resolved.promoted).toBeUndefined();
    expect(resolved.unresolved).toBe(true);
  });
});
