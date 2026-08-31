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

/** Concurrent per-offer reads in `listOffersByIds`. Matches the command-poll fan-out. */
export const OFFER_READ_CONCURRENCY = 4;

/**
 * Just the named offers, for a push that already knows which ones it is touching.
 *
 * The event-driven quantity push exists to close an oversell window in seconds, and
 * `listAllOffers` is the wrong shape for that: it pages the seller's whole catalogue,
 * which is the expensive part of every loop that uses it and is why those loops share
 * one listing between three stages. Reading three offers after a three-line sale must
 * not cost a full catalogue pass.
 *
 * One request per offer, filtered by `offer.id`, rather than one request naming them
 * all. Allegro documents the repeated form for `external.id` and not for `offer.id`,
 * and an unrecognised repetition would be answered with a WIDER listing rather than an
 * error - which the planner would then read as offers it had asked about and got. The
 * single-valued filter is the one Allegro documents, so it is the one used; at the
 * handful of offers a coalesced push carries, the difference is a few requests against
 * a 9000/min budget.
 *
 * `GET /sale/offers` rather than `GET /sale/product-offers/{id}` on purpose: this is
 * the resource whose response shape every existing consumer is written against, and
 * the planner needs `stock.available` and `publication.status` from it. Reading the
 * one offer through a different resource would be trusting that two payloads agree.
 *
 * DELIBERATELY NOT fail-closed the way `listAllOffers` is. A missing offer here is
 * not evidence of a shrunken catalogue - it is one offer that could not be read - and
 * the planner already counts an authorised offer absent from the listing as
 * `skippedUnmatched` rather than writing to it. So a partial answer degrades to
 * "fewer offers pushed, the rest reported and left to the reconciliation", which is
 * the safe direction.
 */
export const listOffersByIds = async (
  client: AllegroClient,
  offerIds: readonly string[],
): Promise<AllegroOffer[]> => {
  const unique = [...new Set(offerIds.filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }
  const found: AllegroOffer[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const index = next;
      next += 1;
      const offerId = unique[index] as string;
      const page = await client.listOffers({ limit: 1, offerId });
      // Matched by id rather than taken positionally: an ignored or misread filter
      // answers with SOME offer, and writing a quantity onto whatever came back is the
      // one outcome this whole path must never produce.
      const offer = (page.offers ?? []).find((candidate) => candidate.id === offerId);
      if (offer) {
        found.push(offer);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(OFFER_READ_CONCURRENCY, unique.length) }, worker),
  );
  return found;
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
 * With a complete map, an offer absent from it carries no packages, so it is not promoted -
 * this is what clears a stale flag. Without a map, `promoted` stays undefined so a
 * previously stored value is never overwritten by an unresolved read. An UNKNOWN status
 * never force-clears.
 *
 * A non-ACTIVE offer resolves to NULL: its promotion state is not established, which is a
 * different claim from "not promoted". See below for why the difference is money.
 */
export const resolveOfferPromoted = (
  offer: AllegroOffer,
  sweep: PromoSweepResult,
): { promoted?: boolean | null; unresolved: boolean } => {
  const status = offer.publication?.status;
  if (status !== undefined && status !== "ACTIVE") {
    // NULL, not `false`. "An ended auction cannot be emphasized" is true only WHILE the
    // offer is ended, and a hard `false` outlived that state. Discovery upserts offers of
    // every status, so an INACTIVE offer had `promoted: false` recorded as a RESOLVED fact.
    // When the seller then re-activated it and bought a promotion, the next discovery run
    // with an unresolved sweep wrote nothing - so the stale `false` survived and was
    // believed. Price sync floored a genuinely promoted offer on the STANDARD commission,
    // below its true break-even, and the monitor read it as drift and switched it onto the
    // standard rule: actively making it worse, on a live listing.
    //
    // NULL says only what is known: this offer's promotion state is not established. It
    // costs nothing for a non-ACTIVE offer, which every write path skips anyway, and it
    // forces a real answer before the offer is ever priced again.
    return { promoted: null, unresolved: false };
  }
  if (sweep.promotedByOffer) {
    return { promoted: sweep.promotedByOffer.get(offer.id) ?? false, unresolved: false };
  }
  // `unresolved` marks the case worth counting: no map, and NOT because the
  // feature is unavailable. The feature-unavailable case is reported on its own,
  // because the remedy is different (ask Allegro to enable the resource).
  return { unresolved: !sweep.featureUnavailable };
};
