import {
  ALLEGRO_RULE_NAME_MAX,
  asDiscountBase,
  assemblePreviewRow,
  ceil2,
  computeOverridePrice,
  DISCOUNT_BASES,
  floor2,
  PROMO_RULE_PREFIX,
  promotionalRuleName,
  resolveDiscount,
} from "../preview";
import type { AssemblePreviewRowInput } from "../preview";

describe("asDiscountBase", () => {
  it("accepts only the two valid bases, rejects everything else", () => {
    expect(DISCOUNT_BASES).toEqual(["srp", "competitor"]);
    expect(asDiscountBase("srp")).toBe("srp");
    expect(asDiscountBase("competitor")).toBe("competitor");
    expect(asDiscountBase("both")).toBeUndefined();
    expect(asDiscountBase(null)).toBeUndefined();
    expect(asDiscountBase(undefined)).toBeUndefined();
  });
});

const RULES = { promoted: "Bitdefender Sale", standard: "Bitdefender" };

describe("resolveDiscount", () => {
  it("maps a percentage method to a percentage discount", () => {
    expect(resolveDiscount({ type: "percentage", value: 10 })).toEqual({
      kind: "percentage",
      label: "-10%",
      percent: 10,
    });
  });

  it("maps a fixed method to a fixed discount, rounding the amount UP to grosze", () => {
    // 10.001 must not become 10.00 - a customer must never get less discount than promised.
    expect(resolveDiscount({ currency_code: "pln", type: "fixed", value: 10.001 })).toEqual({
      amount: 10.01,
      currency: "PLN",
      kind: "fixed",
      label: "-10.01 PLN",
    });
  });

  it("rejects an order-level target as having no per-offer equivalent", () => {
    const result = resolveDiscount({ target_type: "order", type: "percentage", value: 10 });
    expect(result.kind).toBe("unsupported");
  });

  it("rejects an `across` allocation because the per-offer value depends on the basket", () => {
    const result = resolveDiscount({ allocation: "across", type: "percentage", value: 10 });
    expect(result.kind).toBe("unsupported");
  });

  it("ACCEPTS a unit-capped `each` discount, because Medusa requires a cap for `each`", () => {
    // Regression: rejecting any max_quantity rejected 100% of valid promotions,
    // since Medusa's own validation requires max_quantity for both `each` and `once`.
    // The first real promotion (10% off, each, max_quantity 100) hit exactly this.
    expect(resolveDiscount({ allocation: "each", max_quantity: 100, type: "percentage", value: 10 })).toEqual({
      kind: "percentage",
      label: "-10%",
      percent: 10,
    });
  });

  it("rejects `once`, which discounts a single unit per order rather than each unit", () => {
    const result = resolveDiscount({ allocation: "once", max_quantity: 1, type: "percentage", value: 10 });
    expect(result.kind).toBe("unsupported");
  });

  it("reproduces the exact shape of the first real promotion end to end", () => {
    // percentage / items / each / max_quantity 100 / pln - what was created by hand.
    const result = resolveDiscount({
      allocation: "each",
      currency_code: "pln",
      max_quantity: 100,
      target_type: "items",
      type: "percentage",
      value: 10,
    });
    expect(result).toEqual({ kind: "percentage", label: "-10%", percent: 10 });
  });

  it("rejects a percentage at or above 100%", () => {
    expect(resolveDiscount({ type: "percentage", value: 100 }).kind).toBe("unsupported");
  });

  it("rejects a fixed discount with no currency", () => {
    expect(resolveDiscount({ type: "fixed", value: 10 }).kind).toBe("unsupported");
  });

  it("rejects a missing or non-positive value", () => {
    expect(resolveDiscount({ type: "percentage", value: 0 }).kind).toBe("unsupported");
    expect(resolveDiscount({ type: "percentage" }).kind).toBe("unsupported");
  });
});

describe("rounding direction", () => {
  it("ceils a discount amount and floors a selling price", () => {
    expect(ceil2(10.001)).toBe(10.01);
    expect(floor2(10.009)).toBe(10);
  });
});

describe("promotionalRuleName", () => {
  it("prefixes the base rule and appends the discount label", () => {
    expect(promotionalRuleName("Bitdefender", "-10%")).toEqual({
      name: `${PROMO_RULE_PREFIX}Bitdefender -10%`,
      ok: true,
    });
  });

  it("fails closed when the name would exceed Allegro's 33-char limit rather than truncating", () => {
    const long = "A".repeat(ALLEGRO_RULE_NAME_MAX);
    const result = promotionalRuleName(long, "-10%");
    expect(result.ok).toBe(false);
  });
});

describe("computeOverridePrice", () => {
  it("subtracts a percentage off SRP, rounding the price DOWN", () => {
    // 99.99 * 0.9 = 89.991 -> floored to 89.99.
    expect(computeOverridePrice(99.99, 10, { kind: "percentage", label: "-10%", percent: 10 })).toEqual(
      { clampedToFloor: false, price: 89.99 },
    );
  });

  it("subtracts a fixed amount off SRP", () => {
    expect(
      computeOverridePrice(100, 10, { amount: 15, currency: "PLN", kind: "fixed", label: "-15.00 PLN" }),
    ).toEqual({ clampedToFloor: false, price: 85 });
  });

  it("clamps to break-even and flags it when the discount would breach cost", () => {
    // 100 - 95 = 5, below the 80 break-even: floored to 80 and flagged.
    expect(
      computeOverridePrice(100, 80, { amount: 95, currency: "PLN", kind: "fixed", label: "-95.00 PLN" }),
    ).toEqual({ clampedToFloor: true, price: 80 });
  });
});

describe("assemblePreviewRow", () => {
  const base: AssemblePreviewRowInput = {
    breakEven: 40,
    breakEvenRaw: 39.4,
    currency: "PLN",
    discount: { kind: "percentage", label: "-10%", percent: 10 },
    discountBase: "competitor",
    promoted: false,
    rules: RULES,
    sku: "SKU-1",
    srp: 100,
  };

  it("competitor base -> rule switch onto a prefixed promotional rule, caveat surfaced", () => {
    const row = assemblePreviewRow(base);
    expect(row.skipped).toBe(false);
    if (row.skipped) {
      return;
    }
    expect(row.mechanism).toEqual({
      competitorRelativeCaveat: true,
      fromRule: "Bitdefender",
      kind: "rule-switch",
      toRule: `${PROMO_RULE_PREFIX}Bitdefender -10%`,
    });
  });

  it("uses the promoted (Wyroznienie) base rule when the offer is highlighted", () => {
    const row = assemblePreviewRow({ ...base, promoted: true });
    if (row.skipped) {
      throw new Error("expected a resolved row");
    }
    if (row.mechanism.kind !== "rule-switch") {
      throw new Error("expected a rule switch");
    }
    expect(row.mechanism.fromRule).toBe("Bitdefender Sale");
    expect(row.mechanism.toRule).toBe(`${PROMO_RULE_PREFIX}Bitdefender Sale -10%`);
  });

  it("srp base -> price override with the standard rule as the revert plan", () => {
    const row = assemblePreviewRow({ ...base, discountBase: "srp" });
    if (row.skipped) {
      throw new Error("expected a resolved row");
    }
    expect(row.mechanism).toEqual({
      clampedToFloor: false,
      kind: "price-override",
      price: 90,
      revertRule: "Bitdefender",
    });
  });

  it("skips with rule-name-too-long rather than truncating an over-long promotional name", () => {
    const row = assemblePreviewRow({
      ...base,
      rules: { promoted: "P", standard: "A".repeat(ALLEGRO_RULE_NAME_MAX) },
    });
    expect(row).toEqual({ reason: "rule-name-too-long", sku: "SKU-1", skipped: true });
  });
});
