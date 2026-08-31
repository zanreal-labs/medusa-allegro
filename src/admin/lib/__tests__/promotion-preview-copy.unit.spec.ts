import {
  auctionsPl,
  BLOCK_REASON_PL,
  coverageBody,
  labelFor,
  movesHeadline,
  marginLabel,
  PROMO_COPY,
  THIN_MARGIN_PCT,
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
    expect(movesHeadline(1)).toBe("Zmieni cenę na 1 aukcję.");
    expect(movesHeadline(3)).toBe("Zmieni cenę na 3 aukcje.");
    expect(movesHeadline(0)).toBe("Zmieni cenę na 0 aukcji.");
  });
});

describe("labelFor", () => {
  it("returns the Polish label for a known code", () => {
    expect(labelFor(SKIP_REASON_PL, "missing-srp")).toBe("Uzupełnij cenę SRP.");
    expect(labelFor(BLOCK_REASON_PL, "no-target-products")).toBe(
      "Dodaj produkty do tej promocji.",
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
      marginLabel(12.4, 0.13, "PLN"),
    ].join(" ");
    for (const forbidden of ["ZR\u276F", "Wyr\u00f3\u017cnienie", "Bitdefender", "regu\u0142y cenowej", "nadpisanie", "przelacz"]) {
      expect(surfaces).not.toContain(forbidden);
    }
  });
});

describe("messages are short and actionable", () => {
  it("every blocker says what to do, in one line", () => {
    // Reported as a list of offenders rather than one bare assertion, so a failure
    // names the string that grew instead of only the line number.
    const tooLong = Object.entries(BLOCK_REASON_PL).filter(([, text]) => text.length > 70);
    expect(tooLong).toEqual([]);
    const multiSentence = Object.entries(BLOCK_REASON_PL).filter(
      ([, text]) => text.split(". ").length > 1,
    );
    expect(multiSentence).toEqual([]);
  });

  it("keeps per-SKU skip reasons to one short line too", () => {
    const tooLong = Object.entries(SKIP_REASON_PL).filter(([, text]) => text.length > 70);
    expect(tooLong).toEqual([]);
  });
});

describe("marginLabel", () => {
  it("shows money and percent together", () => {
    expect(marginLabel(12.4, 0.13, "PLN")).toBe("12.40 PLN (13%)");
  });

  it("omits the percent when the ratio is unknown rather than printing NaN", () => {
    expect(marginLabel(12.4, undefined, "PLN")).toBe("12.40 PLN");
  });

  it("keeps two decimals on the money", () => {
    expect(marginLabel(0, 0, "PLN")).toBe("0.00 PLN (0%)");
  });
});

describe("thin margin threshold", () => {
  it("is a single constant, expressed as a fraction", () => {
    expect(THIN_MARGIN_PCT).toBe(0.05);
  });
});

describe("no behavioural notes remain in the table copy", () => {
  it("carries no revert or cheapest-case sentence", () => {
    // The owner asked for prices, not explanations. These two sentences used to
    // repeat under every row, twice per row.
    const all = Object.values(PROMO_COPY).join(" ");
    expect(all).not.toContain("wraca do");
    expect(all).not.toContain("najtańsi");
    expect(all).not.toContain("30 dni");
  });
});
