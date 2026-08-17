import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { parseAmount, round2 } from "../../lib/sync/money";
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
  getCostsBySkus: (
    skus: string[],
  ) => Promise<{ sku: string; unit_cost_net: number }[]>;
  computeEconomics: (input: {
    netCost?: number;
    commissionRate?: number;
  }) => Promise<{ breakEvenPrice?: number; grossCost?: number }>;
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
      commissionRate: parseAmount(
        row.commission_rate as string | number | null,
      ),
      promotedCommissionRate: parseAmount(
        row.promoted_commission_rate as string | number | null,
      ),
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
  promoted: boolean | undefined,
): number | undefined => {
  if (!categoryId) {
    return undefined;
  }
  // An unresolved promotion state cannot select a rate, so it selects NONE. Defaulting to
  // the standard rate here would quietly re-create the bug the nullable `promoted` column
  // exists to prevent: the standard rate is the LOWER commission, so it yields a floor
  // below a promoted offer's true break-even. The eligibility ladder refuses such an offer
  // anyway, but a defaulted rate one call earlier is a live trap for the next caller who
  // reaches for this function without that gate in front of it.
  if (promoted === undefined) {
    return undefined;
  }
  const entry = rates.get(categoryId);
  const percent = promoted
    ? entry?.promotedCommissionRate
    : entry?.commissionRate;
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
  (
    sku: string,
    commissionFraction: number | undefined,
  ) => Promise<number | undefined>
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
 * Resolved SRP data, split by whether the source carried a currency.
 *
 * The split exists because the two sources are genuinely different facts. A number in
 * variant metadata has no currency attached and is implicitly in the offer's own currency,
 * which is what the operator meant. A price-list row DOES carry a currency, and using it for
 * an offer in a different one would be a mispricing.
 */
export interface SrpSource {
  /** SRP by SKU with no currency attached (the metadata path). */
  bySku: Map<string, number>;
  /** SRP by SKU, then by lower-cased currency (the price-list path). */
  byCurrency: Map<string, Map<string, number>>;
}

/**
 * SRP (the ceiling) per variant SKU, from whichever source is configured.
 *
 * `srpMetadataKey` reads a numeric value from the variant's `metadata`, falling
 * back to the product's - a store that prices a whole product at one RRP should
 * not have to repeat it on every variant. `srpPriceListId` reads the variant's
 * price in that list, per currency.
 *
 * With neither configured the result is empty and every offer is skipped with
 * `missing-srp`. That is a legitimate, loudly-visible state rather than an error:
 * a store can run discovery and the monitor with no SRP source at all, and only
 * price sync needs one.
 */
/**
 * SRP derived from what the item cost, for variants no source priced.
 *
 * A supplier that publishes no RRP leaves the ceiling undefined, and an offer
 * with no ceiling is skipped by price sync entirely - so a gap in someone else's
 * price list silently takes our own offers out of the automation. Deriving one
 * from the purchase price keeps them in it.
 *
 * The basis is the GROSS cost, because the ceiling is compared against gross
 * marketplace prices; `computeEconomics` grosses the net cost up at the VAT rate
 * the costs plugin is configured with, so the two never disagree about what an
 * item cost.
 *
 * Only ever a fallback. An explicit SRP is a fact about the market; this is an
 * inference from our own margin policy, and the moment a real one exists it
 * wins.
 */
const deriveSrpFromCost = async (
  costs: ProductCostsService | undefined,
  skus: readonly string[],
  markupPercent: number,
): Promise<Map<string, number>> => {
  const derived = new Map<string, number>();
  if (!costs || skus.length === 0) {
    return derived;
  }

  const rows = await costs.getCostsBySkus([...skus]);
  const multiplier = 1 + markupPercent / 100;

  for (const row of rows) {
    const netCost = parseAmount(row.unit_cost_net);
    if (netCost === undefined || netCost <= 0) {
      continue;
    }
    const { grossCost } = await costs.computeEconomics({ netCost });
    if (grossCost === undefined || grossCost <= 0) {
      // No VAT rate configured, so there is no gross cost to mark up. Left out
      // rather than defaulted: a ceiling guessed from a rate nobody set is how
      // an offer gets capped at a number that means nothing.
      continue;
    }
    derived.set(row.sku, round2(grossCost * multiplier));
  }

  return derived;
};

/**
 * Fill the gaps left by the configured SRP source, in place.
 *
 * Deliberately not a merge of two maps: only SKUs the source did not price are
 * considered, so an explicit SRP can never be overwritten by a derived one.
 * Absent `srpFallbackMarkupPercent` leaves everything exactly as it was, which
 * is the behaviour every store gets until it opts in.
 */
const applyCostFallback = async (
  container: MedusaContainer,
  variants: readonly CatalogVariant[],
  options: Pick<
    AllegroSyncOptions,
    "srpFallbackMarkupPercent" | "costsModuleKey"
  >,
  srpBySku: Map<string, number>,
): Promise<void> => {
  const markupPercent = options.srpFallbackMarkupPercent;
  if (markupPercent === undefined || markupPercent === null) {
    return;
  }

  const unpriced = variants
    .map((variant) => variant.sku)
    .filter((sku) => !srpBySku.has(sku));
  if (unpriced.length === 0) {
    return;
  }

  const derived = await deriveSrpFromCost(
    resolveCostsService(container, options.costsModuleKey),
    unpriced,
    markupPercent,
  );
  for (const [sku, srp] of derived) {
    srpBySku.set(sku, srp);
  }
};

export const buildSrpBySku = async (
  container: MedusaContainer,
  variants: readonly CatalogVariant[],
  options: Pick<
    AllegroSyncOptions,
    | "srpMetadataKey"
    | "srpPriceListId"
    | "srpFallbackMarkupPercent"
    | "costsModuleKey"
  >,
): Promise<SrpSource> => {
  const srpBySku = new Map<string, number>();
  const srpByCurrency = new Map<string, Map<string, number>>();

  if (options.srpMetadataKey) {
    const key = options.srpMetadataKey;
    for (const variant of variants) {
      const fromVariant = parseAmount(
        variant.metadata?.[key] as string | number | null,
      );
      const fromProduct = parseAmount(
        variant.productMetadata?.[key] as string | number | null,
      );
      const srp = fromVariant ?? fromProduct;
      if (srp !== undefined && srp > 0) {
        srpBySku.set(variant.sku, srp);
      }
    }
    await applyCostFallback(container, variants, options, srpBySku);
    return { byCurrency: srpByCurrency, bySku: srpBySku };
  }

  if (!options.srpPriceListId) {
    await applyCostFallback(container, variants, options, srpBySku);
    return { byCurrency: srpByCurrency, bySku: srpBySku };
  }

  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const skuByVariantId = new Map(
    variants.map((variant) => [variant.id, variant.sku]),
  );
  const { data } = await query.graph({
    entity: "price_list",
    fields: [
      "id",
      "prices.amount",
      "prices.currency_code",
      "prices.price_set.variant.id",
    ],
    filters: { id: options.srpPriceListId },
  });

  const prices = (data[0]?.prices ?? []) as {
    amount?: number | string;
    currency_code?: string | null;
    price_set?: { variant?: { id?: string } };
  }[];
  for (const price of prices) {
    const variantId = price.price_set?.variant?.id;
    const sku = variantId ? skuByVariantId.get(variantId) : undefined;
    const amount = parseAmount(price.amount ?? null);
    const currency = price.currency_code?.trim().toLowerCase();
    // Keyed by CURRENCY as well as SKU. `currency_code` was already being requested by the
    // query above and then ignored, so on a multi-currency price list - the normal shape for
    // a store selling in more than one - whichever row came last won for that SKU. A EUR
    // amount could therefore become the PLN ceiling of a price-automation rule, roughly a
    // quarter of the intended figure, and the rule would then be licensed to sell down to it.
    // A price carrying no currency is not usable here and is dropped rather than guessed.
    if (sku && currency && amount !== undefined && amount > 0) {
      const byCurrency = srpByCurrency.get(sku) ?? new Map<string, number>();
      byCurrency.set(currency, amount);
      srpByCurrency.set(sku, byCurrency);
    }
  }
  return { byCurrency: srpByCurrency, bySku: srpBySku };
};

/**
 * The SRP to use as a ceiling for one offer, in the offer's OWN currency.
 *
 * There is deliberately no cross-currency conversion: a converted ceiling would silently
 * depend on a rate this plugin does not have and cannot audit. An offer whose currency has
 * no SRP is skipped with `missing-srp`, the same fail-closed answer as having none at all.
 *
 * The metadata path carries no currency, so it applies whatever the offer's currency is -
 * that is the operator's stated intent when they put a bare number in `metadata.srp`.
 */
export const resolveSrp = (
  source: SrpSource,
  sku: string,
  currency: string,
): number | undefined =>
  source.byCurrency.get(sku)?.get(currency.trim().toLowerCase()) ??
  source.bySku.get(sku);

/**
 * The Medusa price per variant SKU, per currency - the number fixed-price mode
 * pushes.
 *
 * Read off the variants the catalogue pass already loaded, so this costs no extra
 * query. Two rules, both fail-closed:
 *
 * - **Currency is not optional.** A price row with no currency cannot be matched
 *   to an offer, and guessing one would push a EUR figure onto a PLN offer. It is
 *   dropped, and the offer reports `missing-medusa-price` rather than being
 *   priced from something that merely looked like a number.
 * - **Price-list rows are not the variant's price.** A row carrying a
 *   `price_list_id` is a sale or a customer-group override with its own validity
 *   window and conditions, none of which this plugin evaluates. Pushing one as
 *   "the Medusa price" would leave a sale price on Allegro long after the sale
 *   ended, so only the variant's own default price counts.
 *
 * Same shape as the price-list half of `SrpSource` on purpose: both answer "what
 * number applies to this SKU in this currency", and sharing the shape means
 * `resolveSrp`'s currency-matching reasoning does not have to be re-derived.
 */
export const buildVariantPriceBySku = (
  variants: readonly CatalogVariant[],
): Map<string, Map<string, number>> => {
  const byCurrency = new Map<string, Map<string, number>>();
  for (const variant of variants) {
    for (const price of variant.prices ?? []) {
      if (price.priceListId) {
        continue;
      }
      const currency = price.currency_code?.trim().toLowerCase();
      const amount = parseAmount(price.amount ?? null);
      if (!currency || amount === undefined || amount <= 0) {
        continue;
      }
      const forSku = byCurrency.get(variant.sku) ?? new Map<string, number>();
      forSku.set(currency, amount);
      byCurrency.set(variant.sku, forSku);
    }
  }
  return byCurrency;
};

/** One SKU's Medusa price in a given currency, or undefined when it has none. */
export const resolveVariantPrice = (
  prices: Map<string, Map<string, number>>,
  sku: string,
  currency: string,
): number | undefined => prices.get(sku)?.get(currency.trim().toLowerCase());

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
