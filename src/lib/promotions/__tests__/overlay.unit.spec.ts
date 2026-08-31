import { PROMO_RULE_PREFIX } from "../preview";
import { configEquals, decidePromoRule, isPluginOwned, promoRuleConfig } from "../overlay";
import type { AccountRule } from "../overlay";

const PCT = { kind: "percentage", label: "-10%", percent: 10 } as const;
const FIXED = { amount: 15.5, currency: "PLN", kind: "fixed", label: "-15.50 PLN" } as const;
const BASE: AccountRule = { id: "base1", name: "Bitdefender", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" };
const PROMO_NAME = `${PROMO_RULE_PREFIX}Bitdefender -10%`;

describe("promoRuleConfig", () => {
  it("puts a percentage discount in the rule as SUBTRACT", () => {
    expect(promoRuleConfig(PCT)).toEqual({
      changeByPercentage: { operation: "SUBTRACT", value: "10" },
    });
  });

  it("keeps grosze on a fixed amount, since Allegro accepts them", () => {
    // Proven by a real recorded command response carrying a 283.74 bound.
    expect(promoRuleConfig(FIXED)).toEqual({
      changeByAmount: {
        operation: "SUBTRACT",
        values: [{ amount: "15.50", currency: "PLN" }],
      },
    });
  });
});

describe("isPluginOwned", () => {
  it("owns only prefixed names", () => {
    expect(isPluginOwned(`${PROMO_RULE_PREFIX}anything`)).toBe(true);
    expect(isPluginOwned("Bitdefender")).toBe(false);
    expect(isPluginOwned("Bitdefender Sale")).toBe(false);
    expect(isPluginOwned(undefined)).toBe(false);
  });
});

describe("configEquals", () => {
  it("compares numeric strings as numbers, so an echoed 10.0 is not drift", () => {
    expect(
      configEquals(
        { changeByPercentage: { operation: "SUBTRACT", value: "10.0" } },
        { changeByPercentage: { operation: "SUBTRACT", value: "10" } },
      ),
    ).toBe(true);
  });

  it("is key-order independent", () => {
    expect(configEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("still reports a real difference", () => {
    expect(
      configEquals(
        { changeByPercentage: { operation: "SUBTRACT", value: "10" } },
        { changeByPercentage: { operation: "SUBTRACT", value: "15" } },
      ),
    ).toBe(false);
  });
});

describe("decidePromoRule", () => {
  it("creates the rule when it does not exist, inheriting the base rule's type", () => {
    expect(decidePromoRule({ accountRules: [BASE], baseRule: BASE, baseRuleName: "Bitdefender", discount: PCT })).toEqual({
      action: "create",
      config: { changeByPercentage: { operation: "SUBTRACT", value: "10" } },
      name: PROMO_NAME,
      // Inherited, never invented: a promotion changes the discount, not the strategy.
      type: "FOLLOW_BY_ALLEGRO_MIN_PRICE",
    });
  });

  it("reuses a plugin-owned rule whose config already matches", () => {
    const existing: AccountRule = {
      configuration: { changeByPercentage: { operation: "SUBTRACT", value: "10" } },
      id: "promo1",
      name: PROMO_NAME,
    };
    expect(
      decidePromoRule({ accountRules: [BASE, existing], baseRule: BASE, baseRuleName: "Bitdefender", discount: PCT }),
    ).toEqual({ action: "reuse", ruleId: "promo1" });
  });

  it("updates a plugin-owned rule whose config drifted, rather than duplicating it", () => {
    const existing: AccountRule = {
      configuration: { changeByPercentage: { operation: "SUBTRACT", value: "25" } },
      id: "promo1",
      name: PROMO_NAME,
    };
    const decision = decidePromoRule({
      accountRules: [BASE, existing],
      baseRule: BASE,
      baseRuleName: "Bitdefender",
      discount: PCT,
    });
    expect(decision).toMatchObject({ action: "update", ruleId: "promo1" });
  });

  it("REFUSES when the base rule is missing, rather than inventing a type", () => {
    const decision = decidePromoRule({
      accountRules: [],
      baseRule: undefined,
      baseRuleName: "Bitdefender",
      discount: PCT,
    });
    expect(decision.action).toBe("refuse");
  });

  it("REFUSES an ambiguous name instead of picking one", () => {
    const a: AccountRule = { id: "x", name: PROMO_NAME };
    const b: AccountRule = { id: "y", name: PROMO_NAME };
    const decision = decidePromoRule({
      accountRules: [BASE, a, b],
      baseRule: BASE,
      baseRuleName: "Bitdefender",
      discount: PCT,
    });
    expect(decision.action).toBe("refuse");
  });

  it("REFUSES a name too long for Allegro rather than truncating into a collision", () => {
    const longBase = "B".repeat(40);
    const decision = decidePromoRule({
      accountRules: [],
      baseRule: { ...BASE, name: longBase },
      baseRuleName: longBase,
      discount: PCT,
    });
    expect(decision.action).toBe("refuse");
  });

  it("never proposes touching a hand-managed rule", () => {
    // Whatever the account contains, a decision that writes must name a prefixed rule.
    const decision = decidePromoRule({
      accountRules: [BASE, { id: "s", name: "Bitdefender Sale", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" }],
      baseRule: BASE,
      baseRuleName: "Bitdefender",
      discount: PCT,
    });
    if (decision.action === "create" || decision.action === "update") {
      expect(isPluginOwned(decision.name)).toBe(true);
    } else {
      throw new Error("expected a write decision");
    }
  });
});
