import {
  classifyVariantOffer,
  formatVariantOffer,
  isLiveOfferPrice,
  resolveVariantOffer,
  resolveVariantOfferPrice,
  variantOfferColor,
} from "../variant-offer";
import type { OfferRow } from "../types";

const offer = (overrides: Partial<OfferRow> = {}): OfferRow => ({
  id: overrides.id ?? "off_1",
  offer_id: "12345",
  sku: "SKU-1",
  ...overrides,
});

describe("resolveVariantOffer", () => {
  it("returns null when the variant has no SKU", () => {
    expect(resolveVariantOffer([offer()], null)).toBeNull();
    expect(resolveVariantOffer([offer()], "")).toBeNull();
  });

  it("returns null when the SKU has no offer mapping", () => {
    expect(resolveVariantOffer([], "SKU-1")).toBeNull();
    expect(resolveVariantOffer([offer({ sku: "OTHER" })], "SKU-1")).toBeNull();
  });

  it("picks the row belonging to this variant's SKU, not just the first one", () => {
    const resolved = resolveVariantOffer(
      [offer({ id: "off_1", offer_id: "1", sku: "OTHER" }), offer({ id: "off_2", offer_id: "2", sku: "SKU-1" })],
      "SKU-1",
    );
    expect(resolved?.offerId).toBe("2");
  });

  it("classifies a linked offer with no conflict as listed", () => {
    const resolved = resolveVariantOffer([offer({ conflict: null, offer_id: "12345" })], "SKU-1");
    expect(resolved).toEqual({
      conflict: null,
      offerId: "12345",
      state: "listed",
      status: null,
    });
  });

  it("classifies a mapping row with no live offer id as unlinked", () => {
    const resolved = resolveVariantOffer([offer({ conflict: null, offer_id: null })], "SKU-1");
    expect(resolved?.state).toBe("unlinked");
  });

  it("classifies a conflicted row as a conflict and keeps the code", () => {
    const resolved = resolveVariantOffer(
      [offer({ conflict: "duplicate-sku", offer_id: "12345" })],
      "SKU-1",
    );
    expect(resolved?.state).toBe("conflict");
    expect(resolved?.conflict).toBe("duplicate-sku");
  });

  it("classifies automation drift, and lets a conflict outrank it", () => {
    expect(
      resolveVariantOffer([offer({ conflict: null, price_automation_drift: true })], "SKU-1")
        ?.state,
    ).toBe("drift");
    expect(
      resolveVariantOffer(
        [offer({ conflict: "no-offer", price_automation_drift: true })],
        "SKU-1",
      )?.state,
    ).toBe("conflict");
  });

  it("never reports a count - a row is one variant with at most one offer", () => {
    const resolved = resolveVariantOffer([offer()], "SKU-1");
    expect(resolved).not.toHaveProperty("total");
    expect(resolved).not.toHaveProperty("conflicts");
  });
});

describe("formatVariantOffer", () => {
  it("names the conflict for this SKU rather than counting conflicts", () => {
    expect(
      formatVariantOffer({ conflict: "duplicate-sku", offerId: "1", state: "conflict", status: null }),
    ).toBe("duplicate-sku");
  });

  it("falls back to a generic label if a conflict row somehow has no code", () => {
    expect(
      formatVariantOffer({ conflict: null, offerId: "1", state: "conflict", status: null }),
    ).toBe("conflict");
  });

  it("labels drift and unlinked plainly", () => {
    expect(formatVariantOffer({ conflict: null, offerId: "1", state: "drift", status: null })).toBe(
      "drift",
    );
    expect(
      formatVariantOffer({ conflict: null, offerId: null, state: "unlinked", status: null }),
    ).toBe("unlinked");
  });

  it("shows Allegro's own status for a listed offer when there is one", () => {
    expect(
      formatVariantOffer({ conflict: null, offerId: "1", state: "listed", status: "ACTIVE" }),
    ).toBe("active");
    expect(formatVariantOffer({ conflict: null, offerId: "1", state: "listed", status: null })).toBe(
      "listed",
    );
  });
});

describe("variantOfferColor", () => {
  it("maps each state to its badge colour", () => {
    const at = (state: "conflict" | "drift" | "listed" | "unlinked") =>
      variantOfferColor({ conflict: null, offerId: null, state, status: null });
    expect(at("conflict")).toBe("red");
    expect(at("drift")).toBe("orange");
    expect(at("unlinked")).toBe("grey");
    expect(at("listed")).toBe("green");
  });
});

describe("resolveVariantOfferPrice", () => {
  it("reads the decimal STRING Allegro stores, not a BigNumber", () => {
    // `allegro_offer.price_amount` is `model.text()` holding what the
    // marketplace returned verbatim. It has no `numeric` accessor and no raw
    // `{ value }` wrapper, and reading it as though it did is how a price
    // silently becomes 0.
    expect(
      resolveVariantOfferPrice(offer({ price_amount: "365.31", price_currency: "PLN" })),
    ).toEqual({
      amount: 365.31,
      currency: "PLN",
      priceMode: null,
      promoted: null,
    });
  });

  it("keeps the currency, uppercased, and the mode and promotion that qualify the number", () => {
    expect(
      resolveVariantOfferPrice(
        offer({
          price_amount: "99.00",
          price_currency: "pln",
          price_mode: "automated",
          promoted: true,
        }),
      ),
    ).toEqual({ amount: 99, currency: "PLN", priceMode: "automated", promoted: true });
  });

  it("returns null for an offer with no price, and for no offer at all", () => {
    expect(resolveVariantOfferPrice(null)).toBeNull();
    expect(resolveVariantOfferPrice(offer({ price_amount: null }))).toBeNull();
    expect(resolveVariantOfferPrice(offer({ price_amount: "" }))).toBeNull();
  });

  it("returns null, never a truncated number, for a malformed amount", () => {
    // `Number.parseFloat("365,31")` is 365: it stops at the comma and drops the
    // grosze, turning a broken field into a plausible price.
    expect(resolveVariantOfferPrice(offer({ price_amount: "365,31" }))).toBeNull();
    expect(resolveVariantOfferPrice(offer({ price_amount: "365.31 PLN" }))).toBeNull();
    expect(resolveVariantOfferPrice(offer({ price_amount: "n/a" }))).toBeNull();
  });

  it("reads a zero price as zero rather than as missing", () => {
    expect(resolveVariantOfferPrice(offer({ price_amount: "0" }))?.amount).toBe(0);
  });

  it("leaves the currency null when Allegro did not report one", () => {
    expect(resolveVariantOfferPrice(offer({ price_amount: "10", price_currency: null }))?.currency)
      .toBeNull();
  });
});

describe("isLiveOfferPrice", () => {
  const price = (priceMode: string | null) => ({
    amount: 10,
    currency: "PLN",
    priceMode,
    promoted: null,
  });

  it("treats an automated or fixed price as one a buyer can act on", () => {
    expect(isLiveOfferPrice(price("automated"))).toBe(true);
    expect(isLiveOfferPrice(price("fixed"))).toBe(true);
    expect(isLiveOfferPrice(price("unknown"))).toBe(true);
    expect(isLiveOfferPrice(price(null))).toBe(true);
  });

  it("treats a paused or ended offer's last price as not live", () => {
    // The figure is real, but nobody can buy at it. Rendering it the same way
    // as a live price would read as current.
    expect(isLiveOfferPrice(price("paused"))).toBe(false);
    expect(isLiveOfferPrice(price("ended"))).toBe(false);
  });
});

describe("classifyVariantOffer", () => {
  it("classifies an already-selected row, matching resolveVariantOffer", () => {
    const row = offer({ conflict: "duplicate-sku", offer_id: "1" });
    expect(classifyVariantOffer(row)).toEqual(resolveVariantOffer([row], "SKU-1"));
  });

  it("returns null for no row", () => {
    expect(classifyVariantOffer(null)).toBeNull();
  });
});
