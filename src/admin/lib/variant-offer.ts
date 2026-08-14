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
 * The live Allegro price for one variant, as the Catalog price column shows it.
 *
 * `price_mode` and `promoted` ride along because they are what the number
 * means: 365.31 under an attached automation rule is a price Allegro is moving,
 * 365.31 on a paused or ended offer is a price nobody can buy at. A column that
 * showed the figure alone would read as current when it is not.
 */
export interface VariantOfferPrice {
  amount: number;
  /** ISO code, verbatim from Allegro, uppercased. */
  currency: string | null;
  /** `automated` / `fixed` / `paused` / `ended` / `unknown`, as last observed. */
  priceMode: string | null;
  /** Three-state: promoted, not promoted, or not yet resolved by the promo sweep. */
  promoted: boolean | null;
}

/**
 * Read the offer's price, which Allegro stores as a **decimal string**.
 *
 * `allegro_offer.price_amount` is `model.text()` holding what the marketplace
 * returned verbatim, e.g. `"365.31"`. It is a string amount, not a Medusa
 * `BigNumber`, so it is parsed as a string and nothing here reaches for a
 * `numeric` accessor or a raw `{ value }` wrapper that will never be there.
 *
 * `Number` rather than `Number.parseFloat`, because `parseFloat("365,31")` is
 * `365`: it stops at the comma and silently drops the grosze, turning a
 * malformed field into a plausible price 31 grosze light. A value this cannot
 * read returns `null` and the cell shows a dash, because 0 is a price Allegro
 * could in principle carry and "unreadable" must not become "free".
 */
export function resolveVariantOfferPrice(offer: OfferRow | null): VariantOfferPrice | null {
  const raw = offer?.price_amount;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const text = String(raw).trim();
  if (text.length === 0) {
    return null;
  }
  const amount = Number(text);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const currency = offer?.price_currency;
  return {
    amount,
    currency: typeof currency === "string" && currency.length > 0 ? currency.toUpperCase() : null,
    priceMode: offer?.price_mode ?? null,
    promoted: offer?.promoted ?? null,
  };
}

/**
 * Whether a price is one a buyer can act on right now.
 *
 * `paused` and `ended` offers keep their last observed price, which is a fact
 * about history rather than about what the shop is selling at. The cell mutes
 * those so an operator scanning the column does not read a dead price as live.
 */
export function isLiveOfferPrice(price: VariantOfferPrice): boolean {
  return price.priceMode !== "paused" && price.priceMode !== "ended";
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
  return classifyVariantOffer(offers.find((offer) => offer.sku === sku) ?? null);
}

/**
 * Classify one already-selected offer row.
 *
 * The selection by SKU now happens once per request in the batcher rather than
 * once per cell, so this is the half the column actually calls. Kept separate
 * from {@link resolveVariantOffer} so the classification rules have one
 * definition no matter which side picked the row.
 */
export function classifyVariantOffer(match: OfferRow | null): VariantOffer | null {
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
