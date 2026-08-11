import { randomBytes } from "node:crypto";
import type { LoaderOptions } from "@medusajs/framework/types";
import type { AllegroPluginOptions } from "../../../lib/options";
import validateAllegroOptions from "../loaders/validate-options";

/**
 * The loader exists so a misconfigured plugin fails at boot rather than on the
 * first Allegro call in the middle of a merchant's workflow. These tests are the
 * proof that it actually does that: a bad key has to throw HERE, not later.
 */

const validOptions = (overrides: Partial<AllegroPluginOptions> = {}): AllegroPluginOptions => ({
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  clientId: "client-id",
  clientSecret: "client-secret",
  docsUrl: "https://example.com/allegro",
  encryptionKey: randomBytes(32).toString("base64"),
  ...overrides,
});

const loaderArgs = (options?: Partial<AllegroPluginOptions>) => {
  const logged: string[] = [];
  const args = {
    logger: { info: (message: string) => logged.push(message) },
    options,
  } as unknown as LoaderOptions<AllegroPluginOptions>;
  return { args, logged };
};

describe("validateAllegroOptions", () => {
  it("logs the resolved configuration on a healthy boot", async () => {
    const { args, logged } = loaderArgs(validOptions());

    await validateAllegroOptions(args);

    expect(logged[0]).toContain("configured for production");
    expect(logged[0]).toContain("/admin/allegro/oauth/callback");
    expect(logged[0]).toContain("price sync enabled");
  });

  it("names the kill-switch in the boot log when it is on", async () => {
    const { args, logged } = loaderArgs(validOptions({ priceSyncDisabled: true }));

    await validateAllegroOptions(args);

    expect(logged[0]).toContain("price sync DISABLED");
  });

  it("throws at load on an encryption key of the wrong length", async () => {
    const { args } = loaderArgs(validOptions({ encryptionKey: randomBytes(8).toString("base64") }));

    await expect(validateAllegroOptions(args)).rejects.toThrow(/base64-encoded 32-byte value/);
  });

  it("throws at load on a mangled base64 encryption key", async () => {
    const { args } = loaderArgs(
      validOptions({ encryptionKey: `$$$${randomBytes(32).toString("base64").slice(3)}` }),
    );

    await expect(validateAllegroOptions(args)).rejects.toThrow(/base64-encoded 32-byte value/);
  });

  it("throws at load on an all-zero encryption key", async () => {
    const { args } = loaderArgs(validOptions({ encryptionKey: "A".repeat(43) }));

    await expect(validateAllegroOptions(args)).rejects.toThrow(/zero bytes/);
  });

  it("throws at load when no options were configured at all", async () => {
    const { args } = loaderArgs();

    await expect(validateAllegroOptions(args)).rejects.toThrow(/no plugin options/);
  });

  it("logs nothing when it throws, so a bad boot cannot read as a good one", async () => {
    const { args, logged } = loaderArgs(validOptions({ encryptionKey: "A".repeat(43) }));

    await expect(validateAllegroOptions(args)).rejects.toThrow();
    expect(logged).toEqual([]);
  });

  it("survives a container with no logger", async () => {
    // `logger` is optional in the loader signature, and the resolution must not
    // depend on it: a validation error has to surface either way.
    const args = { options: validOptions() } as unknown as LoaderOptions<AllegroPluginOptions>;

    await expect(validateAllegroOptions(args)).resolves.toBeUndefined();
  });
});
