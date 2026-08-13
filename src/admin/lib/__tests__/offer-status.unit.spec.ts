import { formatOfferStatus, summarizeOfferStatus } from "../offer-status";
import type { OfferRow } from "../types";

const offer = (overrides: Partial<OfferRow> = {}): OfferRow => ({
  id: overrides.id ?? "off_1",
  offer_id: "12345",
  sku: "SKU-1",
  ...overrides,
});

describe("summarizeOfferStatus", () => {
  it("returns zeros for no offers", () => {
    expect(summarizeOfferStatus([])).toEqual({ conflicts: 0, linked: 0, total: 0 });
  });

  it("counts a linked offer with no conflict as linked", () => {
    const summary = summarizeOfferStatus([offer({ conflict: null, offer_id: "12345" })]);
    expect(summary).toEqual({ conflicts: 0, linked: 1, total: 1 });
  });

  it("counts an offer carrying a conflict as a conflict, not linked", () => {
    const summary = summarizeOfferStatus([
      offer({ conflict: "duplicate-sku", offer_id: "12345" }),
    ]);
    expect(summary).toEqual({ conflicts: 1, linked: 0, total: 1 });
  });

  it("counts a mapping row with no live offer id as neither linked nor conflicted", () => {
    const summary = summarizeOfferStatus([offer({ conflict: null, offer_id: null })]);
    expect(summary).toEqual({ conflicts: 0, linked: 0, total: 1 });
  });

  it("aggregates several variants' offers to the product level", () => {
    const summary = summarizeOfferStatus([
      offer({ conflict: null, id: "off_1", offer_id: "1" }),
      offer({ conflict: null, id: "off_2", offer_id: "2" }),
      offer({ conflict: "no-offer", id: "off_3", offer_id: null }),
    ]);
    expect(summary).toEqual({ conflicts: 1, linked: 2, total: 3 });
  });
});

describe("formatOfferStatus", () => {
  it("formats a clean summary with just the offer count", () => {
    expect(formatOfferStatus({ conflicts: 0, linked: 2, total: 2 })).toBe("2 offers");
  });

  it("uses the singular for exactly one offer", () => {
    expect(formatOfferStatus({ conflicts: 0, linked: 1, total: 1 })).toBe("1 offer");
  });

  it("appends the conflict count when there is one, matching the kit's example", () => {
    expect(formatOfferStatus({ conflicts: 1, linked: 2, total: 3 })).toBe("3 offers / 1 conflict");
  });

  it("pluralizes the conflict count", () => {
    expect(formatOfferStatus({ conflicts: 2, linked: 1, total: 3 })).toBe("3 offers / 2 conflicts");
  });
});
