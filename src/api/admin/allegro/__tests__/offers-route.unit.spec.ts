import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { GET as GET_LIST } from "../offers/route";
import { GET as GET_ONE, POST as POST_ONE } from "../offers/[sku]/route";
import { POST as POST_RATES } from "../category-rates/route";

/**
 * The read and edit routes behind the Allegro admin pages.
 *
 * What is worth asserting here is the filter translation and the validation, because
 * both encode a decision: `conflict=1` must match ANY conflict code (including one
 * added later), and a category rate must stay clearable to null - an unset rate is what
 * makes price sync skip a category rather than floor it at cost.
 */

const offerRow = { conflict: null, id: "algoffer_1", sku: "SKU-1" };

const harness = (over: { offers?: unknown[]; rates?: unknown[]; count?: number } = {}) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ args, method });
      return Promise.resolve(result);
    };

  const offers = over.offers ?? [offerRow];
  const rates = over.rates ?? [];

  const service = {
    createAllegroCategoryRates: record("createAllegroCategoryRates", []),
    listAllegroCategoryRates: record("listAllegroCategoryRates", rates),
    listAllegroOffers: record("listAllegroOffers", offers),
    listAllegroPricePushes: record("listAllegroPricePushes", []),
    listAndCountAllegroOffers: record("listAndCountAllegroOffers", [
      offers,
      over.count ?? offers.length,
    ]),
    updateAllegroCategoryRates: record("updateAllegroCategoryRates", []),
    updateAllegroOffers: record("updateAllegroOffers", []),
  };

  const bodies: unknown[] = [];
  const res = { json: (body: unknown) => bodies.push(body) } as unknown as MedusaResponse;

  const request = (init: { query?: unknown; params?: unknown; body?: unknown } = {}) =>
    ({
      body: init.body,
      params: init.params ?? {},
      query: init.query ?? {},
      scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : undefined) },
    }) as unknown as MedusaRequest;

  const filtersFor = (method: string): Record<string, unknown> =>
    (calls.find((call) => call.method === method)?.args[0] ?? {}) as Record<string, unknown>;

  return { bodies, calls, filtersFor, request, res, service };
};

describe("GET /admin/allegro/offers", () => {
  it("returns the page plus the total, so the UI can paginate", async () => {
    const h = harness({ count: 120 });

    await GET_LIST(h.request(), h.res);

    expect(h.bodies[0]).toEqual({ count: 120, limit: 50, offers: [offerRow], offset: 0 });
  });

  it("matches any conflict code rather than an enumerated list", async () => {
    // `$ne: null` so a code added to the model later shows up in this filter without
    // anyone remembering to update the route.
    const h = harness();

    await GET_LIST(h.request({ query: { conflict: "1" } }), h.res);

    expect(h.filtersFor("listAndCountAllegroOffers").conflict).toEqual({ $ne: null });
  });

  it("filters on drift", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { drift: "true" } }), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers").price_automation_drift).toBe(true);
  });

  it("searches SKUs case-insensitively", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { q: " sku-1 " } }), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers").sku).toEqual({ $ilike: "%sku-1%" });
  });

  it("filters on an exact SKU set for the product-detail widget", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { skus: ["SKU-1", "SKU-2"] } }), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers").sku).toEqual(["SKU-1", "SKU-2"]);
  });

  it("accepts a single SKU passed as a scalar", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { skus: "SKU-1" } }), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers").sku).toEqual(["SKU-1"]);
  });

  it("prefers an exact SKU set over a substring q", async () => {
    // The widget never sends both, but if it did, the exact set is the safer
    // reading: a substring match would widen the result past the product.
    const h = harness();
    await GET_LIST(h.request({ query: { q: "SKU", skus: ["SKU-1"] } }), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers").sku).toEqual(["SKU-1"]);
  });

  it("caps the page size so a catalogue-sized response cannot be requested", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { limit: "100000" } }), h.res);
    expect((h.bodies[0] as { limit: number }).limit).toBe(200);
  });

  it("falls back to the default page size for a nonsense limit", async () => {
    const h = harness();
    await GET_LIST(h.request({ query: { limit: "banana" } }), h.res);
    expect((h.bodies[0] as { limit: number }).limit).toBe(50);
  });

  it("applies no filters by default", async () => {
    const h = harness();
    await GET_LIST(h.request(), h.res);
    expect(h.filtersFor("listAndCountAllegroOffers")).toEqual({});
  });
});

describe("GET /admin/allegro/offers/:sku", () => {
  it("returns the mapping row with its push history", async () => {
    const h = harness();

    await GET_ONE(h.request({ params: { sku: "SKU-1" } }), h.res);

    expect(h.bodies[0]).toEqual({ offer: offerRow, pushes: [] });
  });

  it("404s for a SKU with no mapping", async () => {
    const h = harness({ offers: [] });
    await expect(GET_ONE(h.request({ params: { sku: "SKU-NOPE" } }), h.res)).rejects.toThrow(
      /No Allegro mapping/,
    );
  });

  it("decodes an encoded SKU", async () => {
    // A SKU can legitimately contain a slash, which the route receives encoded.
    const h = harness();
    await GET_ONE(h.request({ params: { sku: "SKU%2FA" } }), h.res);
    expect(h.filtersFor("listAllegroOffers")).toEqual({ sku: "SKU/A" });
  });
});

describe("POST /admin/allegro/offers/:sku", () => {
  it("writes the per-offer opt-out", async () => {
    const h = harness();

    await POST_ONE(
      h.request({ body: { price_sync_enabled: false }, params: { sku: "SKU-1" } }),
      h.res,
    );

    const update = h.calls.find((call) => call.method === "updateAllegroOffers");
    expect(update?.args[0]).toEqual([{ id: "algoffer_1", price_sync_enabled: false }]);
  });

  it("rejects a non-boolean", async () => {
    const h = harness();
    await expect(
      POST_ONE(
        h.request({ body: { price_sync_enabled: "false" }, params: { sku: "SKU-1" } }),
        h.res,
      ),
    ).rejects.toThrow(/must be a boolean/);
  });

  it("writes nothing else on the row", async () => {
    // Every other column is observed from Allegro or derived. Hand-editing an
    // observation would make the next sweep silently disagree with it.
    const h = harness();

    await POST_ONE(
      h.request({
        body: { conflict: null, price_sync_enabled: true, promoted: true },
        params: { sku: "SKU-1" },
      }),
      h.res,
    );

    const update = h.calls.find((call) => call.method === "updateAllegroOffers");
    expect(update?.args[0]).toEqual([{ id: "algoffer_1", price_sync_enabled: true }]);
  });
});

describe("POST /admin/allegro/category-rates", () => {
  it("creates a row for a category discovery has not seen yet", async () => {
    // An operator preparing rates ahead of a listing needs somewhere to put them.
    const h = harness({ rates: [] });

    await POST_RATES(h.request({ body: { category_id: "cat-9", commission_rate: 9.5 } }), h.res);

    const create = h.calls.find((call) => call.method === "createAllegroCategoryRates");
    expect(create?.args[0]).toEqual([{ category_id: "cat-9", commission_rate: 9.5 }]);
  });

  it("updates an existing row", async () => {
    const h = harness({ rates: [{ category_id: "cat-1", id: "algcatrate_1" }] });

    await POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: "12" } }), h.res);

    const update = h.calls.find((call) => call.method === "updateAllegroCategoryRates");
    expect(update?.args[0]).toEqual([{ commission_rate: 12, id: "algcatrate_1" }]);
  });

  it("clears a rate to null when the field is emptied", async () => {
    // A real, intended action: it makes price sync skip the category again rather than
    // flooring it on a rate the operator no longer trusts.
    const h = harness({ rates: [{ category_id: "cat-1", id: "algcatrate_1" }] });

    await POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: "" } }), h.res);

    const update = h.calls.find((call) => call.method === "updateAllegroCategoryRates");
    expect(update?.args[0]).toEqual([{ commission_rate: null, id: "algcatrate_1" }]);
  });

  it("leaves the other rate untouched when only one is sent", async () => {
    // A category commonly has its standard rate filled in long before its promoted one.
    const h = harness({ rates: [{ category_id: "cat-1", id: "algcatrate_1" }] });

    await POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: 9 } }), h.res);

    const update = h.calls.find((call) => call.method === "updateAllegroCategoryRates");
    expect(update?.args[0]).toEqual([{ commission_rate: 9, id: "algcatrate_1" }]);
  });

  it("rejects a rate at or above 100 percent", async () => {
    // No finite break-even exists, so it would silently skip the whole category with a
    // reason pointing at the data rather than at the typo.
    const h = harness();
    await expect(
      POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: 100 } }), h.res),
    ).rejects.toThrow(/percentage between 0 and 100/);
  });

  it("rejects a mistyped rate well outside the range", async () => {
    const h = harness();
    await expect(
      POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: 950 } }), h.res),
    ).rejects.toThrow(/percentage between 0 and 100/);
  });

  it("rejects a negative rate", async () => {
    const h = harness();
    await expect(
      POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: -1 } }), h.res),
    ).rejects.toThrow(/percentage between 0 and 100/);
  });

  it("rejects an unparseable rate", async () => {
    const h = harness();
    await expect(
      POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: "lots" } }), h.res),
    ).rejects.toThrow(/must be a number or null/);
  });

  it("requires a category id", async () => {
    const h = harness();
    await expect(POST_RATES(h.request({ body: { commission_rate: 9 } }), h.res)).rejects.toThrow(
      /`category_id` is required/,
    );
  });

  it("accepts 0 as a real rate", async () => {
    // A genuine zero-commission category is a valid configuration; it is only an
    // UNSET rate that must skip the offer.
    const h = harness({ rates: [{ category_id: "cat-1", id: "algcatrate_1" }] });

    await POST_RATES(h.request({ body: { category_id: "cat-1", commission_rate: 0 } }), h.res);

    const update = h.calls.find((call) => call.method === "updateAllegroCategoryRates");
    expect(update?.args[0]).toEqual([{ commission_rate: 0, id: "algcatrate_1" }]);
  });
});
