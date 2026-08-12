import { randomBytes } from "node:crypto";
import {
  DEFAULT_CHANGE_CAP,
  DEFAULT_COSTS_MODULE_KEY,
  DEFAULT_INVOICE_MODULE_KEY,
  DEFAULT_MARKETPLACE_ID,
  isInvoiceAttachDisabledByEnv,
  isOrdersSyncDisabledByEnv,
  isStockSyncDisabledByEnv,
  resolveAllegroOptions,
  toPublicAllegroOptions,
} from "../options";
import type { AllegroPluginOptions } from "../options";

/**
 * The wave 2/3/4 option surface. Kept in its own spec from the wave-1 options so
 * the two suites can be read independently - this one is entirely about the sync
 * configuration, and every case here is a misconfiguration that would otherwise
 * surface as a silently inert loop.
 */

const validOptions = (over: Partial<AllegroPluginOptions> = {}): AllegroPluginOptions => ({
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  clientId: "client-id",
  clientSecret: "client-secret",
  docsUrl: "https://example.com/allegro",
  encryptionKey: randomBytes(32).toString("base64"),
  ...over,
});

/** Run `fn` with one env var set, restoring whatever was there. */
const withEnv = (name: string, value: string | undefined, fn: () => void): void => {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
};

describe("sync defaults", () => {
  it("defaults every sync knob", () => {
    const resolved = resolveAllegroOptions(validOptions());
    expect(resolved).toMatchObject({
      changeCap: DEFAULT_CHANGE_CAP,
      costsModuleKey: DEFAULT_COSTS_MODULE_KEY,
      // Attaching is on by default: the invoice already exists as a legal document
      // by the time this plugin hears about it, so refusing to deliver it cannot be
      // the out-of-the-box behaviour.
      invoiceAttachDisabled: false,
      invoiceModuleKey: DEFAULT_INVOICE_MODULE_KEY,
      marketplaceId: DEFAULT_MARKETPLACE_ID,
      ordersSyncDisabled: false,
      stockLocationIds: [],
      stockSyncDisabled: false,
    });
    expect(resolved.automationRules).toBeUndefined();
    expect(resolved.salesChannelId).toBeUndefined();
    expect(resolved.srpMetadataKey).toBeUndefined();
    expect(resolved.srpPriceListId).toBeUndefined();
  });

  it("leaves automationRules undefined rather than inventing rule names", () => {
    // Price sync is inert without it, on purpose: a guessed rule name attaches the
    // wrong pricing policy to a live catalogue.
    expect(resolveAllegroOptions(validOptions()).automationRules).toBeUndefined();
  });
});

describe("kill switches", () => {
  it.each(["stockSyncDisabled", "ordersSyncDisabled", "invoiceAttachDisabled"] as const)(
    "honours %s from the config",
    (field) => {
      const resolved = resolveAllegroOptions(validOptions({ [field]: true }));
      expect(resolved[field]).toBe(true);
    },
  );

  it.each([
    ["stockSyncDisabled", "ALLEGRO_STOCK_SYNC_DISABLED"],
    ["ordersSyncDisabled", "ALLEGRO_ORDERS_SYNC_DISABLED"],
    ["invoiceAttachDisabled", "ALLEGRO_INVOICE_ATTACH_DISABLED"],
  ] as const)("lets %s be forced on by %s", (field, envVar) => {
    withEnv(envVar, "1", () => {
      expect(resolveAllegroOptions(validOptions({ [field]: false }))[field]).toBe(true);
    });
  });

  it.each([
    ["stockSyncDisabled", "ALLEGRO_STOCK_SYNC_DISABLED"],
    ["ordersSyncDisabled", "ALLEGRO_ORDERS_SYNC_DISABLED"],
    ["invoiceAttachDisabled", "ALLEGRO_INVOICE_ATTACH_DISABLED"],
  ] as const)("rejects a boolean-looking string for %s", (field, envVar) => {
    // The mistake: `stockSyncDisabled: process.env.SOMETHING` yields "true", which
    // a truthiness test honours but a `=== true` test ignores - the switch reads as
    // enabled while the operator believes it is off.
    expect(() => resolveAllegroOptions(validOptions({ [field]: "true" as never }))).toThrow(
      new RegExp(`\`${field}\` must be a boolean`),
    );
    expect(() => resolveAllegroOptions(validOptions({ [field]: "true" as never }))).toThrow(
      new RegExp(envVar),
    );
  });

  it.each(["1", "true", "TRUE", " Yes "])("reads %p as disabled from the env", (value) => {
    expect(isStockSyncDisabledByEnv({ ALLEGRO_STOCK_SYNC_DISABLED: value })).toBe(true);
    expect(isOrdersSyncDisabledByEnv({ ALLEGRO_ORDERS_SYNC_DISABLED: value })).toBe(true);
    expect(isInvoiceAttachDisabledByEnv({ ALLEGRO_INVOICE_ATTACH_DISABLED: value })).toBe(true);
  });

  it.each(["0", "false", "no", "", undefined])("reads %p as enabled from the env", (value) => {
    expect(isStockSyncDisabledByEnv({ ALLEGRO_STOCK_SYNC_DISABLED: value })).toBe(false);
    expect(isOrdersSyncDisabledByEnv({ ALLEGRO_ORDERS_SYNC_DISABLED: value })).toBe(false);
    expect(isInvoiceAttachDisabledByEnv({ ALLEGRO_INVOICE_ATTACH_DISABLED: value })).toBe(false);
  });
});

describe("automationRules", () => {
  it("accepts and trims two distinct names", () => {
    const resolved = resolveAllegroOptions(
      validOptions({ automationRules: { promoted: " Store Sale ", standard: "Store" } }),
    );
    expect(resolved.automationRules).toEqual({ promoted: "Store Sale", standard: "Store" });
  });

  it("rejects a half-configured pair", () => {
    expect(() =>
      resolveAllegroOptions(validOptions({ automationRules: { promoted: "Store Sale" } as never })),
    ).toThrow(/needs both `promoted` and `standard`/);
  });

  it("rejects a blank name", () => {
    expect(() =>
      resolveAllegroOptions(
        validOptions({ automationRules: { promoted: "  ", standard: "Store" } }),
      ),
    ).toThrow(/needs both `promoted` and `standard`/);
  });

  it("rejects one name used for both promotion states", () => {
    // A promotion flip would then be a no-op switch, so the promoted commission
    // rate would never reach the price floor - price sync would look healthy while
    // systematically under-flooring every promoted offer.
    expect(() =>
      resolveAllegroOptions(
        validOptions({ automationRules: { promoted: "Store", standard: "Store" } }),
      ),
    ).toThrow(/same rule name/);
  });

  it("rejects a non-object", () => {
    expect(() =>
      resolveAllegroOptions(validOptions({ automationRules: "Store" as never })),
    ).toThrow(/must be an object/);
  });
});

describe("changeCap", () => {
  it("accepts a positive integer", () => {
    expect(resolveAllegroOptions(validOptions({ changeCap: 25 })).changeCap).toBe(25);
  });

  it.each([0, -1, 1.5, "10"])("rejects %p", (value) => {
    // A cap is a blast-radius limit. Zero would be a silently inert loop still
    // reporting "ok"; the three kill switches are how you stop writes.
    expect(() => resolveAllegroOptions(validOptions({ changeCap: value as never }))).toThrow(
      /`changeCap` must be a positive integer/,
    );
  });

  it("names the kill switch in the rejection", () => {
    expect(() => resolveAllegroOptions(validOptions({ changeCap: 0 }))).toThrow(
      /ALLEGRO_PRICE_SYNC_DISABLED/,
    );
  });
});

describe("stockLocationIds", () => {
  it("deduplicates the configured ids", () => {
    const resolved = resolveAllegroOptions(
      validOptions({ stockLocationIds: ["sloc_1", "sloc_1", " sloc_2 "] }),
    );
    expect(resolved.stockLocationIds).toEqual(["sloc_1", "sloc_2"]);
  });

  it("drops blank entries", () => {
    const resolved = resolveAllegroOptions(validOptions({ stockLocationIds: ["sloc_1", "  "] }));
    expect(resolved.stockLocationIds).toEqual(["sloc_1"]);
  });

  it("lets the env var win over the config", () => {
    withEnv("ALLEGRO_STOCK_LOCATION_IDS", "sloc_env, sloc_other", () => {
      const resolved = resolveAllegroOptions(validOptions({ stockLocationIds: ["sloc_config"] }));
      expect(resolved.stockLocationIds).toEqual(["sloc_env", "sloc_other"]);
    });
  });

  it("falls back to the config when the env var is blank", () => {
    withEnv("ALLEGRO_STOCK_LOCATION_IDS", "  ,  ", () => {
      const resolved = resolveAllegroOptions(validOptions({ stockLocationIds: ["sloc_config"] }));
      expect(resolved.stockLocationIds).toEqual(["sloc_config"]);
    });
  });

  it("rejects a non-array", () => {
    expect(() =>
      resolveAllegroOptions(validOptions({ stockLocationIds: "sloc_1" as never })),
    ).toThrow(/must be an array/);
  });
});

describe("SRP source", () => {
  it("accepts a metadata key alone", () => {
    expect(resolveAllegroOptions(validOptions({ srpMetadataKey: "srp" })).srpMetadataKey).toBe(
      "srp",
    );
  });

  it("accepts a price list alone", () => {
    expect(resolveAllegroOptions(validOptions({ srpPriceListId: "plist_1" })).srpPriceListId).toBe(
      "plist_1",
    );
  });

  it("rejects both at once", () => {
    // Two sources means an ambiguous ceiling, and the ceiling is what stops an
    // automation rule ratcheting a price down indefinitely.
    expect(() =>
      resolveAllegroOptions(validOptions({ srpMetadataKey: "srp", srpPriceListId: "plist_1" })),
    ).toThrow(/mutually exclusive/);
  });
});

describe("toPublicAllegroOptions", () => {
  it("carries the sync configuration but no secret material", () => {
    const resolved = resolveAllegroOptions(
      validOptions({
        automationRules: { promoted: "Store Sale", standard: "Store" },
        changeCap: 25,
        salesChannelId: "sc_1",
        srpMetadataKey: "srp",
        stockLocationIds: ["sloc_1"],
      }),
    );
    // Indexed access, so the absence assertions below can name a key that is not
    // in the public type at all - which is the whole point of them.
    const publicOptions = toPublicAllegroOptions(resolved) as unknown as Record<string, unknown>;

    expect(publicOptions).toMatchObject({
      automationRules: { promoted: "Store Sale", standard: "Store" },
      changeCap: 25,
      invoiceAttachDisabled: false,
      marketplaceId: DEFAULT_MARKETPLACE_ID,
      ordersSyncDisabled: false,
      salesChannelId: "sc_1",
      srpMetadataKey: "srp",
      stockLocationIds: ["sloc_1"],
      stockSyncDisabled: false,
    });
    for (const secret of ["clientId", "clientSecret", "encryptionKey", "backendUrl", "docsUrl"]) {
      expect(publicOptions[secret]).toBeUndefined();
    }
    // `invoiceModuleKey` stays out for the same reason `costsModuleKey` does: a
    // container key is wiring the admin has no use for, and every field in the public
    // type is one the UI actually renders.
    expect(publicOptions.invoiceModuleKey).toBeUndefined();
  });
});
