import {
  auctionsPl,
  BLOCK_REASON_PL,
  coverageBody,
  labelFor,
  movesHeadline,
  priceFollowsCompetition,
  priceLoweredTo,
  PROMO_COPY,
  SKIP_REASON_PL,
} from "../promotion-preview-copy";

describe("auctionsPl", () => {
  it("uses the singular accusative for exactly one", () => {
    expect(auctionsPl(1)).toBe("aukcję");
  });

  it("uses the 2-4 form for small numbers", () => {
    expect(auctionsPl(2)).toBe("aukcje");
    expect(auctionsPl(3)).toBe("aukcje");
    expect(auctionsPl(4)).toBe("aukcje");
    expect(auctionsPl(22)).toBe("aukcje");
    expect(auctionsPl(104)).toBe("aukcje");
  });

  it("uses the genitive plural for zero, five and up", () => {
    expect(auctionsPl(0)).toBe("aukcji");
    expect(auctionsPl(5)).toBe("aukcji");
    expect(auctionsPl(11)).toBe("aukcji");
    expect(auctionsPl(25)).toBe("aukcji");
  });

  it("treats the teens as the exception the last-digit rule gets wrong", () => {
    // 12 declines like 5, not like 2 - the whole reason this is not a last-digit test.
    expect(auctionsPl(12)).toBe("aukcji");
    expect(auctionsPl(13)).toBe("aukcji");
    expect(auctionsPl(14)).toBe("aukcji");
    // 21 ends in 1 but is not "jedna aukcja".
    expect(auctionsPl(21)).toBe("aukcji");
  });
});

describe("movesHeadline", () => {
  it("declines the count in the headline", () => {
    expect(movesHeadline(1)).toBe("Zmieni cenę na 1 aukcję. Reszta katalogu zostaje bez zmian.");
    expect(movesHeadline(3)).toBe("Zmieni cenę na 3 aukcje. Reszta katalogu zostaje bez zmian.");
    expect(movesHeadline(0)).toBe("Zmieni cenę na 0 aukcji. Reszta katalogu zostaje bez zmian.");
  });
});

describe("labelFor", () => {
  it("returns the Polish label for a known code", () => {
    expect(labelFor(SKIP_REASON_PL, "missing-srp")).toBe("brak ceny SRP, od której liczymy rabat");
    expect(labelFor(BLOCK_REASON_PL, "no-target-products")).toBe(
      "promocja nie obejmuje żadnych produktów",
    );
  });

  it("falls back rather than dropping an unmapped code", () => {
    // An API that adds a reason code must still render something actionable.
    expect(labelFor(SKIP_REASON_PL, "brand-new-code")).toBe("brand-new-code");
    expect(labelFor(BLOCK_REASON_PL, "brand-new-code", "server label")).toBe("server label");
  });
});

describe("operator-facing copy stays about prices, not mechanism", () => {
  it("never leaks rule names, the rule prefix, or attach/switch/override vocabulary", () => {
    // The regression this guards: developer context rendered as UI once read as
    // though the feature had built auction highlighting instead of a price cut.
    const surfaces = [
      ...Object.values(PROMO_COPY),
      ...Object.values(SKIP_REASON_PL),
      ...Object.values(BLOCK_REASON_PL),
      movesHeadline(3),
      coverageBody({ eligible: 1, linked: 2, skipped: 0, targeted: 3 }),
      priceLoweredTo(89.99, "PLN"),
      priceFollowsCompetition(40, "PLN"),
    ].join(" ");
    for (const forbidden of ["ZR\u276F", "Wyr\u00f3\u017cnienie", "Bitdefender", "regu\u0142y cenowej", "nadpisanie", "przelacz"]) {
      expect(surfaces).not.toContain(forbidden);
    }
  });
});
