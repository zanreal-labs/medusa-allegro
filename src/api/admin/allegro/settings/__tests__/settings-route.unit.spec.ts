import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../../modules/allegro";
import { GET, POST } from "../route";

/**
 * The settings CRUD, over a fake service that only records the write.
 *
 * What matters here is the route's contract: it writes only the keys present, rejects
 * anything that is not a known toggle or configuration field, validates a
 * configuration value against its column's kind, and answers with the resolved state
 * so the admin can render the effect - including a writer the environment forces off,
 * or a configuration field the environment locks, neither of which a write can clear.
 */

const toggleStates = [
  {
    column: "price_sync_enabled",
    description: "prices",
    effectiveEnabled: false,
    envVar: "ALLEGRO_PRICE_SYNC_DISABLED",
    forceDisabled: false,
    key: "priceSync",
    label: "Price writes",
    persistedEnabled: false,
  },
];

const configFieldStates = [
  {
    column: "marketplace_id",
    configDefault: "allegro-pl",
    description: "Marketplace the price-automation rule assignment targets.",
    effectiveValue: "allegro-pl",
    envOverride: null,
    envVar: "ALLEGRO_MARKETPLACE_ID",
    key: "marketplaceId",
    kind: "text",
    label: "Marketplace id",
    locked: false,
    persistedValue: null,
    wiringCritical: true,
  },
];

const harness = () => {
  const updates: unknown[] = [];
  const service = {
    getConfigFieldStates: jest.fn(() => Promise.resolve(configFieldStates)),
    getRuntimeToggleStates: jest.fn(() => Promise.resolve(toggleStates)),
    updateSettings: jest.fn((patch: unknown) => {
      updates.push(patch);
      return Promise.resolve({ id: "algset_singleton" });
    }),
  };

  const makeReq = (body?: unknown) =>
    ({
      body,
      scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : undefined) },
    }) as unknown as MedusaRequest;

  const bodies: unknown[] = [];
  const res = { json: (value: unknown) => bodies.push(value) } as unknown as MedusaResponse;

  return { bodies, makeReq, res, service, updates };
};

describe("GET /admin/allegro/settings", () => {
  it("returns the resolved toggle and configuration field states", async () => {
    const h = harness();
    await GET(h.makeReq(), h.res);
    expect(h.bodies[0]).toEqual({ configFields: configFieldStates, toggles: toggleStates });
  });
});

describe("POST /admin/allegro/settings", () => {
  it("writes only the keys present, so arming one writer never disturbs another", async () => {
    const h = harness();

    await POST(h.makeReq({ price_sync_enabled: true }), h.res);

    expect(h.updates).toEqual([{ price_sync_enabled: true }]);
    // Answers with the freshly resolved state so the UI reflects the write.
    expect(h.bodies[0]).toEqual({ configFields: configFieldStates, toggles: toggleStates });
  });

  it("accepts several toggles at once", async () => {
    const h = harness();

    await POST(h.makeReq({ invoice_attach_enabled: false, orders_sync_enabled: true }), h.res);

    expect(h.updates).toEqual([{ invoice_attach_enabled: false, orders_sync_enabled: true }]);
  });

  it("rejects an unknown toggle rather than silently ignoring a typo", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ price_sync: true }), h.res)).rejects.toBeInstanceOf(MedusaError);
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean value", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ price_sync_enabled: "yes" }), h.res)).rejects.toBeInstanceOf(
      MedusaError,
    );
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty write, which would otherwise report success for nothing", async () => {
    const h = harness();

    await expect(POST(h.makeReq({}), h.res)).rejects.toBeInstanceOf(MedusaError);
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("writes a text configuration field, trimmed", async () => {
    const h = harness();

    await POST(h.makeReq({ marketplace_id: "  allegro-pl  " }), h.res);

    expect(h.updates).toEqual([{ marketplace_id: "allegro-pl" }]);
  });

  it("clears a text configuration field with null, falling back to the medusa-config default", async () => {
    const h = harness();

    await POST(h.makeReq({ srp_metadata_key: null }), h.res);

    expect(h.updates).toEqual([{ srp_metadata_key: null }]);
  });

  it("treats a blank string the same as null - a cleared field, not an error", async () => {
    const h = harness();

    await POST(h.makeReq({ srp_metadata_key: "   " }), h.res);

    expect(h.updates).toEqual([{ srp_metadata_key: null }]);
  });

  it("writes change_cap as a positive integer", async () => {
    const h = harness();

    await POST(h.makeReq({ change_cap: 50 }), h.res);

    expect(h.updates).toEqual([{ change_cap: 50 }]);
  });

  it("rejects change_cap that is zero or negative", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ change_cap: 0 }), h.res)).rejects.toBeInstanceOf(MedusaError);
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects change_cap that is not an integer", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ change_cap: 1.5 }), h.res)).rejects.toBeInstanceOf(MedusaError);
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects change_cap sent as a string rather than coercing it", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ change_cap: "50" }), h.res)).rejects.toBeInstanceOf(MedusaError);
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an unknown configuration field rather than silently ignoring a typo", async () => {
    const h = harness();

    await expect(POST(h.makeReq({ marketplace_di: "allegro-pl" }), h.res)).rejects.toBeInstanceOf(
      MedusaError,
    );
    expect(h.service.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts a mix of a toggle and a configuration field in one write", async () => {
    const h = harness();

    await POST(h.makeReq({ marketplace_id: "allegro-pl", price_sync_enabled: true }), h.res);

    expect(h.updates).toEqual([{ marketplace_id: "allegro-pl", price_sync_enabled: true }]);
  });
});
