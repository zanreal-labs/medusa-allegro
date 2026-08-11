import type { OfferPromoOptions } from "../allegro/types";

/**
 * Promotion ("Wyróżnienie") resolution.
 *
 * The sale commission depends on the pair (category, promotion), and Allegro does
 * not return a commission rate through the API - the fee-preview endpoint rejects
 * the offer bodies a seller can build from their own live offers. So the rate is
 * maintained by hand per category (`allegro_category_rate`) and the only thing
 * this plugin needs from Allegro is whether each offer is promoted.
 *
 * The offer body does NOT carry promotion state. It comes from the promo-options
 * resource, which is why discovery makes a separate paginated sweep for it.
 */

/** Promo package ids that count as "Wyróżnienie" (emphasized). */
export const EMPHASIZED_PACKAGE_IDS: ReadonlySet<string> = new Set([
  "emphasized1d",
  "emphasized10d",
  "promoPackage",
]);

/** Map an offer's assigned promo packages onto a boolean promoted flag. */
export const resolveOfferPromotion = (promo?: OfferPromoOptions): boolean => {
  if (!promo) {
    return false;
  }
  const ids = [promo.basePackage?.id, ...(promo.extraPackages ?? []).map((entry) => entry.id)];
  return ids.some((id) => EMPHASIZED_PACKAGE_IDS.has(id ?? ""));
};
