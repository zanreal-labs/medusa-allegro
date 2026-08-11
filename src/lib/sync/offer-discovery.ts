import type { AllegroOffer } from "../allegro/types";

/**
 * Pure planner for offer discovery: what the stored mapping should look like,
 * given a live offer listing and the Medusa variants that are sync-eligible.
 *
 * Everything about deciding is here; the engine that fetches and writes is in
 * `src/workflows/discover-allegro-offers.ts`. Splitting it that way is what makes
 * the two rules that matter testable without any I/O:
 *
 * - **The empty-response guard.** An unlink pass driven by "this offer was not in
 *   the response" is only sound when the response is trustworthy. A transient
 *   Allegro failure that yields zero offers would otherwise clear every mapping
 *   the store has, and the next run would have nothing left to re-link by. So a
 *   non-empty listing is a precondition of unlinking, not an optimisation.
 * - **Conflicts are recorded, never resolved.** A duplicate sygnatura, an offer
 *   with no sygnatura at all, and a sygnatura matching no variant are three
 *   different operator problems. Picking a winner would push a price or a quantity
 *   to the wrong offer, which is a real mispricing or a real oversell.
 */

/** Conflict codes, mirroring `allegro_offer.conflict`. */
export type OfferConflict = "missing-external-id" | "duplicate-sku" | "no-variant" | "no-offer";

/** A sync-eligible Medusa variant, reduced to what matching needs. */
export interface EligibleVariant {
  id: string;
  sku: string;
  /** Barcode/EAN, used only when an offer carries no sygnatura. */
  ean?: string;
}

/** A stored mapping row, reduced to what the planner compares against. */
export interface StoredOffer {
  id: string;
  sku: string;
  offer_id?: string | null;
}

/** What one live offer should write onto its mapping row. */
export interface OfferUpsert {
  sku: string;
  offer_id: string;
  name: string | null;
  status: string | null;
  category_id: string | null;
  ean: string | null;
  price_amount: string | null;
  price_currency: string | null;
  available_quantity: number | null;
  variant_id: string | null;
  conflict: null;
  conflict_detail: null;
}

/** A mapping row that needs a conflict recorded rather than a value written. */
export interface OfferConflictRecord {
  sku: string;
  conflict: OfferConflict;
  conflict_detail: string;
  /** Set for a conflict discovered on a live offer; absent for a stored-row conflict. */
  offer_id?: string | null;
}

export interface DiscoveryPlan {
  /** Healthy live offers, ready to be written onto their mapping row. */
  upserts: OfferUpsert[];
  /** Conflicts to record, keyed by the SKU whose row carries them. */
  conflicts: OfferConflictRecord[];
  /**
   * SKUs whose stored `offer_id` no longer resolves to them, so the link must be
   * cleared. Empty whenever the listing was empty - see the module comment.
   */
  unlink: string[];
  /** Distinct Allegro category ids seen across the listing, for rate discovery. */
  categoryIds: string[];
  /** Live offers carrying no usable sygnatura or EAN at all. */
  skippedNoSku: number;
  /** Live offers whose sygnatura matched a variant. */
  matched: number;
  /** Eligible variants that no live offer claimed. */
  unmatchedVariants: number;
}

/**
 * The mapping key an offer presents.
 *
 * `external.id` is the sygnatura and the contract; EAN is a fallback for a seller
 * who has not filled the sygnatura in yet, and it is matched against a variant's
 * barcode rather than assumed to BE a SKU. `matchedBy` is carried so a conflict
 * message can say which of the two produced it.
 */
const offerKey = (offer: AllegroOffer): { key: string; matchedBy: "sygnatura" | "ean" } | null => {
  const external = offer.external?.id?.trim();
  if (external) {
    return { key: external, matchedBy: "sygnatura" };
  }
  const ean = offer.ean?.trim();
  if (ean) {
    return { key: ean, matchedBy: "ean" };
  }
  return null;
};

/**
 * Plan the mapping writes for one discovery run.
 *
 * `listingComplete` is the caller's assertion that the listing is a full,
 * verified snapshot (every page accounted for against Allegro's `totalCount`).
 * It gates the unlink pass on its own, in addition to the emptiness check, so an
 * incomplete-but-non-empty snapshot cannot unlink either.
 */
export const planOfferDiscovery = (input: {
  offers: readonly AllegroOffer[];
  variants: readonly EligibleVariant[];
  stored: readonly StoredOffer[];
  listingComplete: boolean;
}): DiscoveryPlan => {
  const { listingComplete, offers, stored, variants } = input;

  const variantsBySku = new Map<string, EligibleVariant[]>();
  const variantsByEan = new Map<string, EligibleVariant[]>();
  for (const variant of variants) {
    const bySku = variantsBySku.get(variant.sku) ?? [];
    bySku.push(variant);
    variantsBySku.set(variant.sku, bySku);
    const ean = variant.ean?.trim();
    if (ean) {
      const byEan = variantsByEan.get(ean) ?? [];
      byEan.push(variant);
      variantsByEan.set(ean, byEan);
    }
  }

  // First pass: group live offers by the key they present, so a duplicate
  // sygnatura is seen as a duplicate rather than as two independent upserts
  // racing to own one row.
  const offersByKey = new Map<string, { offer: AllegroOffer; matchedBy: "sygnatura" | "ean" }[]>();
  let skippedNoSku = 0;
  const noKeyOffers: AllegroOffer[] = [];
  for (const offer of offers) {
    const resolved = offerKey(offer);
    if (!resolved) {
      skippedNoSku += 1;
      noKeyOffers.push(offer);
      continue;
    }
    const group = offersByKey.get(resolved.key) ?? [];
    group.push({ matchedBy: resolved.matchedBy, offer });
    offersByKey.set(resolved.key, group);
  }

  const upserts: OfferUpsert[] = [];
  const conflicts: OfferConflictRecord[] = [];
  const categoryIds = new Set<string>();
  /** Resolved SKU -> the offer id that legitimately owns it this run. */
  const ownedBy = new Map<string, string>();
  const matchedVariantSkus = new Set<string>();
  /** Every group that resolved to a variant, before collisions across groups are judged. */
  const resolved: { offer: AllegroOffer; variant: EligibleVariant }[] = [];
  let matched = 0;

  for (const [key, group] of offersByKey) {
    for (const entry of group) {
      const category = entry.offer.category?.id;
      if (category) {
        categoryIds.add(category);
      }
    }

    if (group.length > 1) {
      // Nothing is written for a contested key, and the mapping row is marked so
      // the admin shows it. Both offers are named: resolving this means deciding
      // which one keeps the sygnatura, and that needs the ids.
      conflicts.push({
        conflict: "duplicate-sku",
        conflict_detail: `${group.length} live offers claim this sygnatura: ${group
          .map((entry) => entry.offer.id)
          .join(", ")}. Nothing is synced until exactly one offer carries it.`,
        sku: key,
      });
      continue;
    }

    const entry = group[0];
    if (!entry) {
      continue;
    }
    const { matchedBy, offer } = entry;
    const candidates =
      matchedBy === "sygnatura" ? (variantsBySku.get(key) ?? []) : (variantsByEan.get(key) ?? []);

    if (candidates.length === 0) {
      conflicts.push({
        conflict: "no-variant",
        conflict_detail:
          matchedBy === "sygnatura"
            ? `Offer ${offer.id} carries sygnatura "${key}", which matches no variant in the Allegro sales channel. Either the sygnatura is wrong on Allegro, or the product is not published to the channel.`
            : `Offer ${offer.id} carries no sygnatura; its EAN "${key}" matches no variant barcode in the Allegro sales channel.`,
        offer_id: offer.id,
        sku: key,
      });
      continue;
    }

    // Two variants sharing a SKU is a Medusa-side data problem, and it is the
    // same class of ambiguity as two offers sharing a sygnatura: writing a
    // quantity for the wrong one oversells. Reported against the same code, since
    // the operator's question ("which of these owns the SKU?") is identical.
    if (candidates.length > 1) {
      conflicts.push({
        conflict: "duplicate-sku",
        conflict_detail: `${candidates.length} Medusa variants share this ${
          matchedBy === "sygnatura" ? "SKU" : "barcode"
        }: ${candidates.map((variant) => variant.id).join(", ")}.`,
        offer_id: offer.id,
        sku: key,
      });
      continue;
    }

    const variant = candidates[0] as EligibleVariant;
    matchedVariantSkus.add(variant.sku);
    // Collected, NOT written yet. Two offers can reach the same variant through
    // DIFFERENT keys - offer A by sygnatura "S1", offer B by an EAN whose barcode belongs
    // to the same variant - so they land in different groups and the per-group duplicate
    // check cannot see each other. Writing here let both claim SKU row S1 with no conflict
    // recorded at all: last write wins, so a price or a quantity went to whichever offer
    // happened to be written second. The collision is only visible once every group has
    // been resolved to a variant, which is what the pass below does.
    resolved.push({ offer, variant });
  }

  /** Resolved variant SKU -> every offer that reached it, by any key. */
  const claimantsBySku = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    const group = claimantsBySku.get(entry.variant.sku) ?? [];
    group.push(entry);
    claimantsBySku.set(entry.variant.sku, group);
  }

  for (const [sku, claimants] of claimantsBySku) {
    if (claimants.length > 1) {
      // The same class of ambiguity as two offers sharing a sygnatura, and reported under
      // the same code, because the operator's question is identical: which of these offers
      // owns the SKU? Naming the ids is the actionable part.
      conflicts.push({
        conflict: "duplicate-sku",
        conflict_detail: `${claimants.length} live offers resolve to this SKU by different keys (sygnatura or EAN): ${claimants
          .map((entry) => entry.offer.id)
          .join(", ")}. Nothing is synced until exactly one offer maps to it.`,
        sku,
      });
      continue;
    }
    const entry = claimants[0];
    if (!entry) {
      continue;
    }
    const { offer, variant } = entry;
    ownedBy.set(variant.sku, offer.id);
    matched += 1;
    upserts.push({
      available_quantity: Number.isInteger(offer.stock?.available)
        ? (offer.stock?.available as number)
        : null,
      category_id: offer.category?.id ?? null,
      conflict: null,
      conflict_detail: null,
      ean: offer.ean ?? null,
      name: offer.name ?? null,
      offer_id: offer.id,
      // The row is keyed by the VARIANT's SKU, not by the key that matched. For
      // an EAN match those differ, and keying on the EAN would create a second
      // row for a SKU that already has one.
      price_amount: offer.sellingMode?.price?.amount ?? null,
      price_currency: offer.sellingMode?.price?.currency ?? null,
      sku: variant.sku,
      status: offer.publication?.status ?? null,
      variant_id: variant.id,
    });
  }

  // An offer with no key at all cannot be recorded against a SKU, because it has
  // none. It is counted, and named once in a conflict row only when a stored
  // mapping already points at it - which is the case where an operator can act.
  const noKeyOfferIds = new Set(noKeyOffers.map((offer) => offer.id));

  // A SKU the offers pass already ruled on. The unlink pass must not add a second
  // conflict for it: a contested SKU would otherwise be recorded as `duplicate-sku`
  // and then immediately overwritten with `no-offer`, which is both wrong (the
  // offers are right there in the listing) and strictly less actionable, since the
  // competing offer ids are what an operator needs.
  const alreadyConflicted = new Set(conflicts.map((conflict) => conflict.sku));

  const unlink: string[] = [];
  if (listingComplete && offers.length > 0) {
    for (const row of stored) {
      const linked = row.offer_id?.trim();
      if (!linked) {
        continue;
      }
      if (ownedBy.get(row.sku) === linked) {
        continue;
      }
      // Either the offer has gone from the listing, or it now resolves to a
      // different SKU (a sygnatura rename), or the SKU has become contested. All
      // three leave the stored link misattributed, and a misattributed link is what
      // makes a quantity push land on someone else's offer.
      unlink.push(row.sku);
      if (alreadyConflicted.has(row.sku)) {
        continue;
      }
      if (noKeyOfferIds.has(linked)) {
        conflicts.push({
          conflict: "missing-external-id",
          conflict_detail: `Offer ${linked} no longer carries a sygnatura, so it can no longer be mapped by SKU. Set the sygnatura to "${row.sku}" on Allegro to restore the link.`,
          offer_id: linked,
          sku: row.sku,
        });
      } else if (!ownedBy.has(row.sku)) {
        conflicts.push({
          conflict: "no-offer",
          conflict_detail: `Stored offer ${linked} is absent from the current Allegro listing, or now carries a different sygnatura. The link was cleared.`,
          sku: row.sku,
        });
      }
    }
  }

  // CONFLICT WINS. A SKU can reach both lists by different routes - the offers pass writes
  // an upsert for it, and the unlink pass then records a `no-offer` conflict for a stored
  // row that pointed at a now-renamed offer with the same SKU. Emitting both left the
  // outcome to whichever write the applier happened to queue second: a healthy `offer_id`
  // could land on a row simultaneously declared conflicted, which is precisely the state
  // every write path treats as safe to push to. Withholding the upsert is the safe
  // direction - the next run re-establishes it once the conflict is genuinely gone.
  const conflictedSkus = new Set(conflicts.map((conflict) => conflict.sku));
  const safeUpserts = upserts.filter((upsert) => !conflictedSkus.has(upsert.sku));

  return {
    categoryIds: [...categoryIds],
    conflicts,
    // Only the upserts that survived. A withheld one is not a match this run.
    matched: matched - (upserts.length - safeUpserts.length),
    skippedNoSku,
    unlink,
    unmatchedVariants: variants.filter((variant) => !matchedVariantSkus.has(variant.sku)).length,
    upserts: safeUpserts,
  };
};
