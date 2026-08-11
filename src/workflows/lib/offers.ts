import { MedusaError } from "@medusajs/framework/utils";
import type { AllegroClient } from "../../lib/allegro/client";
import { AllegroApiError } from "../../lib/allegro/errors";
import type { AllegroOffer } from "../../lib/allegro/types";
import { resolveOfferPromotion } from "../../lib/sync/promo";

/** Offers per `GET /sale/offers` page. Allegro's maximum. */
const OFFER_PAGE_LIMIT = 1000;
/** Allegro caps the batch promo-options page at 5000 (also the default). */
export const PROMO_PAGE_LIMIT = 5000;
/** Pages of promo options per sweep, so a runaway catalogue cannot loop forever. */
export const PROMO_MAX_PAGES = 10;

/** A verified snapshot of every offer the seller has. */
export interface OfferListing {
  offers: AllegroOffer[];
  /**
   * True only when every page was accounted for against Allegro's own
   * `totalCount`. Gates the unlink pass: a page that went missing mid-pagination
   * looks exactly like a deleted offer, and unlinking on that evidence clears a
   * mapping the next run cannot rebuild.
   */
  complete: boolean;
  /** Allegro's reported total, for the admin. */
  totalCount: number;
}

/**
 * Every offer the seller has, fail-closed.
 *
 * Throws rather than degrading to a partial list. A short list is
 * indistinguishable from a shrunken catalogue, and every consumer of this
 * function draws a conclusion from an offer's ABSENCE - discovery unlinks it,
 * the stock planner leaves its quantity stale, the monitor stops observing it.
 * So the count is checked against Allegro's own on every page, and a mismatch is
 * an error rather than a smaller array.
 */
export const listAllOffers = async (client: AllegroClient): Promise<OfferListing> => {
  const offers: AllegroOffer[] = [];
  let expectedTotal: number | undefined;

  for (let offset = 0; ; offset += OFFER_PAGE_LIMIT) {
    // Offset pagination: each page depends on the previous one completing.
    const page = await client.listOffers({ limit: OFFER_PAGE_LIMIT, offset });
    expectedTotal ??= page.totalCount;
    if (page.totalCount !== expectedTotal) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Allegro offer count changed during pagination (${expectedTotal} then ${page.totalCount}). Nothing was applied from this listing.`,
      );
    }
    offers.push(...(page.offers ?? []));
    if (offers.length >= expectedTotal) {
      break;
    }
    if ((page.offers ?? []).length === 0) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Incomplete Allegro offer snapshot: received ${offers.length}/${expectedTotal}.`,
      );
    }
  }

  if (offers.length !== expectedTotal) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Incomplete Allegro offer snapshot: received ${offers.length}/${expectedTotal}.`,
    );
  }
  return { complete: true, offers, totalCount: expectedTotal ?? 0 };
};

/**
 * Allegro answers this when the integration lacks the feature flag for an
 * endpoint. Retrying inside a run is pointless, and it is not an outage: the
 * caller degrades that one signal rather than failing the whole pass.
 */
export const isFeatureUnavailable = (error: AllegroApiError): boolean =>
  /Feature unavailable/iu.test(error.message);

/** Result of the bulk promotion sweep. */
export interface PromoSweepResult {
  /**
   * offerId -> carries "Wyróżnienie". NULL when the promotion state could not be
   * determined this run, and the distinction is load-bearing: a COMPLETE map
   * doubles as the "not promoted" signal, because an offer absent from the
   * response carries no packages, and that is what clears a stale flag. A map
   * that is merely incomplete must never clear anything, so it is discarded
   * entirely rather than handed over as a partial answer.
   */
  promotedByOffer: Map<string, boolean> | null;
  featureUnavailable: boolean;
  error?: string;
}

/**
 * Resolve promotion state for every seller offer in one paginated sweep of
 * `GET /sale/offers/promo-options`.
 *
 * One request per 5000 offers instead of one per offer, which is the difference
 * between a sweep that fits in a scheduled run and one that does not. The offer
 * body does not carry promotion state at all, so this endpoint is the only
 * source - and promotion state selects the commission rate, which sets the price
 * floor, so an unresolved sweep must stop price sync rather than default.
 */
export const sweepPromotedOffers = async (client: AllegroClient): Promise<PromoSweepResult> => {
  const promotedByOffer = new Map<string, boolean>();
  try {
    for (let page = 0; page < PROMO_MAX_PAGES; page += 1) {
      // Offset pagination again: each page depends on the previous offset.
      const { promoOptions, totalCount } = await client.listSellerPromoOptions({
        limit: PROMO_PAGE_LIMIT,
        offset: page * PROMO_PAGE_LIMIT,
      });
      for (const options of promoOptions ?? []) {
        if (options.offerId) {
          promotedByOffer.set(options.offerId, resolveOfferPromotion(options));
        }
      }
      const fetched = (promoOptions ?? []).length;
      if (fetched < PROMO_PAGE_LIMIT || promotedByOffer.size >= totalCount) {
        return { featureUnavailable: false, promotedByOffer };
      }
    }
    return {
      error: `promo-options page cap (${PROMO_MAX_PAGES * PROMO_PAGE_LIMIT}) hit; promotion state was not resolved and nothing was cleared`,
      featureUnavailable: false,
      promotedByOffer: null,
    };
  } catch (error) {
    if (!(error instanceof AllegroApiError)) {
      throw error;
    }
    if (isFeatureUnavailable(error)) {
      return { featureUnavailable: true, promotedByOffer: null };
    }
    return {
      error: `GET /sale/offers/promo-options: ${error.message}`,
      featureUnavailable: false,
      promotedByOffer: null,
    };
  }
};

/**
 * Decide an offer's promotion state from the sweep.
 *
 * With a complete map, an offer absent from it carries no packages, so it is not
 * promoted - this is what clears a stale flag. Without a map, `promoted` stays
 * undefined so a previously stored value is never overwritten by an unresolved
 * read, EXCEPT for an offer Allegro explicitly reports as non-ACTIVE: an ended
 * auction cannot be emphasized whatever packages it still carries. An UNKNOWN
 * status never force-clears.
 */
export const resolveOfferPromoted = (
  offer: AllegroOffer,
  sweep: PromoSweepResult,
): { promoted?: boolean; unresolved: boolean } => {
  const status = offer.publication?.status;
  if (status !== undefined && status !== "ACTIVE") {
    return { promoted: false, unresolved: false };
  }
  if (sweep.promotedByOffer) {
    return { promoted: sweep.promotedByOffer.get(offer.id) ?? false, unresolved: false };
  }
  // `unresolved` marks the case worth counting: no map, and NOT because the
  // feature is unavailable. The feature-unavailable case is reported on its own,
  // because the remedy is different (ask Allegro to enable the resource).
  return { unresolved: !sweep.featureUnavailable };
};
