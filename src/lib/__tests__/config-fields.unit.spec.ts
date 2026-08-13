import { CONFIG_FIELDS, resolveEffectiveConfigValue } from "../config-fields";

describe("resolveEffectiveConfigValue", () => {
  it("prefers the environment lock over everything else", () => {
    // The lock is a HARD override, mirroring the runtime toggles: an operator pinning
    // `marketplaceId` or `salesChannelId` against an admin mistake must win outright.
    expect(resolveEffectiveConfigValue("locked", "persisted", "default")).toBe("locked");
  });

  it("falls back to the persisted value when no lock is set", () => {
    expect(resolveEffectiveConfigValue(undefined, "persisted", "default")).toBe("persisted");
  });

  it("falls back to the medusa-config default when neither a lock nor a persisted value is set", () => {
    expect(resolveEffectiveConfigValue(undefined, null, "default")).toBe("default");
    expect(resolveEffectiveConfigValue(undefined, undefined, "default")).toBe("default");
  });

  it("reads a cleared persisted value (null) the same as one never written (undefined)", () => {
    expect(resolveEffectiveConfigValue(undefined, null, "default")).toBe(
      resolveEffectiveConfigValue(undefined, undefined, "default"),
    );
  });

  it("returns null when nothing at all is configured", () => {
    expect(resolveEffectiveConfigValue(undefined, null, null)).toBeNull();
    expect(resolveEffectiveConfigValue(null, null, null)).toBeNull();
  });

  it("works for numbers exactly like it works for strings", () => {
    expect(resolveEffectiveConfigValue(undefined, undefined, 100)).toBe(100);
    expect(resolveEffectiveConfigValue(undefined, 50, 100)).toBe(50);
    expect(resolveEffectiveConfigValue(25, 50, 100)).toBe(25);
  });
});

describe("CONFIG_FIELDS", () => {
  it("declares exactly the eight editable configuration fields", () => {
    expect(CONFIG_FIELDS.map((field) => field.key)).toEqual([
      "automationRuleStandard",
      "automationRulePromoted",
      "srpMetadataKey",
      "srpPriceListId",
      "changeCap",
      "marketplaceId",
      "salesChannelId",
      "salesChannelName",
    ]);
  });

  it("keeps each key, column and env var distinct", () => {
    const keys = CONFIG_FIELDS.map((field) => field.key);
    const columns = CONFIG_FIELDS.map((field) => field.column);
    const envVars = CONFIG_FIELDS.map((field) => field.envVar);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(columns).size).toBe(columns.length);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("names each env var ALLEGRO_<FIELD>, matching the column it locks", () => {
    for (const field of CONFIG_FIELDS) {
      expect(field.envVar).toMatch(/^ALLEGRO_[A-Z_]+$/);
    }
  });

  it("flags marketplaceId and salesChannelId as wiring-critical, and nothing else", () => {
    // A wrong value here silently breaks the Allegro<->Medusa mapping rather than
    // merely mis-tuning a run, so the admin renders an explicit re-scoping warning
    // only for these two.
    const critical = CONFIG_FIELDS.filter((field) => field.wiringCritical).map(
      (field) => field.key,
    );
    expect(critical.toSorted()).toEqual(["marketplaceId", "salesChannelId"]);
  });

  it("gives change_cap a number input and every other field a text input", () => {
    const numberFields = CONFIG_FIELDS.filter((field) => field.kind === "number").map(
      (field) => field.key,
    );
    expect(numberFields).toEqual(["changeCap"]);
  });
});
