import type { OfferRow } from "./types";

/**
 * What one offer earns, as every Allegro surface renders it.
 *
 * This is the single classifier behind three places: the Catalog list column,
 * the product-detail card and the variant-detail card. One helper means the
 * figure an operator sees while scanning the catalogue is the same figure they
 * see after clicking into the variant, and that a variant which shows "brak
 * prowizji" in one place cannot show a confident number in another.
 *
 * The states are exhaustive and ordered so the label names the thing an
 * operator has to go and fix:
 *
 * - `no-offer` - this SKU is not mapped to an Allegro auction. At this store
 *   listing is done by hand, so most of the catalogue is legitimately in this
 *   state; it is the one case that renders quietly rather than in amber.
 * - `no-price` - mapped, but discovery has never observed a price on it, so
 *   there is nothing to measure a margin against.
 * - `no-cost` - no purchase cost on file for the SKU.
 * - `no-commission` - the offer's category has no rate filled in, or the promo
 *   sweep has not resolved whether the offer is promoted (which selects which
 *   of the two rates applies). Both are genuinely unknown commissions, and an
 *   unknown commission must never be read as 0%.
 * - `resolved` - a real margin, measured on the live price.
 *
 * Kept framework-free so it is asserted directly in a Jest unit spec without a
 * React renderer, the same way the rest of `src/admin/lib` is.
 */
export type VariantMargin =
  | {
      state: "resolved";
      /** Money left after commission and gross cost. */
      amount: number;
      /** `amount / sellingPrice` as a fraction (0.42 = 42%). */
      pct: number;
      /** The live Allegro price the margin is measured on. */
      sellingPrice: number;
      /** Commission fraction applied, echoed as evidence. */
      commissionRate: number;
      /** That rate in money. */
      commissionAmount?: number;
      /** Gross purchase cost the margin is measured against. */
      costGross?: number;
      currency: string | null;
    }
  | { state: "no-offer" }
  | { state: "no-price" }
  | { state: "no-cost" }
  | { state: "no-commission" };

/** Whether a state is a gap an operator should act on (amber) rather than a normal absence. */
export function isMarginGap(margin: VariantMargin): boolean {
  return margin.state !== "resolved" && margin.state !== "no-offer";
}

/**
 * Classify one offer row's economics.
 *
 * Reads the `economics` block the offers route attaches under `?economics=1`.
 * A row fetched without that flag has no block at all, which is reported as
 * `no-price` rather than pretended to be a margin - a caller that forgot the
 * flag should see a gap, not a confident blank.
 */
export function classifyVariantMargin(offer: OfferRow | null): VariantMargin {
  if (!offer) {
    return { state: "no-offer" };
  }
  const economics = offer.economics;
  if (!economics || economics.selling_price === undefined) {
    return { state: "no-price" };
  }
  // Cost before commission: a store that has not costed a SKU at all should be
  // told that first, since filling in a category rate would not help it.
  if (economics.net_cost === undefined) {
    return { state: "no-cost" };
  }
  if (economics.commission_rate === undefined) {
    return { state: "no-commission" };
  }
  if (economics.margin_amount === undefined || economics.margin_pct === undefined) {
    // Every input was present but the costs plugin still declined to produce a
    // figure - in practice a VAT rate it has not been configured with. Reported
    // as a missing cost because that is the plugin an operator has to go to.
    return { state: "no-cost" };
  }
  return {
    amount: economics.margin_amount,
    commissionAmount: economics.commission_amount,
    commissionRate: economics.commission_rate,
    costGross: economics.cost_gross,
    currency: economics.currency ?? null,
    pct: economics.margin_pct,
    sellingPrice: economics.selling_price,
    state: "resolved",
  };
}
