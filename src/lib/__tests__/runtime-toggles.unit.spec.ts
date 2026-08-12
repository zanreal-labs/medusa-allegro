import {
  FRESH_INSTALL_SETTINGS,
  resolveEffectiveEnabled,
  RUNTIME_TOGGLES,
} from "../runtime-toggles";

describe("resolveEffectiveEnabled", () => {
  it("arms a writer only when it is persisted-on and nothing forces it off", () => {
    // persisted on + no override = on. The one case where a writer runs.
    expect(resolveEffectiveEnabled(true, false)).toBe(true);
  });

  it("lets an override force a persisted-on writer off", () => {
    // persisted on + env off = off. The whole point of the env being a HARD override:
    // an operator responding to an incident wins over stale config.
    expect(resolveEffectiveEnabled(true, true)).toBe(false);
  });

  it("keeps a writer off when it is not armed, override or not", () => {
    // persisted off + env unset = off, and persisted off + env off = off. The toggle
    // governs; the override can never turn a writer on.
    expect(resolveEffectiveEnabled(false, false)).toBe(false);
    expect(resolveEffectiveEnabled(false, true)).toBe(false);
  });

  it("reads a stray non-boolean conservatively in both directions", () => {
    // A malformed row must read as "not armed" and "not forced off" rather than
    // truthiness silently arming or disarming a writer.
    expect(resolveEffectiveEnabled(undefined as unknown as boolean, false)).toBe(false);
    expect(resolveEffectiveEnabled(true, undefined as unknown as boolean)).toBe(true);
  });
});

describe("RUNTIME_TOGGLES", () => {
  it("declares exactly the five governed writers", () => {
    expect(RUNTIME_TOGGLES.map((toggle) => toggle.key)).toEqual([
      "priceSync",
      "stockSync",
      "ordersSync",
      "fulfillmentWriteback",
      "invoiceAttach",
    ]);
  });

  it("keeps each key, column and env var distinct", () => {
    const keys = RUNTIME_TOGGLES.map((toggle) => toggle.key);
    const columns = RUNTIME_TOGGLES.map((toggle) => toggle.column);
    const envVars = RUNTIME_TOGGLES.map((toggle) => toggle.envVar);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(columns).size).toBe(columns.length);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("names each env var ALLEGRO_*_DISABLED, since the override can only force off", () => {
    for (const toggle of RUNTIME_TOGGLES) {
      expect(toggle.envVar).toMatch(/^ALLEGRO_[A-Z_]+_DISABLED$/);
    }
  });

  it("has a persisted column for every writer", () => {
    for (const toggle of RUNTIME_TOGGLES) {
      expect(FRESH_INSTALL_SETTINGS).toHaveProperty(toggle.column);
    }
  });
});

describe("FRESH_INSTALL_SETTINGS", () => {
  it("arms nothing that writes to the marketplace, and only pre-arms invoice attach", () => {
    expect(FRESH_INSTALL_SETTINGS).toEqual({
      fulfillment_writeback_enabled: false,
      invoice_attach_enabled: true,
      orders_sync_enabled: false,
      price_sync_enabled: false,
      stock_sync_enabled: false,
    });
  });
});
