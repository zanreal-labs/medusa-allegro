/**
 * Promotion-level eligibility, kept pure and separate from the per-offer preview.
 *
 * These mirror decisions the native Medusa promotion module makes at cart time, so
 * the Allegro overlay agrees with the storefront about which promotions are live
 * and where. They are pinned by unit tests precisely because they DUPLICATE core
 * behaviour: if a future Medusa version changes the active-window predicate, the
 * test is where that divergence has to be noticed rather than in a silent
 * mispricing.
 */

/** The campaign window fields, as read off the native promotion's campaign. */
export interface CampaignWindow {
  starts_at?: string | Date | null;
  ends_at?: string | Date | null;
}

/**
 * Whether a promotion is active NOW, matching `PromotionModuleService`'s
 * `listActivePromotions_`: status must be `active`, and if there is a campaign its
 * window must be open - `starts_at <= now` (inclusive, null = unbounded past) and
 * `ends_at > now` (exclusive, null = unbounded future). A promotion with no
 * campaign is windowless and active whenever its status is.
 *
 * The bound directions are load-bearing and copied verbatim from core: `ends_at`
 * is EXCLUSIVE, so a promotion is already inactive at the instant it ends, and an
 * Allegro offer left on a promotional rule at that instant is drift the monitor
 * must catch.
 */
export const isPromotionActive = (
  status: string | null | undefined,
  campaign: CampaignWindow | null | undefined,
  now: Date = new Date(),
): boolean => {
  if (status !== "active") {
    return false;
  }
  if (!campaign) {
    return true;
  }
  const startsAt = toDate(campaign.starts_at);
  const endsAt = toDate(campaign.ends_at);
  if (startsAt && startsAt.getTime() > now.getTime()) {
    return false;
  }
  if (endsAt && endsAt.getTime() <= now.getTime()) {
    return false;
  }
  return true;
};

const toDate = (value?: string | Date | null): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** One promotion rule, as read off `application_method.target_rules` or `rules`. */
export interface PromotionRuleView {
  attribute?: string | null;
  operator?: string | null;
  values?: { value?: string | null }[] | null;
}

/**
 * The sales-channel ids a promotion is scoped to, read from its native
 * `sales_channel_id` rules - the single source of truth. An empty result means the
 * promotion carries no channel scope at all, which in Medusa means "every channel".
 *
 * The overlay stores this NOWHERE: duplicating the channel set into the opt-in row
 * is exactly what would let the Allegro scope and the storefront scope drift, so it
 * is always read back from the promotion.
 */
export const channelScopeFromRules = (rules: readonly PromotionRuleView[]): Set<string> => {
  const channels = new Set<string>();
  for (const rule of rules) {
    if (rule.attribute?.trim() !== "sales_channel_id") {
      continue;
    }
    for (const entry of rule.values ?? []) {
      const id = entry.value?.trim();
      if (id) {
        channels.add(id);
      }
    }
  }
  return channels;
};

/**
 * Whether the Allegro sales channel is in a promotion's scope.
 *
 * A promotion with NO channel scope applies everywhere, Allegro included, so an
 * empty scope is a match. A non-empty scope matches only when it explicitly
 * contains the Allegro channel id - the overlay must not act on a promotion the
 * operator scoped to the web store alone.
 */
export const includesAllegroChannel = (
  scope: ReadonlySet<string>,
  allegroChannelId: string | undefined,
): boolean => {
  if (scope.size === 0) {
    return true;
  }
  if (!allegroChannelId) {
    // The promotion is channel-scoped but we do not know which channel is Allegro's,
    // so we cannot prove Allegro is in scope. Fail closed.
    return false;
  }
  return scope.has(allegroChannelId);
};

/**
 * The product ids a promotion targets, read from `items.product.id` /
 * `items.product_id` target rules. Variant-level targets (`items.variant.id`) are
 * returned separately because they resolve to a SKU by a different path.
 */
export interface TargetSelection {
  productIds: Set<string>;
  variantIds: Set<string>;
}

export const targetSelectionFromRules = (
  rules: readonly PromotionRuleView[],
): TargetSelection => {
  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  for (const rule of rules) {
    const attribute = rule.attribute?.trim();
    const values = (rule.values ?? [])
      .map((entry) => entry.value?.trim())
      .filter((value): value is string => Boolean(value));
    if (attribute === "items.product.id" || attribute === "items.product_id") {
      for (const value of values) {
        productIds.add(value);
      }
    } else if (attribute === "items.variant.id" || attribute === "items.variant_id") {
      for (const value of values) {
        variantIds.add(value);
      }
    }
  }
  return { productIds, variantIds };
};
