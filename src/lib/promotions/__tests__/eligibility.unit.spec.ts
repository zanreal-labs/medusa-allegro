import {
  channelScopeFromRules,
  includesAllegroChannel,
  isPromotionActive,
  targetSelectionFromRules,
} from "../eligibility";

describe("isPromotionActive (mirrors listActivePromotions_)", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("requires status active", () => {
    expect(isPromotionActive("draft", null, now)).toBe(false);
    expect(isPromotionActive("active", null, now)).toBe(true);
  });

  it("treats a promotion with no campaign as windowless", () => {
    expect(isPromotionActive("active", undefined, now)).toBe(true);
  });

  it("honours an open campaign window", () => {
    expect(
      isPromotionActive(
        "active",
        { ends_at: "2026-09-30T00:00:00.000Z", starts_at: "2026-08-01T00:00:00.000Z" },
        now,
      ),
    ).toBe(true);
  });

  it("is inactive before starts_at (inclusive lower bound)", () => {
    expect(isPromotionActive("active", { starts_at: "2026-09-02T00:00:00.000Z" }, now)).toBe(false);
    expect(isPromotionActive("active", { starts_at: now.toISOString() }, now)).toBe(true);
  });

  it("is inactive at and after ends_at (EXCLUSIVE upper bound)", () => {
    // ends_at exactly now must read inactive - copied verbatim from core.
    expect(isPromotionActive("active", { ends_at: now.toISOString() }, now)).toBe(false);
    expect(isPromotionActive("active", { ends_at: "2026-09-01T12:00:00.001Z" }, now)).toBe(true);
  });

  it("treats null bounds as unbounded", () => {
    expect(isPromotionActive("active", { ends_at: null, starts_at: null }, now)).toBe(true);
  });
});

describe("channelScopeFromRules", () => {
  it("collects sales_channel_id values, ignoring other attributes", () => {
    const scope = channelScopeFromRules([
      { attribute: "sales_channel_id", values: [{ value: "sc_1" }, { value: "sc_2" }] },
      { attribute: "customer_group", values: [{ value: "cg_1" }] },
    ]);
    expect([...scope].sort()).toEqual(["sc_1", "sc_2"]);
  });

  it("is empty when nothing scopes the channel (meaning: every channel)", () => {
    expect(channelScopeFromRules([]).size).toBe(0);
  });
});

describe("includesAllegroChannel", () => {
  it("an empty scope means every channel, Allegro included", () => {
    expect(includesAllegroChannel(new Set(), "sc_allegro")).toBe(true);
  });

  it("a scope matches only when it names the Allegro channel", () => {
    expect(includesAllegroChannel(new Set(["sc_web"]), "sc_allegro")).toBe(false);
    expect(includesAllegroChannel(new Set(["sc_web", "sc_allegro"]), "sc_allegro")).toBe(true);
  });

  it("fails closed when the channel is scoped but the Allegro id is unknown", () => {
    expect(includesAllegroChannel(new Set(["sc_web"]), undefined)).toBe(false);
  });
});

describe("targetSelectionFromRules", () => {
  it("splits product and variant targets by attribute", () => {
    const selection = targetSelectionFromRules([
      { attribute: "items.product.id", values: [{ value: "prod_1" }] },
      { attribute: "items.variant.id", values: [{ value: "var_1" }] },
      { attribute: "sales_channel_id", values: [{ value: "sc_1" }] },
    ]);
    expect([...selection.productIds]).toEqual(["prod_1"]);
    expect([...selection.variantIds]).toEqual(["var_1"]);
  });
});
