import { randomBytes } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import { encryptValue } from "../../../lib/crypto";
import type { AllegroPluginOptions } from "../../../lib/options";
import AllegroModuleService from "../service";

/**
 * These are unit tests, not module-integration tests.
 *
 * Medusa's `medusa-test-utils` module suite wants a live Postgres, which CI does
 * not stand up for the unit job. What matters here is behaviour that lives in
 * the service and not in the database: which row a read picks, whether a write
 * replaces or appends, what survives a refresh, and what does NOT come back out
 * of `getConnectionStatus`. All of that is observable against a fake table, so
 * the generated CRUD methods are replaced with one.
 *
 * The base `MedusaService` constructor is still the real one - it only needs
 * `container.baseRepository`, and the transaction decorators on `persistToken`
 * run against the fake below, which is the point: the test proves the two writes
 * really do share a transaction.
 */

const KEY = randomBytes(32).toString("base64");

interface AuthRow {
  id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: Date;
  connected_at: Date;
  account_login: string | null;
  scope: string | null;
  created_at: Date;
}

const validOptions = (overrides: Partial<AllegroPluginOptions> = {}): AllegroPluginOptions => ({
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  clientId: "client-id",
  clientSecret: "client-secret",
  docsUrl: "https://example.com/allegro",
  encryptionKey: KEY,
  ...overrides,
});

const authRow = (overrides: Partial<AuthRow> = {}): AuthRow => ({
  access_token_encrypted: encryptValue("access", KEY),
  account_login: "seller",
  connected_at: new Date("2026-01-01T00:00:00.000Z"),
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  expires_at: new Date("2026-01-01T12:00:00.000Z"),
  id: "algauth_1",
  refresh_token_encrypted: encryptValue("refresh", KEY),
  scope: "allegro:api:sale:offers:read",
  ...overrides,
});

interface ListConfig {
  order?: Record<string, "ASC" | "DESC">;
  take?: number;
}

/** In-memory stand-in for the `allegro_auth` table. */
const fakeTable = (initial: AuthRow[] = []) => {
  const rows: AuthRow[] = [...initial];
  let sequence = initial.length;
  const transactions: string[] = [];

  return {
    create: (data: Partial<AuthRow>[]) => {
      const created = data.map((entry) => {
        sequence += 1;
        const row: AuthRow = {
          ...authRow(),
          created_at: new Date(Date.UTC(2026, 5, sequence)),
          id: `algauth_${sequence}`,
          ...entry,
        } as AuthRow;
        rows.push(row);
        return { ...row };
      });
      return Promise.resolve(created);
    },
    delete: (ids: string[]) => {
      for (const id of ids) {
        const index = rows.findIndex((row) => row.id === id);
        if (index !== -1) {
          rows.splice(index, 1);
        }
      }
      return Promise.resolve();
    },
    list: (_filters?: unknown, config: ListConfig = {}) => {
      let out = [...rows];
      const direction = config.order?.created_at;
      if (direction) {
        const sign = direction === "DESC" ? -1 : 1;
        out.sort((a, b) => sign * (a.created_at.getTime() - b.created_at.getTime()));
      }
      if (config.take !== undefined) {
        out = out.slice(0, config.take);
      }
      return Promise.resolve(out.map((row) => ({ ...row })));
    },
    rows,
    transactions,
    update: (data: (Partial<AuthRow> & { id: string })[]) => {
      for (const entry of data) {
        const index = rows.findIndex((row) => row.id === entry.id);
        if (index !== -1) {
          rows[index] = { ...rows[index], ...entry };
        }
      }
      return Promise.resolve(data);
    },
  };
};

type FakeTable = ReturnType<typeof fakeTable>;

interface SettingsRow {
  id: string;
  price_sync_enabled: boolean;
  stock_sync_enabled: boolean;
  orders_sync_enabled: boolean;
  fulfillment_writeback_enabled: boolean;
  invoice_attach_enabled: boolean;
  automation_rule_standard: string | null;
  automation_rule_promoted: string | null;
  srp_metadata_key: string | null;
  srp_price_list_id: string | null;
  change_cap: number | null;
  marketplace_id: string | null;
  sales_channel_id: string | null;
  sales_channel_name: string | null;
}

/**
 * In-memory stand-in for the `allegro_settings` singleton.
 *
 * Seed a row to test a specific arming; leave it empty and the service's first read
 * creates the fresh-install defaults (writers off, invoice-attach on), exactly as the
 * real lazy singleton does against Postgres.
 */
const fakeSettings = (seed?: Partial<SettingsRow>) => {
  const rows: SettingsRow[] = seed
    ? [
        {
          automation_rule_promoted: null,
          automation_rule_standard: null,
          change_cap: null,
          fulfillment_writeback_enabled: false,
          id: "algset_singleton",
          invoice_attach_enabled: true,
          marketplace_id: null,
          orders_sync_enabled: false,
          price_sync_enabled: false,
          sales_channel_id: null,
          sales_channel_name: null,
          srp_metadata_key: null,
          srp_price_list_id: null,
          stock_sync_enabled: false,
          ...seed,
        },
      ]
    : [];

  return {
    create: (data: Partial<SettingsRow>[]) => {
      const created = data.map((entry) => {
        const row = { id: "algset_singleton", ...entry } as SettingsRow;
        rows.push(row);
        return { ...row };
      });
      return Promise.resolve(created);
    },
    list: (filters: { id?: string } = {}, config: { take?: number } = {}) => {
      let out = rows.filter((row) => (filters.id ? row.id === filters.id : true));
      if (config.take !== undefined) {
        out = out.slice(0, config.take);
      }
      return Promise.resolve(out.map((row) => ({ ...row })));
    },
    rows,
    update: (data: (Partial<SettingsRow> & { id: string })[]) => {
      for (const entry of data) {
        const index = rows.findIndex((row) => row.id === entry.id);
        if (index !== -1) {
          rows[index] = { ...rows[index], ...entry } as SettingsRow;
        }
      }
      return Promise.resolve(data);
    },
  };
};

type FakeSettings = ReturnType<typeof fakeSettings>;

const makeService = (
  table: FakeTable,
  options: AllegroPluginOptions = validOptions(),
  logger?: { warn: (message: string) => void },
  settings: FakeSettings = fakeSettings(),
) => {
  const container = {
    baseRepository: {
      getFreshManager: () => ({}),
      serialize: <T>(value: T) => Promise.resolve(value),
      transaction: async <T>(work: (manager: unknown) => Promise<T>) => {
        table.transactions.push("open");
        const result = await work({ marker: "tx" });
        table.transactions.push("commit");
        return result;
      },
    },
    logger,
  };

  const service = new AllegroModuleService(container as never, options);

  // Replace the auto-generated CRUD with the fake table. Assigning on the
  // instance shadows the prototype methods the factory installed.
  Object.assign(service as unknown as Record<string, unknown>, {
    createAllegroAuths: table.create,
    createAllegroSettings: settings.create,
    deleteAllegroAuths: table.delete,
    listAllegroAuths: table.list,
    listAllegroSettings: settings.list,
    updateAllegroAuths: table.update,
    updateAllegroSettings: settings.update,
  });

  return service;
};

/** `getStoredAuth` is protected; the tests reach it the way callers do not. */
const storedAuth = (service: AllegroModuleService) =>
  (
    service as unknown as {
      getStoredAuth: () => Promise<Record<string, unknown> | undefined>;
    }
  ).getStoredAuth();

describe("getStoredAuth", () => {
  it("picks the newest row when two are present", async () => {
    const table = fakeTable([
      authRow({
        access_token_encrypted: encryptValue("stale", KEY),
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        id: "algauth_old",
      }),
      authRow({
        access_token_encrypted: encryptValue("live", KEY),
        created_at: new Date("2026-02-01T00:00:00.000Z"),
        id: "algauth_new",
      }),
    ]);

    const row = await storedAuth(makeService(table));

    expect(row?.id).toBe("algauth_new");
  });

  it("warns when more than one row is present, rather than hiding it", async () => {
    const warn = jest.fn();
    const table = fakeTable([
      authRow({ created_at: new Date("2026-01-01T00:00:00.000Z"), id: "a" }),
      authRow({ created_at: new Date("2026-02-01T00:00:00.000Z"), id: "b" }),
    ]);

    await storedAuth(makeService(table, validOptions(), { warn }));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("more than one allegro_auth row"));
  });

  it("stays quiet with a single row", async () => {
    const warn = jest.fn();

    await storedAuth(makeService(fakeTable([authRow()]), validOptions(), { warn }));

    expect(warn).not.toHaveBeenCalled();
  });

  it("returns undefined when nothing is stored", async () => {
    expect(await storedAuth(makeService(fakeTable()))).toBeUndefined();
  });
});

describe("persistToken", () => {
  it("replaces the stored row instead of appending to it", async () => {
    const table = fakeTable([authRow({ id: "algauth_old" })]);
    const service = makeService(table);

    await service.persistToken(
      { accessToken: "AT2", expiresAt: Date.now() + 3_600_000, refreshToken: "RT2" },
      { accountLogin: "other-seller" },
    );

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.id).not.toBe("algauth_old");
  });

  it("carries forward neither account_login nor scope from the replaced row", async () => {
    // A reconnect can legitimately be a different Allegro account; inheriting
    // the previous row's display fields would misreport what is connected.
    const table = fakeTable([
      authRow({ account_login: "old-seller", id: "algauth_old", scope: "old:scope" }),
    ]);
    const service = makeService(table);

    await service.persistToken({ accessToken: "AT2", expiresAt: Date.now() + 3_600_000 });

    expect(table.rows[0]?.account_login).toBeNull();
    expect(table.rows[0]?.scope).toBeNull();
  });

  it("stores NULL rather than an envelope when there is no refresh token", async () => {
    const table = fakeTable();

    await makeService(table).persistToken({
      accessToken: "AT",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(table.rows[0]?.refresh_token_encrypted).toBeNull();
  });

  it("runs the insert and the delete inside one transaction", async () => {
    const table = fakeTable([authRow({ id: "algauth_old" })]);

    await makeService(table).persistToken({
      accessToken: "AT2",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(table.transactions).toEqual(["open", "commit"]);
  });

  it("encrypts both tokens, so no plaintext reaches the row", async () => {
    const table = fakeTable();

    await makeService(table).persistToken({
      accessToken: "plain-access",
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "plain-refresh",
    });

    const row = table.rows[0];
    expect(row?.access_token_encrypted).not.toContain("plain-access");
    expect(row?.refresh_token_encrypted).not.toContain("plain-refresh");
  });
});

describe("persistRefreshedToken", () => {
  it("preserves connected_at and account_login", async () => {
    const connectedAt = new Date("2026-01-01T00:00:00.000Z");
    const table = fakeTable([authRow({ account_login: "seller", connected_at: connectedAt })]);

    await makeService(table).persistRefreshedToken({
      accessToken: "AT2",
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "RT2",
    });

    expect(table.rows[0]?.connected_at).toEqual(connectedAt);
    expect(table.rows[0]?.account_login).toBe("seller");
    expect(table.rows).toHaveLength(1);
  });

  it("leaves the stored scope alone when the refresh reports none", async () => {
    // Allegro omits `scope` from a refresh response; overwriting the granted
    // scopes with undefined would make the admin report none.
    const table = fakeTable([authRow({ scope: "allegro:api:sale:offers:read" })]);

    await makeService(table).persistRefreshedToken({
      accessToken: "AT2",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(table.rows[0]?.scope).toBe("allegro:api:sale:offers:read");
  });

  it("writes the scope when the refresh does report one", async () => {
    const table = fakeTable([authRow({ scope: "old:scope" })]);

    await makeService(table).persistRefreshedToken({
      accessToken: "AT2",
      expiresAt: Date.now() + 3_600_000,
      scope: "new:scope",
    });

    expect(table.rows[0]?.scope).toBe("new:scope");
  });

  it("drops a refreshed token when no row exists, rather than resurrecting one", async () => {
    // The connection was disconnected mid-flight; recreating it would restore
    // access the operator just revoked.
    const table = fakeTable();

    await makeService(table).persistRefreshedToken({
      accessToken: "AT",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(table.rows).toHaveLength(0);
  });
});

describe("loadToken", () => {
  it("round-trips what persistToken wrote", async () => {
    const table = fakeTable();
    const service = makeService(table);
    const expiresAt = Date.UTC(2026, 5, 1, 12);

    await service.persistToken({ accessToken: "AT", expiresAt, refreshToken: "RT" });

    expect(await service.loadToken()).toEqual({
      accessToken: "AT",
      expiresAt,
      refreshToken: "RT",
      scope: undefined,
    });
  });

  it("reports refreshToken as undefined when the column is NULL", async () => {
    const table = fakeTable([authRow({ refresh_token_encrypted: null })]);

    const token = await makeService(table).loadToken();

    expect(token?.accessToken).toBe("access");
    expect(token?.refreshToken).toBeUndefined();
  });

  it("returns undefined when nothing is stored", async () => {
    expect(await makeService(fakeTable()).loadToken()).toBeUndefined();
  });
});

describe("buildRedirectUri", () => {
  const backendEnv = process.env.MEDUSA_BACKEND_URL;

  afterEach(() => {
    if (backendEnv === undefined) {
      delete process.env.MEDUSA_BACKEND_URL;
    } else {
      process.env.MEDUSA_BACKEND_URL = backendEnv;
    }
  });

  it("prefers the pinned backendUrl option over everything else", async () => {
    process.env.MEDUSA_BACKEND_URL = "https://from-env.example";
    const service = makeService(
      fakeTable(),
      validOptions({ backendUrl: "https://pinned.example" }),
    );

    expect(await service.getRedirectUri("https://request.example")).toBe(
      "https://pinned.example/admin/allegro/oauth/callback",
    );
  });

  it("falls back to MEDUSA_BACKEND_URL", async () => {
    process.env.MEDUSA_BACKEND_URL = "https://from-env.example";

    expect(await makeService(fakeTable()).getRedirectUri("https://request.example")).toBe(
      "https://from-env.example/admin/allegro/oauth/callback",
    );
  });

  it("falls back to the request origin when MEDUSA_BACKEND_URL is empty", async () => {
    // "" is not nullish, so a `??` chain would stop here and refuse to use the
    // request origin at all.
    process.env.MEDUSA_BACKEND_URL = "";

    expect(await makeService(fakeTable()).getRedirectUri("https://request.example")).toBe(
      "https://request.example/admin/allegro/oauth/callback",
    );
  });

  it("falls back to the request origin when MEDUSA_BACKEND_URL is whitespace", async () => {
    process.env.MEDUSA_BACKEND_URL = "   ";

    expect(await makeService(fakeTable()).getRedirectUri("https://request.example")).toBe(
      "https://request.example/admin/allegro/oauth/callback",
    );
  });

  it("throws a MedusaError when nothing resolves", async () => {
    delete process.env.MEDUSA_BACKEND_URL;

    // A rejection, not a synchronous throw: the method declares a Promise, so a
    // caller reaching for `.catch()` has to actually get one. `MedusaError`
    // leaves `name` as "Error" and carries its taxonomy on `type`.
    const rejection = makeService(fakeTable()).getRedirectUri();

    await expect(rejection).rejects.toBeInstanceOf(MedusaError);
    await expect(rejection).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE });
  });

  it("throws when MEDUSA_BACKEND_URL is empty and there is no request origin either", async () => {
    process.env.MEDUSA_BACKEND_URL = "  ";

    await expect(makeService(fakeTable()).getRedirectUri()).rejects.toThrow(
      /cannot determine the OAuth redirect URI/,
    );
  });
});

describe("getConnectionStatus", () => {
  const SECRET_SHAPED = /token|secret|encrypt|key/i;

  /**
   * One field name legitimately contains "token" while carrying no token:
   * `refreshTokenMissing` is a boolean describing the health of a credential the
   * caller never sees. It is allowlisted by name rather than the pattern being
   * loosened, so a field actually called `refreshToken` still trips this.
   */
  const ALLOWED_SECRET_SHAPED_KEYS = new Set(["refreshTokenMissing"]);

  const secretShapedKeys = (status: object) =>
    Object.keys(status).filter(
      (name) => SECRET_SHAPED.test(name) && !ALLOWED_SECRET_SHAPED_KEYS.has(name),
    );

  it("returns no key that looks like secret material", async () => {
    const status = await makeService(fakeTable([authRow()])).getConnectionStatus();

    expect(secretShapedKeys(status)).toEqual([]);
  });

  it("returns no key that looks like secret material when disconnected either", async () => {
    const status = await makeService(fakeTable()).getConnectionStatus();

    expect(secretShapedKeys(status)).toEqual([]);
    expect(status.connected).toBe(false);
  });

  it("never carries an envelope, a plaintext token, or the key in any value", async () => {
    // The stronger form of the same guard: whatever the fields end up called,
    // none of them may hold secret material.
    const row = authRow();
    const status = await makeService(fakeTable([row])).getConnectionStatus();
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain(row.access_token_encrypted);
    expect(serialized).not.toContain(row.refresh_token_encrypted);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("client-secret");
    expect(Object.keys(status).filter((name) => name.endsWith("_encrypted"))).toEqual([]);
  });

  it("marks a past expires_at as expired", async () => {
    const table = fakeTable([authRow({ expires_at: new Date("2020-01-01T00:00:00.000Z") })]);

    expect((await makeService(table).getConnectionStatus()).expired).toBe(true);
  });

  it("does not mark a future expires_at as expired", async () => {
    const table = fakeTable([authRow({ expires_at: new Date(Date.now() + 3_600_000) })]);

    expect((await makeService(table).getConnectionStatus()).expired).toBe(false);
  });

  it("flags a missing refresh token", async () => {
    const table = fakeTable([authRow({ refresh_token_encrypted: null })]);

    expect((await makeService(table).getConnectionStatus()).refreshTokenMissing).toBe(true);
  });

  it("reports credentialsUnreadable rather than a healthy Connected", async () => {
    // The row was sealed with a key that is no longer configured.
    const table = fakeTable([
      authRow({
        access_token_encrypted: encryptValue("access", randomBytes(32).toString("base64")),
      }),
    ]);

    const status = await makeService(table).getConnectionStatus();

    expect(status.connected).toBe(true);
    expect(status.credentialsUnreadable).toBe(true);
  });

  it("reports readable credentials as readable", async () => {
    const status = await makeService(fakeTable([authRow()])).getConnectionStatus();

    expect(status.credentialsUnreadable).toBe(false);
  });
});

describe("getPublicOptions", () => {
  /**
   * Option names that trip the credential heuristic below without being credentials.
   *
   * The allowlist exists so the tripwire stays sharp rather than being loosened.
   * `srpMetadataKey` is the NAME of a variant metadata field the operator chose,
   * shown in the admin so somebody can see where the SRP ceiling is read from - not
   * secret material. Anything added here needs that argument made explicitly.
   */
  const NOT_SECRETS = new Set(["srpMetadataKey"]);

  it("returns no key that looks like secret material", async () => {
    const options = await makeService(fakeTable()).getPublicOptions();

    expect(
      Object.keys(options).filter(
        (name) => /secret|token|key|encrypt/i.test(name) && !NOT_SECRETS.has(name),
      ),
    ).toEqual([]);
  });

  it("does not carry the client secret or the encryption key in any value", async () => {
    const options = await makeService(fakeTable()).getPublicOptions();
    const serialized = JSON.stringify(options);

    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain(KEY);
  });

  it("still answers the questions the admin asks", async () => {
    const options = await makeService(fakeTable()).getPublicOptions();

    expect(options).toEqual({
      appName: "MedusaAllegro",
      appVersion: "0.1.0",
      // Undefined rather than absent, and asserted so: the admin distinguishes
      // "not configured" (price sync inert, SRP unresolvable) from a default, and
      // a key silently disappearing from this shape would break that.
      automationRules: undefined,
      changeCap: 100,
      environment: "production",
      invoiceAttachDisabled: false,
      marketplaceId: "allegro-pl",
      ordersSyncDisabled: false,
      priceSyncDisabled: false,
      pricingMode: "automation_rule",
      redirectPath: "/admin/allegro/oauth/callback",
      salesChannelId: undefined,
      salesChannelName: undefined,
      scopes: expect.stringContaining("allegro:api:sale:offers:read"),
      srpMetadataKey: undefined,
      srpPriceListId: undefined,
      stockLocationIds: [],
      stockSyncDisabled: false,
    });
  });
});

describe("runtime toggles", () => {
  it("defaults every writer OFF on a fresh install, except invoice attach", async () => {
    // The safe fresh-install posture: nothing reaches the marketplace until an operator
    // arms it. Invoice attach is the one writer that defaults on, because the document
    // already exists by the time its event lands - it is enabled-but-inert until wired.
    const service = makeService(fakeTable());

    expect(await service.isPriceSyncDisabled()).toBe(true);
    expect(await service.isStockSyncDisabled()).toBe(true);
    expect(await service.isOrdersSyncDisabled()).toBe(true);
    expect(await service.isFulfillmentWritebackDisabled()).toBe(true);
    expect(await service.isInvoiceAttachDisabled()).toBe(false);
  });

  it("honours a persisted toggle once it is armed", async () => {
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ price_sync_enabled: true }),
    );

    expect(await service.isPriceSyncDisabled()).toBe(false);
  });

  it("respects a flip of the persisted toggle without reconstructing the service", async () => {
    // The property a redeploy-free kill switch needs: the job/subscriber re-reads the
    // persisted row each tick, so an operator arming a writer takes effect on the next
    // run against the SAME service instance.
    const settings = fakeSettings({ stock_sync_enabled: false });
    const service = makeService(fakeTable(), validOptions(), undefined, settings);

    expect(await service.isStockSyncDisabled()).toBe(true);

    await service.updateSettings({ stock_sync_enabled: true });

    expect(await service.isStockSyncDisabled()).toBe(false);
  });

  it("lets the environment force a writer off even when the toggle is armed", async () => {
    // Precedence: persisted on + env off = off. The override can only force off, and a
    // set override beats a persisted `true`.
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ price_sync_enabled: true }),
    );
    const previous = process.env.ALLEGRO_PRICE_SYNC_DISABLED;
    process.env.ALLEGRO_PRICE_SYNC_DISABLED = "1";
    try {
      expect(await service.isPriceSyncDisabled()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLEGRO_PRICE_SYNC_DISABLED;
      } else {
        process.env.ALLEGRO_PRICE_SYNC_DISABLED = previous;
      }
    }
  });

  it("keeps a writer off when it is neither armed nor overridden", async () => {
    // Precedence: persisted off + env unset = off.
    const service = makeService(fakeTable(), validOptions(), undefined, fakeSettings());

    expect(await service.isOrdersSyncDisabled()).toBe(true);
  });

  it("keeps invoice attach independent of the order drain", async () => {
    // Pausing the import to stop a runaway must not also stop an issued invoice reaching
    // the buyer, and vice versa.
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ invoice_attach_enabled: true, orders_sync_enabled: true }),
    );

    expect(await service.isOrdersSyncDisabled()).toBe(false);
    expect(await service.isInvoiceAttachDisabled()).toBe(false);
  });

  it("re-reads the environment override rather than the value captured at boot", async () => {
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ invoice_attach_enabled: true }),
    );
    const previous = process.env.ALLEGRO_INVOICE_ATTACH_DISABLED;
    process.env.ALLEGRO_INVOICE_ATTACH_DISABLED = "1";
    try {
      // An operator setting this is responding to an incident, and a value read once at
      // construction would ignore them until a restart.
      expect(await service.isInvoiceAttachDisabled()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLEGRO_INVOICE_ATTACH_DISABLED;
      } else {
        process.env.ALLEGRO_INVOICE_ATTACH_DISABLED = previous;
      }
    }
  });

  it("surfaces every writer's persisted, forced and effective state for the admin", async () => {
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ price_sync_enabled: true, stock_sync_enabled: true }),
    );
    const previous = process.env.ALLEGRO_STOCK_SYNC_DISABLED;
    process.env.ALLEGRO_STOCK_SYNC_DISABLED = "1";
    try {
      const states = await service.getRuntimeToggleStates();
      const price = states.find((state) => state.key === "priceSync");
      const stock = states.find((state) => state.key === "stockSync");

      // Armed and not overridden: effective on.
      expect(price).toMatchObject({
        effectiveEnabled: true,
        forceDisabled: false,
        persistedEnabled: true,
      });
      // Armed but overridden: persisted stays true, but effective is off and the UI can
      // say "forced off by environment" rather than lying about it.
      expect(stock).toMatchObject({
        effectiveEnabled: false,
        forceDisabled: true,
        persistedEnabled: true,
      });
      expect(states).toHaveLength(5);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLEGRO_STOCK_SYNC_DISABLED;
      } else {
        process.env.ALLEGRO_STOCK_SYNC_DISABLED = previous;
      }
    }
  });
});

/**
 * `getSyncOptions` used to read these eight fields straight off `this.options_`,
 * fixed until a redeploy. These tests pin the precedence that replaced that:
 * environment lock, then the persisted admin value, then the same
 * `medusa-config.ts` default as before - so a store that never touches the new
 * admin fields gets exactly the old behaviour.
 */
describe("getSyncOptions - editable configuration precedence", () => {
  it("falls back to the medusa-config default when nothing is persisted or locked", async () => {
    const service = makeService(
      fakeTable(),
      validOptions({
        automationRules: { promoted: "Cfg Promoted", standard: "Cfg Standard" },
        changeCap: 42,
        marketplaceId: "cfg-marketplace",
        salesChannelId: "sc_cfg",
        salesChannelName: "Cfg Channel",
        srpMetadataKey: "cfg_srp_meta",
      }),
    );

    const options = await service.getSyncOptions();

    expect(options).toMatchObject({
      automationRules: { promoted: "Cfg Promoted", standard: "Cfg Standard" },
      changeCap: 42,
      marketplaceId: "cfg-marketplace",
      salesChannelId: "sc_cfg",
      salesChannelName: "Cfg Channel",
      srpMetadataKey: "cfg_srp_meta",
    });
  });

  it("reads the persisted admin value over the medusa-config default", async () => {
    const service = makeService(
      fakeTable(),
      validOptions({ changeCap: 100, marketplaceId: "cfg-marketplace" }),
      undefined,
      fakeSettings({ change_cap: 7, marketplace_id: "admin-marketplace" }),
    );

    const options = await service.getSyncOptions();

    expect(options.changeCap).toBe(7);
    expect(options.marketplaceId).toBe("admin-marketplace");
  });

  it("lets an environment lock win over a persisted admin edit - the wiring-critical fields", async () => {
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ marketplace_id: "admin-marketplace", sales_channel_id: "sc_admin" }),
    );
    const previousMarketplace = process.env.ALLEGRO_MARKETPLACE_ID;
    const previousChannel = process.env.ALLEGRO_SALES_CHANNEL_ID;
    process.env.ALLEGRO_MARKETPLACE_ID = "locked-marketplace";
    process.env.ALLEGRO_SALES_CHANNEL_ID = "sc_locked";
    try {
      const options = await service.getSyncOptions();
      expect(options.marketplaceId).toBe("locked-marketplace");
      expect(options.salesChannelId).toBe("sc_locked");
    } finally {
      if (previousMarketplace === undefined) {
        delete process.env.ALLEGRO_MARKETPLACE_ID;
      } else {
        process.env.ALLEGRO_MARKETPLACE_ID = previousMarketplace;
      }
      if (previousChannel === undefined) {
        delete process.env.ALLEGRO_SALES_CHANNEL_ID;
      } else {
        process.env.ALLEGRO_SALES_CHANNEL_ID = previousChannel;
      }
    }
  });

  it("treats a half-resolved automation rule pair as inert, same as the medusa-config-only path", async () => {
    // Only the standard rule is persisted; nothing configures a promoted rule. A real
    // assignment needs both names, so this must read the same as neither being set.
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({ automation_rule_standard: "Admin Standard" }),
    );

    const options = await service.getSyncOptions();

    expect(options.automationRules).toBeUndefined();
  });

  it("resolves a full automation rule pair once both halves are persisted", async () => {
    const service = makeService(
      fakeTable(),
      validOptions(),
      undefined,
      fakeSettings({
        automation_rule_promoted: "Admin Promoted",
        automation_rule_standard: "Admin Standard",
      }),
    );

    const options = await service.getSyncOptions();

    expect(options.automationRules).toEqual({
      promoted: "Admin Promoted",
      standard: "Admin Standard",
    });
  });
});

describe("getConfigFieldStates", () => {
  it("surfaces every field's persisted, locked, defaulted and effective value", async () => {
    const service = makeService(
      fakeTable(),
      validOptions({ marketplaceId: "cfg-marketplace" }),
      undefined,
      fakeSettings({ marketplace_id: "admin-marketplace" }),
    );
    const previous = process.env.ALLEGRO_MARKETPLACE_ID;
    process.env.ALLEGRO_MARKETPLACE_ID = "locked-marketplace";
    try {
      const states = await service.getConfigFieldStates();
      const marketplace = states.find((state) => state.key === "marketplaceId");

      expect(marketplace).toMatchObject({
        configDefault: "cfg-marketplace",
        effectiveValue: "locked-marketplace",
        envOverride: "locked-marketplace",
        locked: true,
        persistedValue: "admin-marketplace",
        wiringCritical: true,
      });
      expect(states).toHaveLength(9);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLEGRO_MARKETPLACE_ID;
      } else {
        process.env.ALLEGRO_MARKETPLACE_ID = previous;
      }
    }
  });

  it("reports an unlocked, unedited field with only its medusa-config default", async () => {
    const service = makeService(fakeTable(), validOptions({ changeCap: 42 }));

    const states = await service.getConfigFieldStates();
    const changeCap = states.find((state) => state.key === "changeCap");

    expect(changeCap).toMatchObject({
      configDefault: 42,
      effectiveValue: 42,
      envOverride: null,
      locked: false,
      persistedValue: null,
    });
  });
});

describe("updateSettings - configuration field writes", () => {
  it("persists a configuration field and reflects it in getSyncOptions without reconstructing the service", async () => {
    // The property a redeploy-free config edit needs: the same instance that served
    // the old value serves the new one on its very next call.
    const settings = fakeSettings();
    const service = makeService(fakeTable(), validOptions({ changeCap: 100 }), undefined, settings);

    expect((await service.getSyncOptions()).changeCap).toBe(100);

    await service.updateSettings({ change_cap: 7 });

    expect((await service.getSyncOptions()).changeCap).toBe(7);
  });

  it("clears a persisted configuration field back to the medusa-config default with null", async () => {
    const settings = fakeSettings({ marketplace_id: "admin-marketplace" });
    const service = makeService(
      fakeTable(),
      validOptions({ marketplaceId: "cfg-marketplace" }),
      undefined,
      settings,
    );

    await service.updateSettings({ marketplace_id: null });

    expect((await service.getSyncOptions()).marketplaceId).toBe("cfg-marketplace");
  });

  it("rejects a write that would make the two automation rule names collide", async () => {
    // The medusa-config default already carries a promoted rule name. Persisting the
    // SAME name as the standard rule newly collides them - a case the boot-time check
    // in `resolveAutomationRules` cannot catch, because it only ever saw the config.
    const service = makeService(
      fakeTable(),
      validOptions({ automationRules: { promoted: "Store Sale", standard: "Store" } }),
      undefined,
      fakeSettings(),
    );

    await expect(
      service.updateSettings({ automation_rule_standard: "Store Sale" }),
    ).rejects.toBeInstanceOf(MedusaError);
  });

  it("rejects a write that would set both SRP sources at once", async () => {
    const service = makeService(
      fakeTable(),
      validOptions({ srpPriceListId: "pl_cfg" }),
      undefined,
      fakeSettings(),
    );

    await expect(service.updateSettings({ srp_metadata_key: "admin_meta" })).rejects.toBeInstanceOf(
      MedusaError,
    );
  });

  it("allows a write that clears one SRP source while the other stays configured", async () => {
    const settings = fakeSettings({ srp_metadata_key: "admin_meta" });
    const service = makeService(
      fakeTable(),
      validOptions({ srpPriceListId: "pl_cfg" }),
      undefined,
      settings,
    );

    // Clearing the metadata key leaves only the price list id in play - no collision.
    await expect(service.updateSettings({ srp_metadata_key: null })).resolves.toBeDefined();
  });

  it("allows a write that does not touch either half of a colliding pair", async () => {
    // A write to an unrelated column must never run the collision check against
    // stale state and fail for a field the operator did not even touch.
    const service = makeService(
      fakeTable(),
      validOptions({ automationRules: { promoted: "Store Sale", standard: "Store" } }),
      undefined,
      fakeSettings(),
    );

    await expect(service.updateSettings({ change_cap: 5 })).resolves.toBeDefined();
  });
});

describe("getClient", () => {
  it("memoizes one client, so the SDK refresh de-duplication applies", async () => {
    const service = makeService(fakeTable([authRow()]));

    const [first, second] = await Promise.all([service.getClient(), service.getClient()]);

    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it("drops the memo when the connection is replaced", async () => {
    const service = makeService(fakeTable([authRow()]));
    const before = await service.getClient();

    await service.persistToken({ accessToken: "AT2", expiresAt: Date.now() + 3_600_000 });

    expect(await service.getClient()).not.toBe(before);
  });

  it("drops the memo when the connection is deleted", async () => {
    const table = fakeTable([authRow()]);
    const service = makeService(table);
    await service.getClient();

    await service.deleteConnection();

    expect(await service.getClient()).toBeNull();
  });

  it("returns null when nothing is connected", async () => {
    expect(await makeService(fakeTable()).getClient()).toBeNull();
  });
});

describe("deleteConnection", () => {
  it("is idempotent", async () => {
    const table = fakeTable([authRow()]);
    const service = makeService(table);

    await service.deleteConnection();
    await service.deleteConnection();

    expect(table.rows).toHaveLength(0);
  });
});
