import { MedusaError } from "@medusajs/framework/utils";
import type { AllegroOffer } from "../allegro/types";

/**
 * Pure planner for the quantity push.
 *
 * Medusa inventory is the source of truth for the quantity that reaches Allegro.
 * Keeping Medusa inventory honest is somebody else's job - in this stack, the
 * `@zanreal/medusa-marken` plugin, which owns the supplier snapshot and the
 * `stockArmed` gate that refuses to propagate an untrustworthy one. This planner
 * assumes the inventory it is handed is already trustworthy and concerns itself
 * only with the marketplace side: which offers may be written to, and what.
 *
 * ## The mapping row authorises the write AND supplies the pairing
 *
 * Both, together, and that is the correctness argument. The planner used to take the
 * authorisation from the mapping table but re-derive which VARIANT an offer belonged to
 * from the live listing. The two could disagree: a seller editing a sygnatura between
 * discovery and the push left offer A's row authorising a write whose quantity was
 * computed from variant B, and nothing compared them. So the pairing travels with the
 * authorisation (`AuthorizedOffer`), and the live listing is used only to VERIFY that it
 * still agrees. A disagreement is a recorded conflict, never a silent re-pair.
 *
 * ## Every authorised offer lands in exactly one counted bucket
 *
 * That is a contract, not an aspiration: a run that changes nothing has to be able to say
 * why for every offer it was allowed to touch. Offer-side buckets:
 *
 * - `alreadyInSync` - already carrying the desired quantity.
 * - `mismatched` - planned for a write.
 * - `ambiguous` - the row's SKU matches more than one eligible variant.
 * - `skippedInactive` - not ACTIVE, so its quantity is meaningless.
 * - `skippedNoInventory` - the variant structurally has no quantity to publish.
 * - `skippedUnmatched` - absent from the listing, or its SKU matches no eligible variant.
 * - `conflicted` - the live offer contradicts the mapping row.
 * - `unresolved` - a quantity could not be READ on either side, so the delta is unknown.
 *   Never treated as 0: pushing a guessed quantity is how an oversell or a silent
 *   delisting happens.
 *
 * Plus one variant-side bucket, `skippedUnlinked`: an eligible variant no authorised offer
 * claimed, so its quantity is never published anywhere.
 */

/** An eligible variant's available quantity, as read from Medusa inventory. */
export interface VariantStock {
  sku: string;
  /** Available quantity at the configured location(s). Absent when unavailable. */
  quantity?: number;
  /**
   * Why `quantity` is absent, when it is.
   *
   * - `no-inventory` - the variant structurally has none (does not manage inventory, or
   *   has no inventory items). A bounded, permanent exclusion: the offer is skipped and
   *   counted and the rest of the catalogue still syncs. Refusing the whole plan for this
   *   meant one digital product with an Allegro offer wedged stock sync for every other
   *   offer, indefinitely.
   * - `unreadable` - the read failed. Unknown, and of unknown blast radius, so the whole
   *   plan is refused.
   */
  absent?: "no-inventory" | "unreadable";
  /** Barcode/EAN, matched against an offer's EAN when the offer carries no sygnatura. */
  ean?: string;
}

/**
 * An offer the mapping table AUTHORISES a write to, paired with the variant it records.
 *
 * Built from `allegro_offer` rows that are linked and unconflicted. Reading the pairing
 * from here rather than from the live listing is what makes discovery's conflict detection
 * actually bind on the write path.
 */
export interface AuthorizedOffer {
  offerId: string;
  /** The variant SKU the `allegro_offer` row records for this offer. */
  sku: string;
}

/** Conflict codes this planner can record on a mapping row. */
export type StockConflict = "sku-mismatch";

/** A mapping row whose live offer contradicts it: recorded, skipped, counted. */
export interface StockConflictRecord {
  sku: string;
  offerId: string;
  conflict: StockConflict;
  conflict_detail: string;
}

/** One quantity to set on one offer. */
export interface StockChange {
  offerId: string;
  desired: number;
}

export interface StockSyncSummary {
  /** Offers already carrying the desired quantity. */
  alreadyInSync: number;
  /** Offers whose key matched more than one eligible variant. */
  ambiguous: number;
  /** Quantity commands submitted. */
  commands: number;
  /**
   * True only when every eligible offer was accounted for and confirmed. Any
   * skip, any pending command, any failure leaves it false - a "complete" run is
   * the assertion that Allegro now matches Medusa, and nothing weaker earns it.
   */
  complete: boolean;
  /** Offers considered writable (ACTIVE, unambiguously matched). */
  eligible: number;
  error?: string;
  failed: number;
  /** Offers whose quantity differed and so were planned for a write. */
  mismatched: number;
  /** Commands submitted but not confirmed terminal within the poll budget. */
  pending: number;
  skippedInactive: number;
  /**
   * Authorised offers whose variant has no quantity to publish at all (it does not manage
   * inventory). A permanent, bounded exclusion rather than an unknown.
   */
  skippedNoInventory: number;
  /**
   * Authorised offers that could not be paired: absent from the live listing, or their
   * row's SKU matches no eligible variant. Counted so they are not invisible - an offer in
   * this bucket has its quantity published nowhere.
   */
  skippedUnmatched: number;
  /** Eligible VARIANTS that no authorised offer claimed, so their quantity is unpublished. */
  skippedUnlinked: number;
  /** Authorised offers whose live listing contradicts their mapping row. */
  conflicted: number;
  /** Offers Allegro confirmed at the new quantity. */
  synced: number;
  unresolved: number;
}

export interface StockSyncPlan extends StockSyncSummary {
  changes: StockChange[];
  /** Mapping rows to mark as conflicted, so every write path holds them out. */
  conflicts: StockConflictRecord[];
}

/** Allegro accepts at most 1,000 offers in one quantity command. */
export const STOCK_COMMAND_SIZE = 1000;
/** Concurrent command polls. Four keeps the run brisk without a rate-limit storm. */
export const STOCK_POLL_CONCURRENCY = 4;
/** Tasks per page when reading one command's task report. */
export const STOCK_TASK_PAGE_SIZE = 1000;
/**
 * Task pages per command before the read is declared truncated.
 *
 * A 1,000-offer command emits at least 1,000 tasks and can emit more, because
 * Allegro reports tasks for fields other than `quantity` (which is why the task
 * `field` discriminator exists). Ten pages is far more headroom than any single
 * command should need; hitting it means the assumption is wrong, so it is reported
 * rather than silently absorbed - and the offers that went unread are counted as
 * pending, never as failed.
 */
export const STOCK_TASK_MAX_PAGES = 10;

/**
 * Decide what to write, from the authorised pairs, verified against the live listing.
 *
 * `authorized` drives the loop: those are the offers the mapping table permits a write to,
 * each already paired with the variant its row records. The live `offers` supply the
 * observed quantity and status, and are used to CHECK that the row still agrees with
 * Allegro - never to re-derive the pairing.
 *
 * Verification, in order of what Allegro gives us:
 *
 * - Sygnatura present and different from the row's SKU: the seller renamed it between
 *   discovery and now. A conflict. Re-pairing on the live value is what pushed SKU-B's
 *   quantity onto product A's listing.
 * - No sygnatura but an EAN: checked against the variant's barcode, the same key discovery
 *   matched on. Note this is a genuine EAN-to-BARCODE comparison; the old code looked an
 *   offer's EAN up in the SKU map, so an EAN-linked offer matched nothing, fell through
 *   uncounted, and had its quantity published nowhere while the run reported success.
 * - Neither: the offer carries no key at all, so nothing can corroborate the row. Also a
 *   conflict, because a blanked sygnatura is the same seller edit as a renamed one.
 */
export const planStockSync = (
  variants: readonly VariantStock[],
  offers: readonly AllegroOffer[],
  authorized: readonly AuthorizedOffer[],
): StockSyncPlan => {
  const variantsBySku = new Map<string, VariantStock[]>();
  for (const variant of variants) {
    const group = variantsBySku.get(variant.sku) ?? [];
    group.push(variant);
    variantsBySku.set(variant.sku, group);
  }
  const offersById = new Map(offers.map((offer) => [offer.id, offer]));

  const changes: StockChange[] = [];
  const conflicts: StockConflictRecord[] = [];
  let alreadyInSync = 0;
  let ambiguous = 0;
  let conflicted = 0;
  let eligible = 0;
  let skippedInactive = 0;
  let skippedNoInventory = 0;
  let skippedUnmatched = 0;
  let unresolved = 0;
  const claimedSkus = new Set<string>();

  for (const row of authorized) {
    const offer = offersById.get(row.offerId);
    if (!offer) {
      // Authorised but absent from this listing: nothing to compare against and nothing to
      // write to. Counted rather than skipped silently - its quantity is published nowhere.
      skippedUnmatched += 1;
      continue;
    }

    const matches = variantsBySku.get(row.sku) ?? [];
    if (matches.length === 0) {
      skippedUnmatched += 1;
      continue;
    }
    for (const match of matches) {
      claimedSkus.add(match.sku);
    }
    if (matches.length !== 1) {
      ambiguous += 1;
      continue;
    }
    const variant = matches[0] as VariantStock;

    const sygnatura = offer.external?.id?.trim();
    const offerEan = offer.ean?.trim();
    const variantEan = variant.ean?.trim();
    if (sygnatura && sygnatura !== row.sku) {
      conflicted += 1;
      conflicts.push({
        conflict: "sku-mismatch",
        conflict_detail: `Offer ${offer.id} is mapped to SKU "${row.sku}" but now carries sygnatura "${sygnatura}" on Allegro. Nothing was written: the two disagree, so which variant's quantity belongs on this offer is not a decision this plugin may take. Fix the sygnatura on Allegro, or let discovery re-map it.`,
        offerId: offer.id,
        sku: row.sku,
      });
      continue;
    }
    if (!sygnatura) {
      const eanAgrees = Boolean(offerEan && variantEan && offerEan === variantEan);
      if (!eanAgrees) {
        conflicted += 1;
        conflicts.push({
          conflict: "sku-mismatch",
          conflict_detail: offerEan
            ? `Offer ${offer.id} carries no sygnatura and its EAN "${offerEan}" does not match the barcode of the variant mapped to SKU "${row.sku}"${variantEan ? ` ("${variantEan}")` : " (which has none)"}. Nothing was written.`
            : `Offer ${offer.id} carries neither a sygnatura nor an EAN, so nothing on Allegro corroborates its mapping to SKU "${row.sku}". Nothing was written. Set the sygnatura to "${row.sku}" on Allegro to restore it.`,
          offerId: offer.id,
          sku: row.sku,
        });
        continue;
      }
    }

    if (offer.publication?.status !== "ACTIVE") {
      skippedInactive += 1;
      continue;
    }
    if (variant.absent === "no-inventory") {
      // A permanent, bounded exclusion: this variant has no quantity to publish, and 0
      // would delist the offer. It must NOT refuse the rest of the plan - doing so meant a
      // single digital product with an Allegro offer wedged stock sync catalogue-wide.
      skippedNoInventory += 1;
      continue;
    }
    eligible += 1;
    const observed = offer.stock?.available;
    if (!Number.isInteger(observed)) {
      unresolved += 1;
      continue;
    }
    const desired = variant.quantity;
    if (desired === undefined || !Number.isInteger(desired) || desired < 0) {
      unresolved += 1;
      continue;
    }
    if (observed === desired) {
      alreadyInSync += 1;
    } else {
      changes.push({ desired, offerId: offer.id });
    }
  }

  let skippedUnlinked = 0;
  for (const sku of variantsBySku.keys()) {
    if (!claimedSkus.has(sku)) {
      skippedUnlinked += 1;
    }
  }

  return {
    alreadyInSync,
    ambiguous,
    changes,
    commands: 0,
    complete: false,
    conflicted,
    conflicts,
    eligible,
    failed: 0,
    mismatched: changes.length,
    pending: 0,
    skippedInactive,
    skippedNoInventory,
    skippedUnlinked,
    skippedUnmatched,
    synced: 0,
    unresolved,
  };
};

/**
 * Group changes into commands: one command per target quantity, chunked to
 * Allegro's 1,000-offer limit.
 *
 * Grouping by quantity is forced by the API - the command sets ONE fixed value
 * across every offer it names - and it is also what makes a full catalogue
 * reconciliation cheap, because most offers share a handful of quantities.
 */
export const buildStockCommandChunks = (
  changes: readonly StockChange[],
  commandSize: number = STOCK_COMMAND_SIZE,
): StockChange[][] => {
  if (!Number.isInteger(commandSize) || commandSize < 1) {
    // A non-positive stride makes the slicing loop below never advance, so this
    // would hang the run rather than fail it. Refused loudly instead: the only way
    // to get here is a caller passing a computed size, and a hung stock loop is the
    // hardest failure of the lot to diagnose.
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `buildStockCommandChunks: commandSize must be a positive integer, received ${commandSize}.`,
    );
  }
  const byQuantity = new Map<number, StockChange[]>();
  for (const change of changes) {
    const group = byQuantity.get(change.desired) ?? [];
    group.push(change);
    byQuantity.set(change.desired, group);
  }
  const chunks: StockChange[][] = [];
  for (const group of byQuantity.values()) {
    for (let index = 0; index < group.length; index += commandSize) {
      chunks.push(group.slice(index, index + commandSize));
    }
  }
  return chunks;
};

/**
 * Whether a plan is safe to execute at all.
 *
 * Refusal is reserved for UNKNOWNS, which is the distinction that matters. An ambiguous
 * match or a quantity that could not be READ means the plan does not know the whole truth
 * and cannot bound what it is missing, and a partial push in that state publishes a fresh
 * figure for some offers while leaving others stale with no record of which is which.
 *
 * A KNOWN, bounded exclusion is different and does not refuse anything: an inactive offer,
 * a variant that structurally has no inventory, an offer that contradicts its row, an
 * unmatched pair. Each is counted, each is reported, and each leaves exactly one offer
 * alone. Treating "this variant has no inventory to publish" as an unknown is what let one
 * digital product with an Allegro offer refuse the entire catalogue's stock sync forever.
 */
export const isStockPlanSafe = (plan: StockSyncPlan): boolean =>
  plan.ambiguous === 0 && plan.unresolved === 0;

/**
 * True when every authorised offer AND every eligible variant was accounted for, so
 * nothing is left stale anywhere.
 *
 * Strictly stronger than plan safety: a safe plan can still leave offers untouched. Every
 * bucket that means "this offer's quantity was not written" has to be empty, including the
 * bounded ones, because `complete` is the assertion that Allegro now matches Medusa.
 */
export const isStockCoverageComplete = (plan: StockSyncPlan): boolean =>
  plan.ambiguous === 0 &&
  plan.unresolved === 0 &&
  plan.skippedInactive === 0 &&
  plan.skippedNoInventory === 0 &&
  plan.skippedUnmatched === 0 &&
  plan.conflicted === 0 &&
  plan.skippedUnlinked === 0;
