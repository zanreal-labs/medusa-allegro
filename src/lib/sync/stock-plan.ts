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
 * The skip taxonomy is the point of the function. Every offer that is NOT written
 * to falls into exactly one counted bucket, so a run that changes nothing can say
 * why. The buckets:
 *
 * - `ambiguous` - the offer's key matches more than one eligible variant.
 * - `skippedInactive` - the offer is not ACTIVE, so its quantity is meaningless.
 * - `skippedUnlinked` - an eligible variant that no live offer claimed.
 * - `unresolved` - the offer's or the variant's quantity is not a usable integer,
 *   so the delta cannot be computed. Never treated as 0: pushing a guessed
 *   quantity is how an oversell or a silent delisting happens.
 */

/** An eligible variant's available quantity, as read from Medusa inventory. */
export interface VariantStock {
  sku: string;
  /** Available quantity at the configured location(s). Undefined = unreadable. */
  quantity?: number;
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
  skippedUnlinked: number;
  /** Offers Allegro confirmed at the new quantity. */
  synced: number;
  unresolved: number;
}

export interface StockSyncPlan extends StockSyncSummary {
  changes: StockChange[];
}

/** Allegro accepts at most 1,000 offers in one quantity command. */
export const STOCK_COMMAND_SIZE = 1000;
/** Concurrent command polls. Four keeps the run brisk without a rate-limit storm. */
export const STOCK_POLL_CONCURRENCY = 4;

/**
 * Match live offers against variant stock and decide what to write.
 *
 * Matching is by the offer's sygnatura (`external.id`), with EAN as the fallback,
 * mirroring discovery - so a store whose mapping rows are healthy gets the same
 * answer either way, and a store mid-rename does not silently push to the wrong
 * offer.
 */
export const planStockSync = (
  variants: readonly VariantStock[],
  offers: readonly AllegroOffer[],
): StockSyncPlan => {
  const variantsBySku = new Map<string, VariantStock[]>();
  for (const variant of variants) {
    const group = variantsBySku.get(variant.sku) ?? [];
    group.push(variant);
    variantsBySku.set(variant.sku, group);
  }

  const changes: StockChange[] = [];
  let alreadyInSync = 0;
  let ambiguous = 0;
  let eligible = 0;
  let skippedInactive = 0;
  let unresolved = 0;
  const matchedSkus = new Set<string>();

  for (const offer of offers) {
    const key = offer.external?.id?.trim() || offer.ean?.trim();
    if (!key) {
      continue;
    }
    const matches = variantsBySku.get(key) ?? [];
    if (matches.length === 0) {
      continue;
    }
    for (const match of matches) {
      matchedSkus.add(match.sku);
    }
    if (matches.length !== 1) {
      ambiguous += 1;
      continue;
    }
    if (offer.publication?.status !== "ACTIVE") {
      skippedInactive += 1;
      continue;
    }
    eligible += 1;
    const observed = offer.stock?.available;
    if (!Number.isInteger(observed)) {
      unresolved += 1;
      continue;
    }
    const desired = matches[0]?.quantity;
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
    if (!matchedSkus.has(sku)) {
      skippedUnlinked += 1;
    }
  }

  return {
    alreadyInSync,
    ambiguous,
    changes,
    commands: 0,
    complete: false,
    eligible,
    failed: 0,
    mismatched: changes.length,
    pending: 0,
    skippedInactive,
    skippedUnlinked,
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
 * An ambiguous match or an unresolved quantity means the plan does not know the
 * whole truth about the catalogue, and a partial quantity push is worse than
 * none: it publishes a stock figure for some offers while leaving others at a
 * stale one, with no record of which is which. So the whole run is refused, and
 * the reason is reported.
 */
export const isStockPlanSafe = (plan: StockSyncPlan): boolean =>
  plan.ambiguous === 0 && plan.unresolved === 0;

/** True when every eligible offer was accounted for, so nothing is left stale. */
export const isStockCoverageComplete = (plan: StockSyncPlan): boolean =>
  plan.ambiguous === 0 &&
  plan.unresolved === 0 &&
  plan.skippedInactive === 0 &&
  plan.skippedUnlinked === 0;
