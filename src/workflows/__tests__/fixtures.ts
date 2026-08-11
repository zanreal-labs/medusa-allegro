import type { AllegroOffer, PriceAutomationRule } from "../../lib/allegro/types";

/**
 * Shared fakes for the engine specs.
 *
 * The module service and the Allegro client are both faked, which is the pattern
 * this repo already uses for the service (`src/modules/allegro/__tests__`). A live
 * Postgres would prove nothing these assertions do not: what is under test is the
 * engines' decisions and the rows they write, and both are observable against an
 * in-memory table.
 */

export const RULES = { promoted: "Store Sale", standard: "Store" } as const;

export const ACCOUNT_RULES: PriceAutomationRule[] = [
  { id: "rule-standard", name: RULES.standard },
  { id: "rule-promoted", name: RULES.promoted },
];

export const offerFixture = (over: Partial<AllegroOffer> & { id: string }): AllegroOffer => ({
  category: { id: "cat-1" },
  name: "An offer",
  publication: { status: "ACTIVE" },
  sellingMode: { price: { amount: "199.99", currency: "PLN" } },
  stock: { available: 4 },
  ...over,
});

export interface OfferRowFixture {
  id: string;
  sku: string;
  offer_id?: string | null;
  category_id?: string | null;
  /**
   * Three-state, matching the column: true / false / NULL meaning "not resolved".
   *
   * Prefer stating it explicitly in a fixture. Omitting the key yields `undefined`, which
   * the loops treat like NULL - but the column was once `NOT NULL default false`, so an
   * omitted key described a state the database could never produce, and tests written
   * that way asserted unreachable behaviour.
   */
  promoted?: boolean | null;
  price_sync_enabled?: boolean;
  price_currency?: string | null;
  conflict?: string | null;
  price_mode?: string | null;
  automation_rule?: string | null;
  automation_rule_id?: string | null;
  automation_synced_at?: Date | null;
  price_automation_drift?: boolean | null;
  price_synced_at?: Date | null;
  last_error?: string | null;
  [key: string]: unknown;
}

export interface PushRowFixture {
  id: string;
  sku: string;
  offer_id?: string | null;
  pushed_by?: string;
  result: string;
  bound_floor?: string | null;
  bound_ceiling?: string | null;
  pushed_at?: Date;
  [key: string]: unknown;
}

export interface CategoryRateFixture {
  id: string;
  category_id: string;
  name?: string;
  commission_rate?: number | string | null;
  promoted_commission_rate?: number | string | null;
}

export interface StateRowFixture {
  provider: string;
  status: string;
  cursor?: string | null;
  counts?: unknown;
  failures?: unknown;
  last_error?: string | null;
  last_synced_at?: Date | null;
  write_scope_missing?: boolean;
  updated_at?: Date;
  [key: string]: unknown;
}

/** The pieces of the module service the engines touch, over in-memory arrays. */
export const fakeAllegroService = (seed: {
  offers?: OfferRowFixture[];
  pushes?: PushRowFixture[];
  categories?: CategoryRateFixture[];
  states?: StateRowFixture[];
  syncOptions?: Record<string, unknown>;
  priceSyncDisabled?: boolean;
  stockSyncDisabled?: boolean;
  ordersSyncDisabled?: boolean;
  client?: unknown;
  claimHeld?: boolean;
  /** Simulates the claim being taken over mid-run: every heartbeat reports it lost. */
  claimLost?: boolean;
}) => {
  const offers = seed.offers ?? [];
  const pushes = seed.pushes ?? [];
  const categories = seed.categories ?? [];
  const states = new Map<string, StateRowFixture>(
    (seed.states ?? []).map((row) => [row.provider, { ...row }]),
  );
  const claims: string[] = [];
  const heartbeats: { provider: string; token: string }[] = [];
  const preClaimWritesSkipped: string[] = [];
  let claimSequence = 0;
  let offerSequence = offers.length;
  let pushSequence = pushes.length;

  const service = {
    categories,
    claimSyncRun: (provider: string) => {
      claims.push(provider);
      if (seed.claimHeld) {
        return Promise.resolve({
          acquired: false,
          reason: "a sync run is already in progress for this provider",
        });
      }
      const row = states.get(provider) ?? { provider, status: "idle", updated_at: new Date() };
      // A TOKEN, like the real service. Without one the wrapper cannot fence its writes, so
      // a fake that omitted it would make every run report the claim as held.
      claimSequence += 1;
      const token = `token-${claimSequence}`;
      states.set(provider, { ...row, claim_token: token });
      return Promise.resolve({
        acquired: true,
        state: { write_scope_missing: false, ...row },
        token,
      });
    },
    /**
     * The fencing check, honoured rather than stubbed true.
     *
     * `claimLost` simulates the run being taken over: the stored token stops matching, which
     * is exactly what the real conditional update reports by affecting zero rows.
     */
    touchSyncClaim: (provider: string, token: string) => {
      heartbeats.push({ provider, token });
      if (seed.claimLost) {
        return Promise.resolve(false);
      }
      const row = states.get(provider);
      const held = row?.claim_token === token;
      if (held) {
        states.set(provider, { ...row, claim_heartbeat_at: new Date() } as StateRowFixture);
      }
      return Promise.resolve(held);
    },
    heartbeats,
    claims,
    createAllegroCategoryRates: (rows: Omit<CategoryRateFixture, "id">[]) => {
      const created = rows.map((row, index) => ({ ...row, id: `algcatrate_${index + 1}` }));
      categories.push(...created);
      return Promise.resolve(created);
    },
    createAllegroOffers: (rows: Partial<OfferRowFixture>[]) => {
      const created = rows.map((row) => {
        offerSequence += 1;
        return { id: `algoffer_${offerSequence}`, sku: "", ...row } as OfferRowFixture;
      });
      offers.push(...created);
      return Promise.resolve(created);
    },
    createAllegroPricePushes: (rows: Partial<PushRowFixture>[]) => {
      const created = rows.map((row) => {
        pushSequence += 1;
        return {
          id: `algpush_${pushSequence}`,
          result: "failed",
          sku: "",
          ...row,
        } as PushRowFixture;
      });
      pushes.push(...created);
      return Promise.resolve(created);
    },
    getClient: () => Promise.resolve(seed.client ?? null),
    getSyncOptions: () =>
      Promise.resolve({
        changeCap: 100,
        costsModuleKey: "productCosts",
        marketplaceId: "allegro-pl",
        stockLocationIds: [],
        ...seed.syncOptions,
      }),
    isOrdersSyncDisabled: () => Promise.resolve(seed.ordersSyncDisabled ?? false),
    isPriceSyncDisabled: () => Promise.resolve(seed.priceSyncDisabled ?? false),
    isStockSyncDisabled: () => Promise.resolve(seed.stockSyncDisabled ?? false),
    listAllegroCategoryRates: (filters: { category_id?: string[] } = {}) =>
      Promise.resolve(
        filters.category_id
          ? categories.filter((row) => filters.category_id?.includes(row.category_id))
          : categories,
      ),
    listAllegroOffers: (
      filters: { sku?: string | string[]; offer_id?: string[] } = {},
      config: { take?: number } = {},
    ) => {
      let rows = offers.map((row) => ({ ...row }));
      // An ARRAY as well as a scalar, because the generated CRUD surface accepts both
      // (Mikro-ORM turns a list into `$in`) and the stock loop looks conflicted rows up in
      // bulk. A fake that only understood the scalar form silently returned nothing for the
      // bulk read, which would let a missing conflict write pass as green.
      if (filters.sku !== undefined) {
        const wanted = Array.isArray(filters.sku) ? filters.sku : [filters.sku];
        rows = rows.filter((row) => wanted.includes(row.sku));
      }
      // Honoured, not ignored: the stock loop stamps `stock_synced_at` on exactly
      // the offers Allegro confirmed, and a fake that returned everything would let
      // a per-offer stamping bug pass.
      if (filters.offer_id) {
        rows = rows.filter((row) => row.offer_id && filters.offer_id?.includes(row.offer_id));
      }
      return Promise.resolve(config.take === undefined ? rows : rows.slice(0, config.take));
    },
    listAllegroPricePushes: (
      filters: {
        result?: string;
        pushed_at?: { $gte?: Date };
        pushed_by?: { $nin?: string[] };
      } = {},
      config: { skip?: number; take?: number; order?: Record<string, "ASC" | "DESC"> } = {},
    ) => {
      let rows = pushes.filter((row) => (filters.result ? row.result === filters.result : true));
      // The manual-push cap reads this table with a time window and a `$nin` on `pushed_by`.
      // Honoured, not ignored: a fake that dropped these filters would count every audit row
      // ever written and make the cap look far tighter than it is.
      const since = filters.pushed_at?.$gte;
      if (since) {
        rows = rows.filter((row) => (row.pushed_at?.getTime() ?? 0) >= since.getTime());
      }
      const excluded = filters.pushed_by?.$nin;
      if (excluded) {
        rows = rows.filter((row) => !excluded.includes(row.pushed_by as string));
      }
      if (config.order?.pushed_at) {
        const sign = config.order.pushed_at === "DESC" ? -1 : 1;
        rows = rows.toSorted(
          (a, b) => sign * ((a.pushed_at?.getTime() ?? 0) - (b.pushed_at?.getTime() ?? 0)),
        );
      }
      const skip = config.skip ?? 0;
      return Promise.resolve(
        (config.take === undefined ? rows.slice(skip) : rows.slice(skip, skip + config.take)).map(
          (row) => ({ ...row }),
        ),
      );
    },
    offers,
    pushes,
    states,
    updateAllegroOffers: (rows: (Partial<OfferRowFixture> & { id: string })[]) => {
      for (const row of rows) {
        const index = offers.findIndex((existing) => existing.id === row.id);
        if (index !== -1) {
          offers[index] = { ...offers[index], ...row } as OfferRowFixture;
        }
      }
      return Promise.resolve(rows);
    },
    updateAllegroPricePushes: (rows: (Partial<PushRowFixture> & { id: string })[]) => {
      for (const row of rows) {
        const index = pushes.findIndex((existing) => existing.id === row.id);
        if (index !== -1) {
          pushes[index] = { ...pushes[index], ...row } as PushRowFixture;
        }
      }
      return Promise.resolve(rows);
    },
    writeSyncState: (
      provider: string,
      patch: Record<string, unknown>,
      opts: { token?: string } = {},
    ) => {
      const row = states.get(provider);
      // The token guard is honoured, because "a run that lost its claim must not write" is
      // the property under test. A fake that always wrote would make that untestable.
      if (opts.token !== undefined && row?.claim_token !== opts.token) {
        return Promise.resolve(false);
      }
      states.set(provider, {
        ...(row ?? { provider, status: "idle" }),
        ...patch,
      } as StateRowFixture);
      return Promise.resolve(true);
    },
    /** Skips the write while a live claim is held, exactly as the real guard does. */
    writeSyncStateIfUnclaimed: (provider: string, patch: Record<string, unknown>) => {
      const row = states.get(provider);
      if (row?.status === "running") {
        preClaimWritesSkipped.push(provider);
        return Promise.resolve(false);
      }
      states.set(provider, {
        ...(row ?? { provider, status: "idle" }),
        ...patch,
      } as StateRowFixture);
      return Promise.resolve(true);
    },
    preClaimWritesSkipped,
  };
  return service;
};

export type FakeAllegroService = ReturnType<typeof fakeAllegroService>;

/** A variant as the catalogue reader returns it from `query.graph`. */
export interface VariantFixture {
  id: string;
  sku: string;
  barcode?: string;
  metadata?: Record<string, unknown>;
  inventoryItemIds?: string[];
  manageInventory?: boolean;
}

/** A container resolving the fakes, with a query graph over the given variants. */
export const fakeContainer = (input: {
  allegro: FakeAllegroService;
  variants?: VariantFixture[];
  costs?: unknown;
  inventory?: unknown;
  /**
   * Price-list rows. `currency` defaults to PLN, matching the offer fixtures.
   *
   * Stated per row so a multi-currency list can be expressed: the SRP ceiling is
   * currency-specific, and a fixture that could not express two currencies for one SKU
   * could not catch a cross-currency ceiling.
   */
  priceListPrices?: { amount: number; variantId: string; currency?: string }[];
  stockLocationIds?: string[];
  logs?: string[];
}) => {
  const variants = input.variants ?? [];
  const logs = input.logs ?? [];
  const record = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };

  return {
    resolve: (key: string) => {
      if (key === "allegro") {
        return input.allegro;
      }
      if (key === "logger") {
        return { error: record("error"), info: record("info"), warn: record("warn") };
      }
      if (key === "productCosts") {
        if (!input.costs) {
          throw new Error("productCosts is not registered");
        }
        return input.costs;
      }
      if (key === "inventory") {
        if (!input.inventory) {
          throw new Error("inventory is not registered");
        }
        return input.inventory;
      }
      if (key === "query") {
        return {
          graph: ({ entity, pagination }: { entity: string; pagination?: { skip: number } }) => {
            const firstPage = (pagination?.skip ?? 0) === 0;
            if (entity === "product_variant" && firstPage) {
              return Promise.resolve({
                data: variants.map((variant) => ({
                  barcode: variant.barcode ?? null,
                  ean: null,
                  id: variant.id,
                  inventory_items: (variant.inventoryItemIds ?? []).map((id) => ({
                    inventory_item_id: id,
                  })),
                  manage_inventory: variant.manageInventory ?? true,
                  metadata: variant.metadata ?? null,
                  product: null,
                  product_id: `prod_${variant.id}`,
                  sku: variant.sku,
                })),
              });
            }
            if (entity === "stock_location") {
              return Promise.resolve({
                data: (input.stockLocationIds ?? ["sloc_default"]).map((id) => ({ id })),
              });
            }
            if (entity === "price_list") {
              return Promise.resolve({
                data: [
                  {
                    id: "plist_1",
                    prices: (input.priceListPrices ?? []).map((price) => ({
                      amount: price.amount,
                      currency_code: price.currency ?? "pln",
                      price_set: { variant: { id: price.variantId } },
                    })),
                  },
                ],
              });
            }
            return Promise.resolve({ data: [] });
          },
        };
      }
      throw new Error(`unexpected container key ${key}`);
    },
  };
};

/** A costs service stand-in: net costs by SKU, plus the break-even formula. */
export const fakeCostsService = (netCostBySku: Record<string, number>, vatRate = 0.23) => ({
  computeEconomics: ({
    netCost,
    commissionRate,
  }: {
    netCost?: number;
    commissionRate?: number;
  }) => {
    if (netCost === undefined) {
      return Promise.resolve({});
    }
    const commission = commissionRate ?? 0;
    if (commission >= 1) {
      return Promise.resolve({});
    }
    const gross = netCost * (1 + vatRate);
    return Promise.resolve({
      breakEvenPrice: Math.round((gross / (1 - commission) + Number.EPSILON) * 100) / 100,
    });
  },
  getCostsBySkus: (skus: string[]) =>
    Promise.resolve(
      skus
        .filter((sku) => netCostBySku[sku] !== undefined)
        .map((sku) => ({ sku, unit_cost_net: netCostBySku[sku] as number })),
    ),
});
