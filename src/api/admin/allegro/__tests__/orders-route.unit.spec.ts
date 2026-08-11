import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { GET } from "../orders/route";
import { POST as POST_IMPORT } from "../orders/import/route";
import { POST as POST_SYNC } from "../sync/route";

jest.mock("../../../../workflows/import-allegro-orders-window", () => ({
  importAllegroOrdersWindow: (_scope: unknown, input: unknown) => {
    importCalls.push(input);
    return Promise.resolve({
      created: 0,
      failed: 0,
      failedFormIds: [],
      fetched: 0,
      imported: 0,
      truncated: false,
    });
  },
}));

// eslint-disable-next-line no-var, vars-on-top -- hoisted with the jest.mock factory above
var importCalls: unknown[] = [];

const RECENT = new Date(Date.now() - 60_000).toISOString();

const orderRow = { checkout_form_id: "f1", id: "algorder_1" };

const harness = (state?: Record<string, unknown>) => {
  const listArgs: unknown[][] = [];
  const service = {
    getSyncState: () => Promise.resolve(state),
    listAndCountAllegroOrders: (...args: unknown[]) => {
      listArgs.push(args);
      return Promise.resolve([[orderRow], 1]);
    },
  };
  const bodies: unknown[] = [];
  const res = { json: (body: unknown) => bodies.push(body) } as unknown as MedusaResponse;
  const request = (init: { query?: unknown; body?: unknown } = {}) =>
    ({
      body: init.body,
      query: init.query ?? {},
      scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : undefined) },
    }) as unknown as MedusaRequest;

  return { bodies, listArgs, request, res };
};

describe("GET /admin/allegro/orders", () => {
  it("surfaces the quarantined forms from the state row", async () => {
    // The durable record. A run summary vanishes on the next render, so without this
    // an operator would have to trigger a sync to discover an order had been skipped.
    const h = harness({
      cursor: "e42",
      failures: {
        quarantined: {
          "f-newer": { error: "b", since: RECENT },
          "f-older": { error: "a", since: new Date(Date.now() - 600_000).toISOString() },
        },
        streaks: { ignored: { count: 1, error: "c", since: RECENT } },
      },
      last_error: "1 order(s) quarantined",
      status: "error",
    });

    await GET(h.request(), h.res);

    const body = h.bodies[0] as { quarantined: { key: string }[]; cursor: string; status: string };
    // Oldest first: the longest-standing to-do is the one that needs attention.
    expect(body.quarantined.map((entry) => entry.key)).toEqual(["f-older", "f-newer"]);
    expect(body.cursor).toBe("e42");
    expect(body.status).toBe("error");
  });

  it("reports an idle, uncursored state before the first run", async () => {
    const h = harness();

    await GET(h.request(), h.res);

    expect(h.bodies[0]).toMatchObject({ cursor: null, quarantined: [], status: "idle" });
  });

  it("filters on unmapped lines and on errors", async () => {
    const h = harness();

    await GET(h.request({ query: { conflict: "1", error: "1" } }), h.res);

    expect(h.listArgs[0]?.[0]).toEqual({
      last_error: { $ne: null },
      line_conflicts: { $ne: null },
    });
  });

  it("orders by the newest event, which is what somebody is looking for", async () => {
    const h = harness();
    await GET(h.request(), h.res);
    expect(h.listArgs[0]?.[1]).toMatchObject({ order: { last_event_at: "DESC" } });
  });
});

describe("POST /admin/allegro/orders/import", () => {
  beforeEach(() => {
    importCalls.length = 0;
  });

  it("normalises the window to ISO timestamps", async () => {
    const h = harness();

    await POST_IMPORT(h.request({ body: { since: "2026-05-01T00:00:00Z" } }), h.res);

    expect(importCalls[0]).toMatchObject({ since: "2026-05-01T00:00:00.000Z" });
  });

  it("requires a since", async () => {
    const h = harness();
    await expect(POST_IMPORT(h.request({ body: {} }), h.res)).rejects.toThrow(
      /`since` is required/,
    );
  });

  it("rejects an unparseable timestamp", async () => {
    const h = harness();
    await expect(
      POST_IMPORT(h.request({ body: { since: "last tuesday" } }), h.res),
    ).rejects.toThrow(/must be an ISO timestamp/);
  });

  it("rejects an inverted window rather than silently importing nothing", async () => {
    const h = harness();
    await expect(
      POST_IMPORT(
        h.request({ body: { since: "2026-05-02T00:00:00Z", until: "2026-05-01T00:00:00Z" } }),
        h.res,
      ),
    ).rejects.toThrow(/must be later than `since`/);
  });

  it("caps the page budget, because one run holds the orders claim throughout", async () => {
    const h = harness();
    await expect(
      POST_IMPORT(h.request({ body: { max_pages: 5000, since: "2026-05-01T00:00:00Z" } }), h.res),
    ).rejects.toThrow(/between 1 and 100/);
  });
});

describe("POST /admin/allegro/sync", () => {
  it("rejects an unknown provider and names all five valid ones", async () => {
    // Asserted per name rather than as one string, so the message stays useful however
    // the constant object happens to be ordered.
    const h = harness();
    const attempt = POST_SYNC(h.request({ body: { provider: "everything" } }), h.res);
    for (const provider of ["offers", "orders", "price-automation", "prices", "stock"]) {
      await expect(attempt).rejects.toThrow(new RegExp(provider));
    }
  });

  it("rejects a missing provider", async () => {
    const h = harness();
    await expect(POST_SYNC(h.request({ body: {} }), h.res)).rejects.toThrow(/`provider` must be/);
  });
});
