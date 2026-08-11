import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { parseAmount } from "../../lib/sync/money";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type { CatalogVariant } from "./catalog";

/**
 * The two bounds a price-automation command needs, and where they come from.
 *
 * `[ceil(break-even), SRP]`. Both inputs are resolved from outside this plugin,
 * and BOTH are allowed to be missing - in which case the offer is skipped with a
 * counted reason and nothing is written. There is deliberately no default for
 * either:
 *
 * - A defaulted floor is a licence to sell at a loss. A break-even that reads a
 *   missing commission rate as 0%, or a missing cost as 0, produces a floor far
 *   below the real one and an automation rule will happily walk the price down to
 *   it.
 * - A defaulted ceiling - the current selling price being the obvious candidate -
 *   lets a rule ratchet downward indefinitely: each run's price becomes the next
 *   run's ceiling.
 *
 * So "unresolvable" is a first-class outcome here, and the skip reasons
 * `missing-break-even` / `missing-srp` are what surface it.
 */

/** What the costs plugin exposes, duck-typed. */
interface ProductCostsService {
  getCostsBySkus: (skus: string[]) => Promise<{ sku: string; unit_cost_net: number }[]>;
  computeEconomics: (input: {
    netCost?: number;
    commissionRate?: number;
  }) => Promise<{ breakEvenPrice?: number }>;
}

/**
 * Resolve the optional costs module.
 *
 * A SOFT dependency: `@zanreal/medusa-product-costs` supplies purchase costs, and
 * a store that has not installed it simply has no break-even for any offer. That
 * is a supported configuration - the read-only monitor and offer discovery are
 * fully useful without it - so an absent module is `undefined` rather than a
 * boot failure, and price sync reports every offer as `missing-break-even`.
 *
 * Duck-typed on the two methods actually used, so a version skew that renames
 * something else does not break the resolve.
 */
export const resolveCostsService = (
  container: MedusaContainer,
  costsModuleKey: string,
): ProductCostsService | undefined => {
  try {
    const service = container.resolve<ProductCostsService>(costsModuleKey);
    if (
      typeof service?.getCostsBySkus === "function" &&
      typeof service?.computeEconomics === "function"
    ) {
      return service;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** Commission rates for one Allegro category, as maintained by hand. */
export interface CategoryRates {
  commissionRate?: number;
  promotedCommissionRate?: number;
}

/** Category id -> rates. A category with no row at all is simply absent. */
export const buildCategoryRates = (
  rows: readonly Record<string, unknown>[],
): Map<string, CategoryRates> => {
  const rates = new Map<string, CategoryRates>();
  for (const row of rows) {
    const categoryId = row.category_id as string | undefined;
    if (!categoryId) {
      continue;
    }
    rates.set(categoryId, {
      // `parseAmount` rather than `Number`: a big-number column arrives as a
      // string, and a null one must stay undefined rather than becoming 0. A 0%
      // commission and an unknown commission produce very different floors.
      commissionRate: parseAmount(row.commission_rate as string | number | null),
      promotedCommissionRate: parseAmount(row.promoted_commission_rate as string | number | null),
    });
  }
  return rates;
};

/**
 * The commission rate that applies to one offer, as a FRACTION.
 *
 * Rates are stored as percentages (9.5 means 9.5%), because that is how Allegro
 * publishes its fee table and therefore how an operator types them in. The
 * break-even formula needs a fraction, so the conversion happens here, once.
 *
 * Undefined when the category has no row, or when the rate for THIS promotion
 * state is null. The second case matters: a category can have a standard rate
 * filled in and its promoted rate still blank, and a promoted offer must then be
 * skipped rather than floored on the standard rate.
 */
export const resolveCommissionFraction = (
  rates: Map<string, CategoryRates>,
  categoryId: string | null | undefined,
  promoted: boolean,
): number | undefined => {
  if (!categoryId) {
    return undefined;
  }
  const entry = rates.get(categoryId);
  const percent = promoted ? entry?.promotedCommissionRate : entry?.commissionRate;
  if (percent === undefined) {
    return undefined;
  }
  return percent / 100;
};

/**
 * Break-even price per SKU: the smallest gross price at which net income is zero.
 *
 * Computed through the costs plugin rather than reimplemented, so the VAT rate is
 * the one that plugin is configured with and the two never disagree about what an
 * item costs. `getCostsBySkus` is one bulk read; `computeEconomics` is then pure
 * arithmetic per offer because the net cost is passed in explicitly.
 */
/** Resolves nothing, for the no-costs-module case. */
const NO_BREAK_EVEN = async (): Promise<number | undefined> => undefined;

export const buildBreakEvenResolver = async (
  costs: ProductCostsService | undefined,
  skus: readonly string[],
): Promise<
  (sku: string, commissionFraction: number | undefined) => Promise<number | undefined>
> => {
  if (!costs || skus.length === 0) {
    // No costs plugin installed, or nothing to look up: every offer resolves to
    // `missing-break-even`, which is exactly the intended outcome. A soft
    // dependency means an absent costs module is a supported configuration, not a
    // failure - and never a defaulted floor.
    return NO_BREAK_EVEN;
  }
  const rows = await costs.getCostsBySkus([...skus]);
  const netCostBySku = new Map<string, number>();
  for (const row of rows) {
    const netCost = parseAmount(row.unit_cost_net);
    if (netCost !== undefined) {
      netCostBySku.set(row.sku, netCost);
    }
  }

  return async (sku, commissionFraction) => {
    const netCost = netCostBySku.get(sku);
    // Both inputs are required. A commission of 100% or more has no finite
    // break-even at all, and the costs plugin returns undefined for it rather than
    // a division artefact.
    if (netCost === undefined || commissionFraction === undefined) {
      return;
    }
    const { breakEvenPrice } = await costs.computeEconomics({
      commissionRate: commissionFraction,
      netCost,
    });
    return breakEvenPrice;
  };
};

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

/**
 * SRP (the ceiling) per variant SKU, from whichever source is configured.
 *
 * `srpMetadataKey` reads a numeric value from the variant's `metadata`, falling
 * back to the product's - a store that prices a whole product at one RRP should
 * not have to repeat it on every variant. `srpPriceListId` reads the variant's
 * price in that list.
 *
 * With neither configured the map is empty and every offer is skipped with
 * `missing-srp`. That is a legitimate, loudly-visible state rather than an error:
 * a store can run discovery and the monitor with no SRP source at all, and only
 * price sync needs one.
 */
export const buildSrpBySku = async (
  container: MedusaContainer,
  variants: readonly CatalogVariant[],
  options: Pick<AllegroSyncOptions, "srpMetadataKey" | "srpPriceListId">,
): Promise<Map<string, number>> => {
  const srpBySku = new Map<string, number>();

  if (options.srpMetadataKey) {
    const key = options.srpMetadataKey;
    for (const variant of variants) {
      const fromVariant = parseAmount(variant.metadata?.[key] as string | number | null);
      const fromProduct = parseAmount(variant.productMetadata?.[key] as string | number | null);
      const srp = fromVariant ?? fromProduct;
      if (srp !== undefined && srp > 0) {
        srpBySku.set(variant.sku, srp);
      }
    }
    return srpBySku;
  }

  if (!options.srpPriceListId) {
    return srpBySku;
  }

  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const skuByVariantId = new Map(variants.map((variant) => [variant.id, variant.sku]));
  const { data } = await query.graph({
    entity: "price_list",
    fields: ["id", "prices.amount", "prices.currency_code", "prices.price_set.variant.id"],
    filters: { id: options.srpPriceListId },
  });

  const prices = (data[0]?.prices ?? []) as {
    amount?: number | string;
    price_set?: { variant?: { id?: string } };
  }[];
  for (const price of prices) {
    const variantId = price.price_set?.variant?.id;
    const sku = variantId ? skuByVariantId.get(variantId) : undefined;
    const amount = parseAmount(price.amount ?? null);
    if (sku && amount !== undefined && amount > 0) {
      srpBySku.set(sku, amount);
    }
  }
  return srpBySku;
};

/**
 * Warn once when the SRP source is not configured at all.
 *
 * Worth a dedicated line because the symptom is a whole catalogue skipped with
 * `missing-srp`, which reads like a data problem rather than a configuration one.
 */
export const warnOnMissingSrpSource = (
  logger: Logger,
  options: Pick<AllegroSyncOptions, "srpMetadataKey" | "srpPriceListId">,
): void => {
  if (!(options.srpMetadataKey || options.srpPriceListId)) {
    logger.warn(
      "[allegro-prices] no SRP source is configured (`srpMetadataKey` or `srpPriceListId`), so every offer will be skipped with reason missing-srp. The SRP is the price-range ceiling; there is no fallback to the current selling price, because that would let a rule ratchet the price down on every run.",
    );
  }
};
