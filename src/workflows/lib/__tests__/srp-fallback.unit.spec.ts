import type { MedusaContainer } from "@medusajs/framework/types";
import { buildSrpBySku } from "../pricing";
import type { CatalogVariant } from "../catalog";

/**
 * The SRP ceiling derived from purchase cost.
 *
 * A supplier that publishes no RRP used to take our own offers out of price
 * automation entirely: no ceiling, so `missing-srp`, so no write. These cover the
 * rule that replaces that silence, and the two things it must never do - overwrite
 * a real SRP, or invent a ceiling out of an unresolvable cost.
 */

const VAT = 0.23;

const variant = (
  sku: string,
  metadata?: Record<string, unknown>,
): CatalogVariant =>
  ({
    id: `var_${sku}`,
    metadata,
    productMetadata: undefined,
    sku,
  }) as unknown as CatalogVariant;

const costsService = (
  costs: Record<string, number>,
  options: { vatRate?: number } = {},
) => ({
  computeEconomics: async ({ netCost }: { netCost?: number }) => {
    const vatRate = options.vatRate;
    if (netCost === undefined || vatRate === undefined) {
      // What the real plugin does with no VAT rate configured: no gross cost.
      return {};
    }
    return { grossCost: Math.round(netCost * (1 + vatRate) * 100) / 100 };
  },
  getCostsBySkus: async (skus: string[]) =>
    skus
      .filter((sku) => sku in costs)
      .map((sku) => ({ sku, unit_cost_net: costs[sku] as number })),
});

const containerWith = (service: unknown): MedusaContainer =>
  ({
    resolve: (key: string) => {
      if (key === "product_costs" && service) {
        return service;
      }
      throw new Error(`no such module: ${key}`);
    },
  }) as unknown as MedusaContainer;

const OPTIONS = {
  costsModuleKey: "product_costs",
  srpFallbackMarkupPercent: 60,
  srpMetadataKey: "srp",
};

describe("buildSrpBySku: cost-derived fallback", () => {
  it("derives a ceiling from the gross purchase cost for a variant with no SRP", async () => {
    // 100 net at 23% VAT is 123 gross; 60% on top is 196.80.
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-1": 100 }, { vatRate: VAT })),
      [variant("SKU-1")],
      OPTIONS,
    );

    expect(result.bySku.get("SKU-1")).toBe(196.8);
  });

  it("never overwrites an SRP the configured source supplied", async () => {
    // The explicit value is a fact about the market; the derived one is an
    // inference from our own margin policy, and loses to it every time.
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-1": 100 }, { vatRate: VAT })),
      [variant("SKU-1", { srp: 149 })],
      OPTIONS,
    );

    expect(result.bySku.get("SKU-1")).toBe(149);
  });

  it("leaves everything alone when no markup is configured", async () => {
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-1": 100 }, { vatRate: VAT })),
      [variant("SKU-1")],
      { costsModuleKey: "product_costs", srpMetadataKey: "srp" },
    );

    expect(result.bySku.size).toBe(0);
  });

  it("derives nothing without a VAT rate, rather than marking up a net cost", async () => {
    // The ceiling is compared against gross marketplace prices. Marking up a net
    // cost would cap every offer roughly a VAT rate too low.
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-1": 100 })),
      [variant("SKU-1")],
      OPTIONS,
    );

    expect(result.bySku.size).toBe(0);
  });

  it("derives nothing when the costs module is not installed", async () => {
    const result = await buildSrpBySku(
      containerWith(undefined),
      [variant("SKU-1")],
      OPTIONS,
    );

    expect(result.bySku.size).toBe(0);
  });

  it("derives nothing for a SKU the costs plugin has no cost for", async () => {
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-OTHER": 100 }, { vatRate: VAT })),
      [variant("SKU-1")],
      OPTIONS,
    );

    expect(result.bySku.size).toBe(0);
  });

  it("applies to the price-list path too, for the variants that list did not price", async () => {
    // Same gap, different source: a price list that covers part of the catalogue
    // leaves the rest with no ceiling.
    const result = await buildSrpBySku(
      containerWith(costsService({ "SKU-1": 50 }, { vatRate: VAT })),
      [variant("SKU-1")],
      { costsModuleKey: "product_costs", srpFallbackMarkupPercent: 60 },
    );

    expect(result.bySku.get("SKU-1")).toBe(98.4);
  });
});
