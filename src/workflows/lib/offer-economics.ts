import type { MedusaContainer } from "@medusajs/framework/types";
import { parseAmount } from "../../lib/sync/money";
import { ALLEGRO_MODULE } from "../../modules/allegro";
import type AllegroModuleService from "../../modules/allegro/service";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import {
  buildCategoryRates,
  loadNetCosts,
  resolveCommissionFraction,
  resolveCostsService,
  resolveMargin,
} from "./pricing";

/**
 * What an offer actually earns, measured on the price it is selling at today.
 *
 * The owner's complaint in full: "nie widac marzy od zakupu z uwzglednieniem
 * prowizji allegro". Every margin this plugin showed before was attached to a
 * hypothetical - a break-even floor, or the price some promotion mechanism
 * would set. None of them answered the only question an operator asks while
 * scanning a catalogue: what is this making me right now.
 *
 * ## The anchor is the live price, never the SRP
 *
 * `allegro_offer.price_amount` is what the auction is selling at, as offer
 * discovery last observed it (the upsert is unconditional on every pass, so it
 * is current even when the row's `updated_at` looks old - the ORM simply does
 * not flush an update whose fields all already match).
 *
 * The SRP is deliberately not a fallback. It is a ceiling the automation may be
 * nowhere near, so a margin computed against it describes a sale that is not
 * happening. An offer with no observed price yields no margin at all.
 *
 * ## Everything fails closed
 *
 * A missing cost, a category with no commission rate on file, or an unresolved
 * `promoted` state each leave the margin absent rather than defaulted. That is
 * the same rule the price-sync floor follows and for the same reason: a margin
 * that reads a missing commission as 0% overstates what the offer earns, and
 * this is a number the owner prices against.
 *
 * `promoted === undefined` (the promo sweep has not resolved this offer)
 * selects NO rate rather than the standard one - see `resolveCommissionFraction`,
 * where the same trap is documented at length. The standard rate is the LOWER
 * commission, so defaulting to it would flatter every unresolved offer.
 */

/** The offer fields this resolver reads. Matches `allegro_offer`. */
export interface EconomicsOfferRow {
  sku: string;
  category_id?: string | null;
  price_amount?: string | null;
  price_currency?: string | null;
  /** Three-state: promoted, not promoted, or not yet resolved by the promo sweep. */
  promoted?: boolean | null;
}

/** One offer's economics, every field independently optional. */
export interface OfferEconomics {
  /** The live selling price the margin is measured on. */
  selling_price?: number;
  /** ISO currency of that price, verbatim from Allegro. */
  currency?: string | null;
  /** Net purchase cost per unit, from the costs plugin. */
  net_cost?: number;
  /** That cost grossed up at the costs plugin's VAT rate. */
  cost_gross?: number;
  /** Allegro's commission for this category and promotion state, as a fraction. */
  commission_rate?: number;
  /** That rate applied to the selling price, in money. */
  commission_amount?: number;
  /** `selling_price - commission_amount - cost_gross`. */
  margin_amount?: number;
  /** `margin_amount / selling_price` as a fraction (0.42 = 42%). */
  margin_pct?: number;
}

/**
 * Resolve economics for a set of offers, indexed by SKU.
 *
 * Two bulk reads for the whole set (the category-rate table and the costs
 * plugin's `getCostsBySkus`), then pure arithmetic per offer. Nothing here is
 * per-row I/O, so enriching a page of 100 offers costs the same two queries as
 * enriching one.
 */
export const resolveOfferEconomics = async (
  container: MedusaContainer,
  offers: readonly EconomicsOfferRow[],
): Promise<Map<string, OfferEconomics>> => {
  const bySku = new Map<string, OfferEconomics>();
  if (offers.length === 0) {
    return bySku;
  }

  const allegro = container.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const options = (await allegro.getSyncOptions()) as AllegroSyncOptions;
  const skus = [...new Set(offers.map((offer) => offer.sku).filter(Boolean))];

  const [categoryRateRows, netCostBySku] = await Promise.all([
    allegro.listAllegroCategoryRates({}),
    loadNetCosts(container, options.costsModuleKey, skus),
  ]);
  const categoryRates = buildCategoryRates(categoryRateRows as Record<string, unknown>[]);
  const costs = resolveCostsService(container, options.costsModuleKey);

  for (const offer of offers) {
    const sellingPrice = parseAmount(offer.price_amount ?? null);
    const netCost = netCostBySku.get(offer.sku);
    const commissionRate = resolveCommissionFraction(
      categoryRates,
      offer.category_id,
      offer.promoted ?? undefined,
    );

    const base: OfferEconomics = {
      commission_rate: commissionRate,
      currency: offer.price_currency ?? null,
      net_cost: netCost,
      selling_price: sellingPrice,
    };

    if (sellingPrice === undefined) {
      // No observed price means no margin. Not an error - an offer can be
      // mapped before discovery has ever read a price off it.
      bySku.set(offer.sku, base);
      continue;
    }

    const margin = await resolveMargin(costs, netCost, commissionRate, sellingPrice);
    bySku.set(offer.sku, {
      ...base,
      commission_amount: margin.commissionAmount,
      cost_gross: margin.costGross,
      margin_amount: margin.marginAmount,
      margin_pct: margin.marginPct,
    });
  }

  return bySku;
};
