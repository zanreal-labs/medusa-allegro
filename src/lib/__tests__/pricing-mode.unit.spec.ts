import {
  coercePricingMode,
  DEFAULT_PRICING_MODE,
  isPricingMode,
  modeNeedsAutomationRules,
  modeWrites,
  PRICING_MODE_VALUES,
  PRICING_MODES,
} from "../pricing-mode";

describe("PRICING_MODES", () => {
  it("offers exactly the three strategies, least invasive first", () => {
    expect(PRICING_MODES.map((mode) => mode.value)).toEqual([
      "monitor",
      "automation_rule",
      "fixed_price",
    ]);
  });

  it("gives every mode a label and a sentence saying what it writes", () => {
    for (const mode of PRICING_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(0);
    }
  });

  it("never offers an empty value", () => {
    // The admin renders these as `Select.Item`s, and a `value=""` there crashes
    // the page on mount. "Nothing chosen" is the persisted column being null.
    for (const value of PRICING_MODE_VALUES) {
      expect(value).not.toBe("");
    }
  });
});

describe("DEFAULT_PRICING_MODE", () => {
  it("is the behaviour this plugin had before the mode existed", () => {
    // Not `monitor`. An upgrade that silently stopped a store's price writes
    // would be a far worse surprise than one that changes nothing.
    expect(DEFAULT_PRICING_MODE).toBe("automation_rule");
  });
});

describe("isPricingMode", () => {
  it("accepts each known mode and nothing else", () => {
    for (const value of PRICING_MODE_VALUES) {
      expect(isPricingMode(value)).toBe(true);
    }
    expect(isPricingMode("fixed")).toBe(false);
    expect(isPricingMode("")).toBe(false);
    expect(isPricingMode(undefined)).toBe(false);
    expect(isPricingMode(null)).toBe(false);
    expect(isPricingMode(2)).toBe(false);
  });
});

describe("coercePricingMode", () => {
  it("passes a known mode through", () => {
    expect(coercePricingMode("fixed_price")).toBe("fixed_price");
    expect(coercePricingMode("monitor")).toBe("monitor");
  });

  it("reads anything unrecognised as the default rather than throwing", () => {
    // Evaluated on every sync run, so a value written by an older build, by hand,
    // or by a mode this build does not know about must not turn every run into a
    // thrown error.
    expect(coercePricingMode("something-else")).toBe(DEFAULT_PRICING_MODE);
    expect(coercePricingMode(null)).toBe(DEFAULT_PRICING_MODE);
    expect(coercePricingMode(undefined)).toBe(DEFAULT_PRICING_MODE);
  });
});

describe("modeWrites", () => {
  it("is false only for monitor", () => {
    expect(modeWrites("monitor")).toBe(false);
    expect(modeWrites("automation_rule")).toBe(true);
    expect(modeWrites("fixed_price")).toBe(true);
  });
});

describe("modeNeedsAutomationRules", () => {
  it("is true only for the mode that attaches one", () => {
    // Fixed-price mode REMOVES a rule, which is scoped by marketplace and needs no
    // rule name; monitor writes nothing. Demanding two rule names from either
    // would be asking for configuration they will never use.
    expect(modeNeedsAutomationRules("automation_rule")).toBe(true);
    expect(modeNeedsAutomationRules("fixed_price")).toBe(false);
    expect(modeNeedsAutomationRules("monitor")).toBe(false);
  });
});
