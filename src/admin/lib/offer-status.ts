import type { OfferRow } from "./types";

/**
 * Product-level roll-up of a set of `OfferRow`s (one product's variants can map
 * to several Allegro offers, one per SKU). Kept framework-free so it can be
 * asserted directly in a Jest unit spec without a React renderer, the same way
 * the rest of `src/admin/lib` is tested.
 */
export interface OfferStatusSummary {
  /** How many of the product's SKUs have an offer mapping at all. */
  total: number;
  /** Of those, how many are linked to a live Allegro offer with no conflict. */
  linked: number;
  /** Of those, how many carry an unresolved mapping conflict. */
  conflicts: number;
}

/**
 * Aggregate a product's offer rows (looked up by its variants' SKUs) into one
 * {@link OfferStatusSummary} for the admin-kit Catalog column.
 */
export function summarizeOfferStatus(offers: OfferRow[]): OfferStatusSummary {
  let linked = 0;
  let conflicts = 0;
  for (const offer of offers) {
    if (offer.conflict) {
      conflicts += 1;
    } else if (offer.offer_id) {
      linked += 1;
    }
  }
  return { conflicts, linked, total: offers.length };
}

/**
 * Render a summary as the column's label, e.g. "3 offers / 1 conflict" or
 * "2 offers". Callers handle the `total === 0` ("no offers") case themselves,
 * since that renders as a muted dash rather than this string.
 */
export function formatOfferStatus(summary: OfferStatusSummary): string {
  const base = `${summary.total} offer${summary.total === 1 ? "" : "s"}`;
  if (summary.conflicts === 0) {
    return base;
  }
  return `${base} / ${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"}`;
}
