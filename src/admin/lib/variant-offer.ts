import type { OfferConflict, OfferRow } from "./types";

/**
 * One variant's Allegro offer state, as the Catalog column renders it.
 *
 * There is nothing to aggregate here any more. The admin-kit Catalog lists one
 * variant per row, and an Allegro offer maps to exactly one SKU, so a row has
 * at most one offer. The predecessor rolled a product's SKUs up into
 * "3 offers / 1 conflict", which told an operator that something was broken
 * without telling them which SKU - the one thing they needed in order to act.
 *
 * Kept framework-free so it can be asserted directly in a Jest unit spec
 * without a React renderer, the same way the rest of `src/admin/lib` is tested.
 */

/**
 * What the row's mapping is doing, worst-first. `conflict` outranks `drift`
 * because an unresolved mapping conflict means nothing is syncing at all,
 * whereas drift means it syncs to the wrong automation rule.
 */
export type VariantOfferState = "conflict" | "drift" | "listed" | "unlinked";

export interface VariantOffer {
  state: VariantOfferState;
  /** The live Allegro offer id, when the mapping resolved to one. */
  offerId: string | null;
  /** Allegro's own status for the offer (e.g. `ACTIVE`), when known. */
  status: string | null;
  /** The unresolved mapping conflict, when `state` is `"conflict"`. */
  conflict: OfferConflict | null;
}

/**
 * Pick the offer row belonging to `sku` out of a `/admin/allegro/offers`
 * response and classify it.
 *
 * Returns `null` when the variant has no SKU, or has one with no offer mapping
 * at all - both render as a muted "not listed", which is a fact about this one
 * variant rather than a count across a product.
 */
export function resolveVariantOffer(offers: OfferRow[], sku: string | null): VariantOffer | null {
  if (!sku) {
    return null;
  }
  const match = offers.find((offer) => offer.sku === sku);
  if (!match) {
    return null;
  }

  const base = {
    conflict: match.conflict ?? null,
    offerId: match.offer_id ?? null,
    status: match.status ?? null,
  };

  if (match.conflict) {
    return { ...base, state: "conflict" };
  }
  if (match.price_automation_drift) {
    return { ...base, state: "drift" };
  }
  return { ...base, state: match.offer_id ? "listed" : "unlinked" };
}

/**
 * Render a resolved offer as the column's label. Names the actual problem for
 * this SKU (`"duplicate-sku"`, `"drift"`) rather than counting problems.
 */
export function formatVariantOffer(offer: VariantOffer): string {
  switch (offer.state) {
    case "conflict": {
      return offer.conflict ?? "conflict";
    }
    case "drift": {
      return "drift";
    }
    case "unlinked": {
      return "unlinked";
    }
    default: {
      return offer.status ? offer.status.toLowerCase() : "listed";
    }
  }
}

/** The `StatusBadge` colour for a resolved offer. */
export function variantOfferColor(offer: VariantOffer): "green" | "orange" | "red" | "grey" {
  switch (offer.state) {
    case "conflict": {
      return "red";
    }
    case "drift": {
      return "orange";
    }
    case "unlinked": {
      return "grey";
    }
    default: {
      return "green";
    }
  }
}
