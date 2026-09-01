import { formatMarginLabel, formatMoney, formatPercentCompact } from "../format";

/**
 * `Intl` separates an amount from its currency with a non-breaking space
 * (U+00A0), which is the right character in a table cell but makes an
 * assertion written with a plain space fail on a diff nobody can see.
 */
const plain = (value: string): string => value.replace(/[\u00a0\u202f]/g, " ");

describe("formatMarginLabel", () => {
  it("renders KWOTA (PROCENT) and nothing else", () => {
    // The shape asked for verbatim. Notably absent: the anchor price.
    expect(plain(formatMarginLabel(42.1, 0.271, "PLN", "pl-PL"))).toBe("42,10 zł (27%)");
  });

  it("localises money and percentage together", () => {
    expect(plain(formatMarginLabel(42.1, 0.271, "PLN", "en-GB"))).toBe("PLN 42.10 (27%)");
  });

  it("keeps the sign on a loss", () => {
    expect(plain(formatMarginLabel(-8, -0.04, "PLN", "en-GB"))).toBe("-PLN 8.00 (-4%)");
  });

  it("falls back to a plain amount when the offer carries no usable currency", () => {
    expect(plain(formatMarginLabel(42.1, 0.271, null, "en-GB"))).toBe("42.10 (27%)");
    expect(plain(formatMarginLabel(42.1, 0.271, "ZZZZ", "en-GB"))).toBe("42.10 ZZZZ (27%)");
  });

  it("never renders half a label", () => {
    expect(formatMarginLabel(undefined, 0.271, "PLN")).toBe("-");
    expect(formatMarginLabel(42.1, undefined, "PLN")).toBe("-");
    expect(formatMarginLabel(Number.NaN, 0.271, "PLN")).toBe("-");
  });
});

describe("formatMoney", () => {
  it("uses the admin's locale", () => {
    expect(plain(formatMoney(1234.5, "PLN", "pl-PL"))).toBe("1234,50 zł");
    expect(plain(formatMoney(1234.5, "EUR", "en-GB"))).toBe("€1,234.50");
  });

  it("renders an unusable currency as a plain amount", () => {
    expect(plain(formatMoney(12.3, "zz", "en-GB"))).toBe("12.30 ZZ");
    expect(plain(formatMoney(12.3, null, "en-GB"))).toBe("12.30");
  });
});

describe("formatPercentCompact", () => {
  it("rounds to a whole percent", () => {
    expect(formatPercentCompact(0.271, "en-GB")).toBe("27%");
    expect(formatPercentCompact(-0.04, "en-GB")).toBe("-4%");
  });
});
