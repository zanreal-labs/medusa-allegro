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

describe("parseAmount strictness", () => {
  it("refuses a partially-numeric string instead of returning its leading digits", () => {
    // `Number.parseFloat` stops at the first character it cannot use and returns what it has,
    // so each of these silently became a WRONG number in a money field rather than a refusal -
    // and downstream a partial parse is indistinguishable from a good one.
    expect(parseAmount("12abc")).toBeUndefined();
    expect(parseAmount("1 234,56")).toBeUndefined();
    expect(parseAmount("12.")).toBeUndefined();
    expect(parseAmount("199,99")).toBeUndefined();
    expect(parseAmount("--5")).toBeUndefined();
    expect(parseAmount("1e3")).toBeUndefined();
    expect(parseAmount("  ")).toBeUndefined();
  });

  it("still accepts the decimal strings Allegro actually sends", () => {
    expect(parseAmount("233.21")).toBe(233.21);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("-12.50")).toBe(-12.5);
    expect(parseAmount(" 199.99 ")).toBe(199.99);
    expect(parseAmount("+8.00")).toBe(8);
  });

  it("passes finite numbers through and refuses non-finite ones", () => {
    expect(parseAmount(199.99)).toBe(199.99);
    expect(parseAmount(0)).toBe(0);
    expect(parseAmount(Number.NaN)).toBeUndefined();
    expect(parseAmount(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
