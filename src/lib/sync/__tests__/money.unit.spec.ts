import { formatAmount, parseAmount, round2 } from "../money";

describe("round2", () => {
  it("rounds a tie away from zero rather than to even", () => {
    // Tie-to-even would give 1.00 here, which is a grosz below the true value -
    // the unsafe direction for a price floor.
    expect(round2(1.005)).toBe(1.01);
  });

  it("leaves an exact value alone", () => {
    expect(round2(45.95)).toBe(45.95);
  });
});

describe("parseAmount", () => {
  it("parses an Allegro decimal string", () => {
    expect(parseAmount("233.21")).toBe(233.21);
  });

  it("passes a number through", () => {
    expect(parseAmount(233.21)).toBe(233.21);
  });

  it("returns undefined rather than zero for an absent amount", () => {
    // A zero cost or a zero price silently passes every downstream check that a
    // missing one correctly fails.
    expect(parseAmount()).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
    expect(parseAmount("")).toBeUndefined();
  });

  it("returns undefined for something unparseable", () => {
    expect(parseAmount("not money")).toBeUndefined();
  });

  it("parses a genuine zero as zero", () => {
    expect(parseAmount("0.00")).toBe(0);
  });

  it("rejects a non-finite value", () => {
    expect(parseAmount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseAmount(Number.NaN)).toBeUndefined();
  });
});

describe("formatAmount", () => {
  it("renders two decimals the way a command body needs", () => {
    expect(formatAmount(45)).toBe("45.00");
    expect(formatAmount(45.5)).toBe("45.50");
  });
});
