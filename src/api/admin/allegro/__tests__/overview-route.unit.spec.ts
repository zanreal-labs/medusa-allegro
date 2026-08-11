import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { GET } from "../route";

/**
 * GET /admin/allegro is what the settings page loads, so it is the one response
 * body in this plugin that reaches a browser. The assertion that matters is
 * negative: no token envelope, no key, no secret, whatever fields get added
 * later.
 */

const connectionStatus = {
  accountLogin: "seller",
  connected: true,
  connectedAt: new Date("2026-01-01T00:00:00.000Z"),
  credentialsUnreadable: false,
  environment: "production",
  expired: false,
  expiresAt: new Date("2026-01-01T12:00:00.000Z"),
  priceSyncDisabled: false,
  refreshTokenMissing: false,
  scope: "allegro:api:sale:offers:read",
  scopesRequested: "allegro:api:sale:offers:read",
};

const syncStateRow = {
  cursor: null,
  id: "algsync_1",
  last_error: null,
  last_synced_at: null,
  provider: "offers",
  status: "idle",
};

/**
 * The narrowed option shape, as `getPublicOptions` returns it.
 *
 * In the response on purpose: the settings page has to be able to say which two rule
 * names the account must carry, where the SRP comes from, and which sales channel
 * scopes the sync - configuration an operator cannot read from anywhere else. None of
 * it is secret material, which the negative assertions below keep true.
 */
const publicOptions = {
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  automationRules: { promoted: "Store Sale", standard: "Store" },
  changeCap: 100,
  environment: "production",
  marketplaceId: "allegro-pl",
  ordersSyncDisabled: false,
  priceSyncDisabled: false,
  redirectPath: "/admin/allegro/oauth/callback",
  scopes: "allegro:api:sale:offers:read",
  stockLocationIds: [],
  stockSyncDisabled: false,
};

const killSwitches = {
  ordersSyncDisabled: false,
  priceSyncDisabled: false,
  stockSyncDisabled: false,
};

const harness = () => {
  const listArgs: unknown[][] = [];
  const service = {
    getConnectionStatus: jest.fn(() => Promise.resolve(connectionStatus)),
    getKillSwitches: jest.fn(() => Promise.resolve(killSwitches)),
    getPublicOptions: jest.fn(() => Promise.resolve(publicOptions)),
    listAllegroSyncStates: jest.fn((...args: unknown[]) => {
      listArgs.push(args);
      return Promise.resolve([syncStateRow]);
    }),
  };

  const req = {
    scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : undefined) },
  } as unknown as MedusaRequest;

  const bodies: unknown[] = [];
  const res = { json: (body: unknown) => bodies.push(body) } as unknown as MedusaResponse;

  return { bodies, listArgs, req, res, service };
};

describe("GET /admin/allegro", () => {
  it("returns the connection status and the sync rows in one round trip", async () => {
    const h = harness();

    await GET(h.req, h.res);

    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]).toEqual({
      connection: connectionStatus,
      // Three switches, not one: "price sync is off" reads as "nothing is written",
      // which is wrong while stock sync is on.
      kill_switches: killSwitches,
      options: publicOptions,
      sync_state: [syncStateRow],
    });
  });

  it("returns no key ending in _encrypted, at any depth", async () => {
    const h = harness();

    await GET(h.req, h.res);

    const encryptedKeys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
        return;
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        for (const [name, nested] of Object.entries(value)) {
          if (name.endsWith("_encrypted")) {
            encryptedKeys.push(name);
          }
          walk(nested);
        }
      }
    };
    walk(h.bodies[0]);

    expect(encryptedKeys).toEqual([]);
  });

  it("orders the sync rows by provider, so the table is stable between loads", async () => {
    const h = harness();

    await GET(h.req, h.res);

    expect(h.listArgs[0]?.[1]).toEqual({ order: { provider: "ASC" } });
  });
});
