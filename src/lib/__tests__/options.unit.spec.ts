import { randomBytes } from "node:crypto";
import {
  DEFAULT_REDIRECT_PATH,
  DEFAULT_SCOPES,
  isPriceSyncDisabledByEnv,
  resolveAllegroOptions,
} from "../options";
import type { AllegroPluginOptions } from "../options";

const validOptions = (): AllegroPluginOptions => ({
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  clientId: "client-id",
  clientSecret: "client-secret",
  docsUrl: "https://example.com/allegro",
  encryptionKey: randomBytes(32).toString("base64"),
});

describe("resolveAllegroOptions", () => {
  it("applies the documented defaults", () => {
    const resolved = resolveAllegroOptions(validOptions());
    expect(resolved.environment).toBe("production");
    expect(resolved.redirectPath).toBe(DEFAULT_REDIRECT_PATH);
    expect(resolved.scopes).toBe(DEFAULT_SCOPES);
    expect(resolved.priceSyncDisabled).toBe(false);
    expect(resolved.backendUrl).toBeUndefined();
  });

  it("requests offer read, offer write and order read by default", () => {
    expect(DEFAULT_SCOPES.split(" ")).toEqual([
      "allegro:api:sale:offers:read",
      "allegro:api:sale:offers:write",
      "allegro:api:orders:read",
    ]);
  });

  it("throws when no options were supplied at all", () => {
    expect(() => resolveAllegroOptions()).toThrow(/no plugin options/);
  });

  it.each([
    "clientId",
    "clientSecret",
    "appName",
    "appVersion",
    "docsUrl",
    "encryptionKey",
  ] as const)("throws when %s is missing", (field) => {
    const options: Partial<AllegroPluginOptions> = validOptions();
    delete options[field];
    expect(() => resolveAllegroOptions(options)).toThrow(new RegExp(`\`${field}\` is required`));
  });

  it("rejects an unknown environment", () => {
    expect(() =>
      resolveAllegroOptions({
        ...validOptions(),
        environment: "staging" as never,
      }),
    ).toThrow(/must be "production" or "sandbox"/);
  });

  it("accepts sandbox", () => {
    expect(resolveAllegroOptions({ ...validOptions(), environment: "sandbox" }).environment).toBe(
      "sandbox",
    );
  });

  it("rejects an encryption key that is not 32 bytes, at boot", () => {
    expect(() =>
      resolveAllegroOptions({
        ...validOptions(),
        encryptionKey: randomBytes(8).toString("base64"),
      }),
    ).toThrow(/base64-encoded 32-byte value/);
  });

  it("rejects an all-zero encryption key at boot", () => {
    expect(() =>
      resolveAllegroOptions({ ...validOptions(), encryptionKey: "A".repeat(43) }),
    ).toThrow(/zero bytes/);
  });

  it("rejects app identity that Allegro's User-Agent rule would reject", () => {
    expect(() => resolveAllegroOptions({ ...validOptions(), appName: "My App" })).toThrow(
      /User-Agent token/,
    );
    expect(() => resolveAllegroOptions({ ...validOptions(), docsUrl: "not-a-url" })).toThrow(
      /valid absolute URL/,
    );
  });

  it("rejects a redirectPath that is not rooted", () => {
    expect(() =>
      resolveAllegroOptions({
        ...validOptions(),
        redirectPath: "admin/allegro/cb",
      }),
    ).toThrow(/must start with/);
  });

  it("rejects a protocol-relative redirectPath, which would move the redirect_uri off-origin", () => {
    expect(() => resolveAllegroOptions({ ...validOptions(), redirectPath: "//host/x" })).toThrow(
      /protocol-relative/,
    );
  });

  it("rejects a relative backendUrl", () => {
    expect(() => resolveAllegroOptions({ ...validOptions(), backendUrl: "/backend" })).toThrow(
      /absolute URL/,
    );
  });

  it("rejects a non-boolean priceSyncDisabled instead of failing open", () => {
    expect(() =>
      resolveAllegroOptions({
        ...validOptions(),
        priceSyncDisabled: "true" as never,
      }),
    ).toThrow(/must be a boolean/);
    expect(() =>
      resolveAllegroOptions({
        ...validOptions(),
        priceSyncDisabled: "true" as never,
      }),
    ).toThrow(/ALLEGRO_PRICE_SYNC_DISABLED/);
  });

  it("still accepts an explicit false for priceSyncDisabled", () => {
    expect(
      resolveAllegroOptions({ ...validOptions(), priceSyncDisabled: false }).priceSyncDisabled,
    ).toBe(false);
  });

  it("falls back to the default scopes when an empty string is given", () => {
    expect(resolveAllegroOptions({ ...validOptions(), scopes: "   " }).scopes).toBe(DEFAULT_SCOPES);
  });

  it("honours the priceSyncDisabled option", () => {
    expect(
      resolveAllegroOptions({ ...validOptions(), priceSyncDisabled: true }).priceSyncDisabled,
    ).toBe(true);
  });

  it("lets the environment kill-switch override a config that leaves it on", () => {
    const previous = process.env.ALLEGRO_PRICE_SYNC_DISABLED;
    process.env.ALLEGRO_PRICE_SYNC_DISABLED = "yes";
    try {
      expect(
        resolveAllegroOptions({ ...validOptions(), priceSyncDisabled: false }).priceSyncDisabled,
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLEGRO_PRICE_SYNC_DISABLED;
      } else {
        process.env.ALLEGRO_PRICE_SYNC_DISABLED = previous;
      }
    }
  });
});

describe("isPriceSyncDisabledByEnv", () => {
  it.each(["1", "true", "TRUE", "yes", " Yes "])("treats %p as disabled", (value) => {
    expect(isPriceSyncDisabledByEnv({ ALLEGRO_PRICE_SYNC_DISABLED: value })).toBe(true);
  });

  it.each(["0", "false", "no", "", undefined])("treats %p as enabled", (value) => {
    expect(isPriceSyncDisabledByEnv({ ALLEGRO_PRICE_SYNC_DISABLED: value })).toBe(false);
  });
});
