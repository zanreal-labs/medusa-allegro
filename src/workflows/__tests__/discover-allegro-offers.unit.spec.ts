import { AllegroApiError } from "../../lib/allegro/errors";
import type { AllegroOffer, OfferPromoOptions } from "../../lib/allegro/types";
import { runOfferDiscovery } from "../discover-allegro-offers";

/**
 * Engine-level tests for offer discovery.
 *
 * The planner is tested exhaustively on its own (`lib/sync/offer-discovery`); what
 * is left here is the wiring the planner cannot see: which rows actually get
 * written, that a conflicted mapping loses its `offer_id`, that an unresolved promo
 * sweep does not clear a stored flag, and that a category row is created with NULL
 * rates even when its name could not be fetched.
 *
 * The module service and the Allegro client are both faked. That is the established
 * pattern in this repo (see `src/modules/allegro/__tests__/service.unit.spec.ts`):
 * a live Postgres proves nothing these assertions do not, and the behaviour under
 * test is entirely in the engine.
 */

const offer = (over: Partial<AllegroOffer> & { id: string }): AllegroOffer => ({
  category: { id: "cat-1" },
  name: "An offer",
  publication: { status: "ACTIVE" },
  sellingMode: { price: { amount: "199.99", currency: "PLN" } },
  stock: { available: 4 },
  ...over,
});

interface OfferRow {
  id: string;
  sku: string;
  offer_id?: string | null;
  promoted?: boolean;
  conflict?: string | null;
  conflict_detail?: string | null;
  last_error?: string | null;
  variant_id?: string | null;
  [key: string]: unknown;
}

interface CategoryRow {
  id: string;
  category_id: string;
  name: string;
  commission_rate?: number | null;
  promoted_commission_rate?: number | null;
}

/** The pieces of the module service the engine touches. */
const fakeAllegro = (
  offers: OfferRow[] = [],
  categories: CategoryRow[] = [],
  options: Record<string, unknown> = {},
) => {
  const state = new Map<string, Record<string, unknown>>();
  let sequence = offers.length;
  let categorySequence = categories.length;
  const claims: string[] = [];

  return {
    categories,
    claimSyncRun: (provider: string) => {
      claims.push(provider);
      const row = state.get(provider) ?? { provider, status: "idle", updated_at: new Date() };
      state.set(provider, row);
      return Promise.resolve({ acquired: true, state: row });
    },
    claims,
    createAllegroCategoryRates: (rows: Omit<CategoryRow, "id">[]) => {
      for (const row of rows) {
        categorySequence += 1;
        categories.push({ ...row, id: `algcatrate_${categorySequence}` });
      }
      return Promise.resolve(rows);
    },
    createAllegroOffers: (rows: Partial<OfferRow>[]) => {
      for (const row of rows) {
        sequence += 1;
        offers.push({ id: `algoffer_${sequence}`, sku: "", ...row } as OfferRow);
      }
      return Promise.resolve(rows);
    },
    getClient: () => Promise.resolve(client),
    getSyncOptions: () => Promise.resolve({ changeCap: 100, stockLocationIds: [], ...options }),
    listAllegroCategoryRates: (filters: { category_id?: string[] }) =>
      Promise.resolve(
        filters.category_id
          ? categories.filter((row) => filters.category_id?.includes(row.category_id))
          : categories,
      ),
    listAllegroOffers: () => Promise.resolve(offers.map((row) => ({ ...row }))),
    offers,
    state,
    updateAllegroOffers: (rows: (Partial<OfferRow> & { id: string })[]) => {
      for (const row of rows) {
        const index = offers.findIndex((existing) => existing.id === row.id);
        if (index !== -1) {
          offers[index] = { ...offers[index], ...row } as OfferRow;
        }
      }
      return Promise.resolve(rows);
    },
    writeSyncState: (provider: string, patch: Record<string, unknown>) => {
      state.set(provider, { ...(state.get(provider) ?? { provider }), ...patch });
      return Promise.resolve();
    },
  };
};

let client: Record<string, unknown>;

const fakeClient = (options: {
  offers?: AllegroOffer[];
  promo?: OfferPromoOptions[];
  promoError?: Error;
  categoryError?: Error;
}) => ({
  getCategory: (id: string) => {
    if (options.categoryError) {
      return Promise.reject(options.categoryError);
    }
    return Promise.resolve({ name: `Category ${id}` });
  },
  listOffers: () =>
    Promise.resolve({
      count: (options.offers ?? []).length,
      offers: options.offers ?? [],
      totalCount: (options.offers ?? []).length,
    }),
  listSellerPromoOptions: () => {
    if (options.promoError) {
      return Promise.reject(options.promoError);
    }
    const promoOptions = options.promo ?? [];
    return Promise.resolve({
      count: promoOptions.length,
      promoOptions,
      totalCount: promoOptions.length,
    });
  },
});

/** A container that resolves the fakes, plus a query graph over given variants. */
const fakeContainer = (
  allegro: ReturnType<typeof fakeAllegro>,
  variants: { id: string; sku: string; barcode?: string }[],
) => ({
  resolve: (key: string) => {
    if (key === "allegro") {
      return allegro;
    }
    if (key === "logger") {
      return { error: () => {}, info: () => {}, warn: () => {} };
    }
    if (key === "query") {
      return {
        graph: ({ entity, pagination }: { entity: string; pagination?: { skip: number } }) => {
          if (entity === "product_variant" && (pagination?.skip ?? 0) === 0) {
            return Promise.resolve({
              data: variants.map((variant) => ({
                barcode: variant.barcode ?? null,
                ean: null,
                id: variant.id,
                inventory_items: [],
                manage_inventory: true,
                metadata: null,
                product: null,
                product_id: `prod_${variant.id}`,
                sku: variant.sku,
              })),
            });
          }
          return Promise.resolve({ data: [] });
        },
      };
    }
    throw new Error(`unexpected container key ${key}`);
  },
});

const run = async (input: {
  offers?: AllegroOffer[];
  promo?: OfferPromoOptions[];
  promoError?: Error;
  categoryError?: Error;
  stored?: OfferRow[];
  categories?: CategoryRow[];
  variants?: { id: string; sku: string; barcode?: string }[];
}) => {
  const allegro = fakeAllegro(input.stored ?? [], input.categories ?? []);
  client = fakeClient(input);
  const container = fakeContainer(allegro, input.variants ?? []);
  const output = await runOfferDiscovery(container as never);
  return { allegro, output };
};

describe("runOfferDiscovery", () => {
  it("writes a mapping row for a matched offer", async () => {
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    expect(output.result).toMatchObject({ created: 1, matched: 1, offersListed: 1, updated: 0 });
    expect(allegro.offers[0]).toMatchObject({
      conflict: null,
      last_error: null,
      offer_id: "o1",
      sku: "SKU-1",
      variant_id: "v1",
    });
  });

  it("updates the existing row rather than creating a second one", async () => {
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      stored: [{ id: "row-1", offer_id: null, sku: "SKU-1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    expect(output.result).toMatchObject({ created: 0, updated: 1 });
    expect(allegro.offers).toHaveLength(1);
    expect(allegro.offers[0]).toMatchObject({ id: "row-1", offer_id: "o1" });
  });

  it("writes the promoted flag from the sweep", async () => {
    const { allegro } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      promo: [{ basePackage: { id: "emphasized10d" }, offerId: "o1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.offers[0]?.promoted).toBe(true);
  });

  it("clears a stale promoted flag when the sweep is complete but the offer is absent from it", async () => {
    // A complete map doubles as the "not promoted" signal: an offer absent from it
    // carries no packages.
    const { allegro } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      promo: [{ basePackage: { id: "emphasized10d" }, offerId: "other" }],
      stored: [{ id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.offers[0]?.promoted).toBe(false);
  });

  it("leaves a stored promoted flag alone when the sweep could not be resolved", async () => {
    // An unresolved read must never be able to clear state. The promoted flag
    // selects the commission rate, which sets the price floor.
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      promoError: new AllegroApiError({ httpStatus: 400, message: "Feature unavailable" }),
      stored: [{ id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.offers[0]?.promoted).toBe(true);
    expect(output.result.promoFeatureUnavailable).toBe(true);
  });

  it("counts an unresolved promotion state that is not a feature gap", async () => {
    const { output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      promoError: new AllegroApiError({ httpStatus: 400, message: "Bad request" }),
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.result.promoUnresolved).toBe(1);
    expect(output.result.promoFeatureUnavailable).toBe(false);
    expect(output.result.error).toContain("promo-options");
  });

  it("strips the offer id from a conflicted mapping", async () => {
    // `offer_id` is what the write paths build commands from. Leaving it set is how
    // a contested SKU still gets a price pushed to one of the two candidates.
    const { allegro, output } = await run({
      offers: [
        offer({ external: { id: "SKU-1" }, id: "o1" }),
        offer({ external: { id: "SKU-1" }, id: "o2" }),
      ],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    expect(allegro.offers[0]).toMatchObject({ conflict: "duplicate-sku", offer_id: null });
    expect(output.result.conflicts["duplicate-sku"]).toBe(1);
    expect(output.result.error).toContain("mapping conflict(s)");
  });

  it("records a conflict for a sygnatura matching no eligible variant", async () => {
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-GHOST" }, id: "o1" })],
      variants: [],
    });
    expect(output.result.conflicts["no-variant"]).toBe(1);
    expect(allegro.offers[0]).toMatchObject({ conflict: "no-variant", sku: "SKU-GHOST" });
  });

  it("clears a stale link and its promoted flag together", async () => {
    // A promoted flag left on an unlinked row would select the promoted commission
    // rate the moment the SKU is re-linked to a plain offer.
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      stored: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o-gone", promoted: true, sku: "SKU-2" },
      ],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    expect(output.result.unlinked).toBe(1);
    const stale = allegro.offers.find((row) => row.sku === "SKU-2");
    // The conflict pass owns this row (it records `no-offer`), so the unlink pass
    // skips it - and the conflict row already clears `offer_id`.
    expect(stale).toMatchObject({ conflict: "no-offer", offer_id: null });
  });

  it("never unlinks when the listing came back empty", async () => {
    const { allegro, output } = await run({
      offers: [],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.result.unlinked).toBe(0);
    expect(allegro.offers[0]?.offer_id).toBe("o1");
  });

  it("creates a category rate row with null rates", async () => {
    // NULL, not zero: a break-even that reads an unknown rate as 0% turns a
    // loss-making price into an acceptable floor.
    const { allegro, output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.result).toMatchObject({ categoriesCreated: 1, categoriesSeen: 1 });
    expect(allegro.categories[0]).toMatchObject({ category_id: "cat-1", name: "Category cat-1" });
    expect(allegro.categories[0]?.commission_rate).toBeUndefined();
  });

  it("does not recreate a category that already has a rate row", async () => {
    const { output } = await run({
      categories: [{ category_id: "cat-1", commission_rate: 9.5, id: "r1", name: "Existing" }],
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.result.categoriesCreated).toBe(0);
  });

  it("still creates the category row when its name could not be fetched", async () => {
    // The operator needs the row far more than the pretty name; without it, price
    // sync skips every offer in the category with no visible reason.
    const { allegro, output } = await run({
      categoryError: new AllegroApiError({ httpStatus: 404, message: "Not found" }),
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.categories[0]).toMatchObject({ category_id: "cat-1", name: "cat-1" });
    expect(output.result.error).toContain("/sale/categories/cat-1");
  });

  it("records the run's counters and health on the state row", async () => {
    const { allegro } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    const state = allegro.state.get("offers");
    expect(state).toMatchObject({ last_error: null, status: "ok" });
    expect(state?.counts).toMatchObject({ matched: 1, offersListed: 1 });
    expect(state?.last_synced_at).toBeInstanceOf(Date);
  });

  it("records an error status when the run had findings", async () => {
    const { allegro } = await run({
      offers: [offer({ external: { id: "SKU-GHOST" }, id: "o1" })],
      variants: [],
    });
    expect(allegro.state.get("offers")).toMatchObject({ status: "error" });
  });

  it("takes the claim for the offers provider only", async () => {
    const { allegro } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.claims).toEqual(["offers"]);
  });

  it("reports the listing back so a chained loop can reuse it", async () => {
    const { output } = await run({
      offers: [offer({ external: { id: "SKU-1" }, id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.listing?.complete).toBe(true);
    expect(output.listing?.offers).toHaveLength(1);
    expect(output.promo?.promotedByOffer).toBeInstanceOf(Map);
  });

  it("counts an offer with no sygnatura and no EAN", async () => {
    const { output } = await run({
      offers: [offer({ id: "o1" })],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });
    expect(output.result.skippedNoSku).toBe(1);
    expect(output.result.error).toContain("no sygnatura and no EAN");
  });

  it("matches on the variant barcode when the offer carries no sygnatura", async () => {
    const { allegro } = await run({
      offers: [offer({ ean: "5901234123457", id: "o1" })],
      variants: [{ barcode: "5901234123457", id: "v1", sku: "SKU-1" }],
    });
    expect(allegro.offers[0]).toMatchObject({ offer_id: "o1", sku: "SKU-1" });
  });
});

describe("runOfferDiscovery when Allegro is not connected", () => {
  it("records the reason instead of reporting a healthy run", async () => {
    // A state row reading "ok" with no error while the sync has quietly stopped is
    // the failure mode this guard exists for.
    const allegro = fakeAllegro();
    allegro.getClient = () => Promise.resolve(null as never);
    const container = fakeContainer(allegro, []);

    const output = await runOfferDiscovery(container as never);

    expect(output.result.skipped).toContain("not connected");
    expect(allegro.state.get("offers")).toMatchObject({ status: "error" });
    expect(allegro.claims).toEqual([]);
  });
});

describe("runOfferDiscovery when the claim is held", () => {
  it("reports the collision as retryable and writes nothing", async () => {
    const allegro = fakeAllegro();
    allegro.claimSyncRun = () =>
      Promise.resolve({ acquired: false, reason: "a sync run is already in progress" } as never);
    client = fakeClient({});
    const container = fakeContainer(allegro, []);

    const output = await runOfferDiscovery(container as never);

    expect(output.result.skipped).toContain("already in progress");
    expect(allegro.offers).toEqual([]);
  });
});
