import {
  auctionsPl,
  BLOCK_REASON_PL,
  labelFor,
  movesHeadline,
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
    expect(movesHeadline(1)).toBe("Zmieni 1 aukcję. Reszta katalogu zostaje bez zmian.");
    expect(movesHeadline(3)).toBe("Zmieni 3 aukcje. Reszta katalogu zostaje bez zmian.");
    expect(movesHeadline(0)).toBe("Zmieni 0 aukcji. Reszta katalogu zostaje bez zmian.");
  });
});

describe("labelFor", () => {
  it("returns the Polish label for a known code", () => {
    expect(labelFor(SKIP_REASON_PL, "missing-srp")).toBe("brak SRP, czyli górnego limitu ceny");
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
