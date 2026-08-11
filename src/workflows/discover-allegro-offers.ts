import type { MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { AllegroApiError } from "../lib/allegro/errors";
import type { AllegroOffer } from "../lib/allegro/types";
import { planOfferDiscovery } from "../lib/sync/offer-discovery";
import type { DiscoveryPlan, OfferConflict, StoredOffer } from "../lib/sync/offer-discovery";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import type AllegroModuleService from "../modules/allegro/service";
import { listEligibleVariants } from "./lib/catalog";
import {
  isFeatureUnavailable,
  listAllOffers,
  resolveOfferPromoted,
  sweepPromotedOffers,
} from "./lib/offers";
import type { OfferListing, PromoSweepResult } from "./lib/offers";
import { runUnderSyncClaim } from "./lib/run";
import type { SyncRunSkip } from "./lib/run";

/**
 * Offer discovery: reconcile the SKU-to-offer mapping against Allegro.
 *
 * The read-only foundation of every write path. One pass:
 *
 * 1. List every seller offer, fail-closed (see `listAllOffers`).
 * 2. Sweep promotion state for the whole catalogue in one paginated pass.
 * 3. Match each offer's sygnatura (`external.id`) to a Medusa variant SKU, with
 *    EAN as the fallback, scoped to the configured sales channel.
 * 4. Upsert the healthy mappings, record the conflicts, unlink the stale links.
 * 5. Discover any category the catalogue references into `allegro_category_rate`
 *    with NULL rates, so an operator has a row to fill in.
 *
 * Nothing here writes to Allegro. Its output is what makes the write paths
 * possible, and its conflicts are what keep them safe: an offer whose SKU is
 * contested, absent, or unmatched is held out of every write path until a human
 * resolves it, because pushing a price or a quantity to the wrong offer is a real
 * mispricing or a real oversell.
 */

export interface DiscoverOffersResult {
  /** Set when the run did nothing. */
  skipped?: string;
  /** Live offers Allegro reported. */
  offersListed: number;
  /** Offers matched to a variant and written. */
  matched: number;
  /** Mapping rows created this run. */
  created: number;
  /** Mapping rows updated this run. */
  updated: number;
  /** Stale links cleared. */
  unlinked: number;
  /** Offers carrying no sygnatura and no EAN. */
  skippedNoSku: number;
  /** Eligible variants no live offer claimed. */
  unmatchedVariants: number;
  /** Conflicts recorded, by code. */
  conflicts: Record<OfferConflict, number>;
  /** Categories referenced by the catalogue. */
  categoriesSeen: number;
  /** Category rate rows created, with NULL rates for an operator to fill in. */
  categoriesCreated: number;
  /** Offers whose promotion state could not be resolved this run. */
  promoUnresolved: number;
  /** The promo-options resource is not provisioned for this integration. */
  promoFeatureUnavailable: boolean;
  error?: string;
}

const emptyConflicts = (): Record<OfferConflict, number> => ({
  "duplicate-sku": 0,
  "missing-external-id": 0,
  "no-offer": 0,
  "no-variant": 0,
});

export const emptyDiscoverOffersResult = (): DiscoverOffersResult => ({
  categoriesCreated: 0,
  categoriesSeen: 0,
  conflicts: emptyConflicts(),
  created: 0,
  matched: 0,
  offersListed: 0,
  promoFeatureUnavailable: false,
  promoUnresolved: 0,
  skippedNoSku: 0,
  unlinked: 0,
  unmatchedVariants: 0,
  updated: 0,
});

/** A stored mapping row, as this engine reads and writes it. */
interface OfferRow extends StoredOffer {
  /** Three-state: true / false / NULL-or-absent meaning "not resolved". */
  promoted?: boolean | null;
  conflict?: OfferConflict | null;
}

/**
 * Apply the plan's upserts and conflicts to the mapping table.
 *
 * The promotion flag is written from the sweep, NOT from the plan: the plan is
 * about identity (which offer owns which SKU) and the sweep is about state, and
 * mixing them would make an unresolved sweep able to clear a flag the plan had no
 * opinion on.
 */
const applyPlan = async (
  allegro: AllegroModuleService,
  plan: DiscoveryPlan,
  sweep: PromoSweepResult,
  offersById: Map<string, AllegroOffer>,
  existingBySku: Map<string, OfferRow>,
): Promise<{ created: number; updated: number; promoUnresolved: number }> => {
  const toCreate: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  let promoUnresolved = 0;

  for (const upsert of plan.upserts) {
    const offer = offersById.get(upsert.offer_id);
    const promotion = offer ? resolveOfferPromoted(offer, sweep) : { unresolved: false };
    if (promotion.unresolved) {
      promoUnresolved += 1;
    }
    const row = {
      ...upsert,
      // A successful mapping clears the row's last error: whatever went wrong last
      // time, the offer is readable and unambiguous now.
      last_error: null,
      // Only written when known. An unresolved sweep must not overwrite the value
      // an operator or an earlier run established.
      ...(promotion.promoted === undefined ? {} : { promoted: promotion.promoted }),
    };
    const existing = existingBySku.get(upsert.sku);
    if (existing) {
      toUpdate.push({ ...row, id: existing.id });
    } else {
      toCreate.push(row);
    }
  }

  for (const conflict of plan.conflicts) {
    const existing = existingBySku.get(conflict.sku);
    const row = {
      conflict: conflict.conflict,
      conflict_detail: conflict.conflict_detail,
      // A conflicted mapping must not keep a usable `offer_id`: that column is what
      // the write paths build their commands from, and leaving it set is how a
      // contested SKU still gets a price pushed to one of the two offers.
      offer_id: null,
      // The promotion state goes with it, for the same reason the unlink pass clears it.
      // A conflicted row has no single owning offer, so its promotion state is UNKNOWN,
      // and a stale `true` or `false` left here would be believed the moment the conflict
      // resolves and the SKU re-links. This pass, not the unlink pass, is what clears a
      // conflicted row: the unlink loop deliberately skips any SKU already queued here,
      // so a stale flag on a `no-offer` row survived indefinitely.
      promoted: null,
      sku: conflict.sku,
    };
    if (existing) {
      toUpdate.push({ ...row, id: existing.id });
    } else {
      toCreate.push(row);
    }
  }

  // Stale links: clear the offer id and the promotion flag together. A promoted flag
  // left behind on an unlinked row would select the promoted commission rate the moment
  // the SKU is re-linked to a plain offer.
  //
  // Cleared to NULL, not to `false`. An unlinked row has no offer, so its promotion
  // state is genuinely UNKNOWN rather than known-absent, and `false` is a claim the
  // plugin cannot support - it would also re-arm price sync on the standard commission
  // the instant the SKU re-linked, before any sweep had confirmed anything.
  for (const sku of plan.unlink) {
    const existing = existingBySku.get(sku);
    // Skip any SKU the conflict pass already queued: two updates for one row in
    // the same call is an ordering question nobody should have to reason about.
    if (!existing || plan.conflicts.some((conflict) => conflict.sku === sku)) {
      continue;
    }
    toUpdate.push({ id: existing.id, offer_id: null, promoted: null });
  }

  if (toCreate.length > 0) {
    await allegro.createAllegroOffers(toCreate as never);
  }
  if (toUpdate.length > 0) {
    await allegro.updateAllegroOffers(toUpdate as never);
  }
  return { created: toCreate.length, promoUnresolved, updated: toUpdate.length };
};

/**
 * Insert a rate row for every category the catalogue references that does not
 * have one yet, with NULL rates.
 *
 * NULL, not zero, and that is the whole point of the pass. A missing commission
 * rate has to stay distinguishable from a zero one: a break-even that reads an
 * unknown rate as 0% quietly turns a loss-making price into an acceptable floor.
 * So the row exists to be visible and fillable, and price sync skips the offer
 * with `missing-break-even` until it is filled.
 */
const discoverCategories = async (
  allegro: AllegroModuleService,
  client: { getCategory: (id: string) => Promise<{ name: string }> },
  categoryIds: readonly string[],
  heartbeat: () => Promise<boolean>,
): Promise<{ created: number; error?: string }> => {
  if (categoryIds.length === 0) {
    return { created: 0 };
  }
  const existing = await allegro.listAllegroCategoryRates({ category_id: [...categoryIds] });
  const known = new Set((existing as { category_id: string }[]).map((row) => row.category_id));
  const missing = categoryIds.filter((id) => !known.has(id));
  if (missing.length === 0) {
    return { created: 0 };
  }

  const rows: { category_id: string; name: string }[] = [];
  let firstError: string | undefined;
  for (const id of missing) {
    // A first sweep of a large catalogue resolves one category name per request,
    // sequentially, which is easily minutes of wall clock.
    await heartbeat();
    // Sequential: a name is cosmetic, and a fan-out of category reads is the
    // cheapest way to earn a 429 on a run that is otherwise well within limits.
    try {
      const category = await client.getCategory(id);
      rows.push({ category_id: id, name: category.name || id });
    } catch (error) {
      if (!(error instanceof AllegroApiError)) {
        throw error;
      }
      // The rate row still gets created, named by its id. An operator needs the
      // row far more than they need the pretty name, and without it price sync
      // skips every offer in the category with no visible reason.
      firstError ??= `GET /sale/categories/${id}: ${error.message}`;
      rows.push({ category_id: id, name: id });
    }
  }

  await allegro.createAllegroCategoryRates(rows as never);
  return { created: rows.length, error: firstError };
};

/** The listing this run produced, so a chained loop can reuse it. */
export interface DiscoverOffersOutput {
  result: DiscoverOffersResult;
  /** Undefined when the run was skipped. */
  listing?: OfferListing;
  /** Undefined when the run was skipped. */
  promo?: PromoSweepResult;
}

/**
 * Run one discovery pass.
 *
 * Exported as a plain function as well as a workflow so the scheduled job can
 * chain it into the monitor and the price loop off ONE offer listing. Listing a
 * catalogue three times an hour to run three loops is the kind of waste that ends
 * in a rate limit, and the listing is the expensive part of all three.
 */
export const runOfferDiscovery = async (
  container: MedusaContainer,
): Promise<DiscoverOffersOutput> => {
  const result = emptyDiscoverOffersResult();

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.OFFERS,
    async ({ allegro, client, heartbeat, logger }) => {
      const [listing, sweep, variants, stored] = await Promise.all([
        listAllOffers(client),
        sweepPromotedOffers(client),
        listEligibleVariants(container, await allegro.getSyncOptions()),
        allegro.listAllegroOffers({}) as Promise<OfferRow[]>,
      ]);

      result.offersListed = listing.offers.length;
      result.promoFeatureUnavailable = sweep.featureUnavailable;
      if (sweep.featureUnavailable) {
        logger.warn(
          '[allegro-offers] the promo-options resource answered "Feature unavailable"; promotion state was not refreshed this run and existing flags were left untouched.',
        );
      }

      const plan = planOfferDiscovery({
        listingComplete: listing.complete,
        offers: listing.offers,
        stored,
        variants,
      });

      const offersById = new Map(listing.offers.map((offer) => [offer.id, offer]));
      const existingBySku = new Map(stored.map((row) => [row.sku, row]));
      const applied = await applyPlan(allegro, plan, sweep, offersById, existingBySku);
      const categories = await discoverCategories(allegro, client, plan.categoryIds, heartbeat);

      result.categoriesCreated = categories.created;
      result.categoriesSeen = plan.categoryIds.length;
      result.created = applied.created;
      result.matched = plan.matched;
      result.promoUnresolved = applied.promoUnresolved;
      result.skippedNoSku = plan.skippedNoSku;
      result.unlinked = plan.unlink.length;
      result.unmatchedVariants = plan.unmatchedVariants;
      result.updated = applied.updated;
      for (const conflict of plan.conflicts) {
        result.conflicts[conflict.conflict] += 1;
      }

      const errorLine = buildDiscoveryError(result, sweep, categories.error);
      result.error = errorLine ?? undefined;
      return {
        outcome: {
          counts: { ...result, conflicts: { ...result.conflicts } },
          lastError: errorLine,
          status: errorLine ? ("error" as const) : ("ok" as const),
        },
        value: { listing, promo: sweep },
      };
    },
    // No kill switch: discovery writes nothing to Allegro, and the write loops all
    // depend on its output. Disabling it would make them silently inert instead of
    // visibly disabled.
  );

  if (!run.ran) {
    result.skipped = run.skip.reason;
    return { result };
  }
  return { listing: run.value.listing, promo: run.value.promo, result };
};

/**
 * The `last_error` line for the admin, or null when the run was clean.
 *
 * A conflict is an error state even though the run itself succeeded, because a
 * conflicted mapping means some part of the catalogue is not being synced at all
 * and nothing else will say so.
 */
const buildDiscoveryError = (
  result: DiscoverOffersResult,
  sweep: PromoSweepResult,
  categoryError?: string,
): string | null => {
  const parts: string[] = [];
  const conflictTotal = Object.values(result.conflicts).reduce((sum, count) => sum + count, 0);
  if (conflictTotal > 0) {
    parts.push(
      `${conflictTotal} mapping conflict(s) are held out of every sync path until resolved: ${Object.entries(
        result.conflicts,
      )
        .filter(([, count]) => count > 0)
        .map(([code, count]) => `${code} x${count}`)
        .join(", ")}`,
    );
  }
  if (result.skippedNoSku > 0) {
    parts.push(
      `${result.skippedNoSku} live offer(s) carry no sygnatura and no EAN, so they cannot be mapped at all`,
    );
  }
  if (sweep.error) {
    parts.push(sweep.error);
  }
  if (sweep.featureUnavailable) {
    parts.push(
      'the promo-options resource answered "Feature unavailable"; promotion state was not refreshed, so price sync will skip offers whose promotion state is unresolved',
    );
  }
  if (categoryError) {
    parts.push(categoryError);
  }
  return parts.length > 0 ? parts.join("; ") : null;
};

const discoverAllegroOffersStep = createStep(
  "discover-allegro-offers",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse((await runOfferDiscovery(container)).result),
);

/**
 * Offer discovery as a workflow, for the admin "run now" action.
 *
 * Deliberately NOT compensated. Every write it makes is an idempotent
 * reconciliation of state Allegro owns, so the repair for a partial run is
 * another run - and a compensation that "undid" a discovery pass would delete
 * mappings the next pass has to rebuild.
 */
export const discoverAllegroOffersWorkflow = createWorkflow(
  "discover-allegro-offers",
  () => new WorkflowResponse(discoverAllegroOffersStep()),
);
