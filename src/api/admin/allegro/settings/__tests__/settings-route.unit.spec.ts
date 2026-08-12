import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../../modules/allegro";
import { GET, POST } from "../route";

/**
 * The runtime-toggle CRUD, over a fake service that only records the write.
 *
 * What matters here is the route's contract: it writes only the keys present, rejects
 * anything that is not a known boolean toggle, and answers with the resolved toggle
 * state so the admin can render the effect (including a writer the environment forces
 * off, which a write cannot clear).
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

const harness = () => {
  const updates: unknown[] = [];
  const service = {
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
  it("returns the resolved toggle states", async () => {
    const h = harness();
    await GET(h.makeReq(), h.res);
    expect(h.bodies[0]).toEqual({ toggles: toggleStates });
  });
});

describe("POST /admin/allegro/settings", () => {
  it("writes only the keys present, so arming one writer never disturbs another", async () => {
    const h = harness();

    await POST(h.makeReq({ price_sync_enabled: true }), h.res);

    expect(h.updates).toEqual([{ price_sync_enabled: true }]);
    // Answers with the freshly resolved state so the UI reflects the write.
    expect(h.bodies[0]).toEqual({ toggles: toggleStates });
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
});
