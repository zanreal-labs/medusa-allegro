import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  channelScopeFromRules,
  includesAllegroChannel,
  isPromotionActive,
  targetSelectionFromRules,
} from "../../lib/promotions/eligibility";
import type { PromotionRuleView } from "../../lib/promotions/eligibility";
import {
  asDiscountBase,
  computeOverridePrice,
  PROMOTION_BLOCK_LABEL,
  promotionalRuleName,
  resolveDiscount,
} from "../../lib/promotions/preview";
import type {
  DiscountBase,
  PromotionBlockReason,
  PromotionMethod,
  ResolvedDiscount,
} from "../../lib/promotions/preview";
import { parseAmount } from "../../lib/sync/money";
import { evaluateSyncEligibility } from "../../lib/sync/price-automation";
import type { AutomationRuleNames, SyncSkipReason } from "../../lib/sync/price-automation";
import { ALLEGRO_MODULE } from "../../modules/allegro";
import type AllegroModuleService from "../../modules/allegro/service";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type { CatalogVariant } from "./catalog";
import {
  buildBreakEvenResolver,
  buildCategoryRates,
  buildSrpBySku,
  resolveCommissionFraction,
  resolveCostsService,
  resolveSrp,
} from "./pricing";

/**
 * The read-only resolver behind the promotion preview.
 *
 * It reads native Medusa promotions, resolves each one's targeted SKUs to their
 * Allegro offers, reuses the sync loop's own break-even and SRP machinery, and
 * reports - for every covered SKU - what BOTH mechanisms would do, so the operator
 * can see the effect of each `discount_base` before choosing one. It writes
 * NOTHING, to Allegro or to Medusa: no opt-in row is read or created, no rule is
 * touched, no price is set. That is what lets the preview be deployed and opened
 * cold, with only admin auth in front of it.
 *
 * The channel set, the product targets, the discount and the window all come from
 * the native promotion - the single source of truth the storefront also honours.
 */

/** The costs plugin, duck-typed on the two calls this resolver makes. */
interface CostsEconomics {
  getCostsBySkus: (skus: string[]) => Promise<{ sku: string; unit_cost_net: number }[]>;
  computeEconomics: (input: {
    netCost?: number;
    commissionRate?: number;
    sellingPrice?: number;
  }) => Promise<{
    netIncome?: number;
    marginPct?: number;
    breakEvenPrice?: number;
    grossCost?: number;
  }>;
}

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: { skip: number; take: number };
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

interface RawPromotion {
  id: string;
  code?: string | null;
  status?: string | null;
  is_automatic?: boolean | null;
  application_method?: {
    type?: string | null;
    value?: number | string | null;
    currency_code?: string | null;
    target_type?: string | null;
    allocation?: string | null;
    max_quantity?: number | null;
    target_rules?: PromotionRuleView[] | null;
  } | null;
  rules?: PromotionRuleView[] | null;
  campaign?: { starts_at?: string | null; ends_at?: string | null } | null;
  allegro_promotion_config?: { id?: string; discount_base?: string | null; enabled?: boolean | null } | null;
}

const PROMOTION_FIELDS = [
  "id",
  "code",
  "status",
  "is_automatic",
  "application_method.type",
  "application_method.value",
  "application_method.currency_code",
  "application_method.target_type",
  "application_method.allocation",
  "application_method.max_quantity",
  "application_method.target_rules.attribute",
  "application_method.target_rules.operator",
  "application_method.target_rules.values.value",
  "rules.attribute",
  "rules.values.value",
  "campaign.starts_at",
  "campaign.ends_at",
  "allegro_promotion_config.id",
  "allegro_promotion_config.discount_base",
  "allegro_promotion_config.enabled",
];

/** A promotion as the list view needs it: identity, method summary, and readiness. */
export interface PromotionSummary {
  id: string;
  code: string | null;
  automatic: boolean;
  active: boolean;
  window: { startsAt: string | null; endsAt: string | null } | null;
  discountLabel: string;
  /** True when the promotion is scoped to a channel set that includes Allegro (or is unscoped). */
  includesAllegro: boolean;
  /** Why the promotion cannot drive Allegro at all, if it cannot. */
  blockReasons: { reason: PromotionBlockReason; label: string }[];
  targetProductCount: number;
}

const toMethod = (raw: RawPromotion): PromotionMethod => ({
  allocation: raw.application_method?.allocation,
  currency_code: raw.application_method?.currency_code,
  max_quantity: raw.application_method?.max_quantity ?? null,
  target_type: raw.application_method?.target_type,
  type: raw.application_method?.type,
  value: parseAmount(raw.application_method?.value ?? null) ?? null,
});

/**
 * The promotion-level reasons a promotion cannot drive Allegro, in a stable order.
 *
 * These are reported together rather than short-circuited so the operator sees
 * every blocker at once - a code-based promotion scoped to the web store with an
 * order-level discount should show all three, not just the first, or fixing one
 * looks like it should work when two remain.
 */
const promotionBlockReasons = (
  raw: RawPromotion,
  discount: ResolvedDiscount,
  includesAllegro: boolean,
  targetCount: number,
): PromotionBlockReason[] => {
  const reasons: PromotionBlockReason[] = [];
  if (!raw.is_automatic) {
    reasons.push("not-automatic");
  }
  if (!includesAllegro) {
    reasons.push("allegro-channel-excluded");
  }
  if (discount.kind === "unsupported") {
    reasons.push("discount-unsupported");
  }
  if (targetCount === 0) {
    reasons.push("no-target-products");
  }
  return reasons;
};

const summarise = (raw: RawPromotion, allegroChannelId: string | undefined): PromotionSummary => {
  const discount = resolveDiscount(toMethod(raw));
  const scope = channelScopeFromRules(raw.rules ?? []);
  const includesAllegro = includesAllegroChannel(scope, allegroChannelId);
  const selection = targetSelectionFromRules(raw.application_method?.target_rules ?? []);
  const targetCount = selection.productIds.size + selection.variantIds.size;
  const reasons = promotionBlockReasons(raw, discount, includesAllegro, targetCount);
  return {
    active: isPromotionActive(raw.status, raw.campaign),
    automatic: Boolean(raw.is_automatic),
    blockReasons: reasons.map((reason) => ({ label: PROMOTION_BLOCK_LABEL[reason], reason })),
    code: raw.code ?? null,
    discountLabel: discount.kind === "unsupported" ? discount.reason : discount.label,
    id: raw.id,
    includesAllegro,
    targetProductCount: targetCount,
    window: raw.campaign
      ? { endsAt: raw.campaign.ends_at ?? null, startsAt: raw.campaign.starts_at ?? null }
      : null,
  };
};

/** What each mechanism would do for one covered SKU. */
export interface OfferPreview {
  sku: string;
  offerId: string | null;
  promoted: boolean | null;
  currency: string;
  breakEven: number;
  breakEvenRaw: number;
  srp: number;
  /** Rule switch outcome (competitor base), or a skip reason. */
  ruleSwitch:
    | { fromRule: string; toRule: string; competitorRelativeCaveat: true }
    | { skipped: SyncSkipReason | "rule-name-too-long" };
  /** Override outcome (SRP base): the clamped Buy Now price and its revert rule. */
  override: { price: number; clampedToFloor: boolean; revertRule: string } | { skipped: SyncSkipReason };
  /**
   * The price the auction is actually selling at right now, as the monitor last
   * observed it (`allegro_offer.price_amount`). This is the anchor: every margin
   * worth trusting is measured against what the offer really sells for, not
   * against an SRP the automation may be nowhere near.
   */
  currentPrice?: number;
  /** Margin percent the SRP-base discounted price would leave. A what-if, not the anchor. */
  overrideMarginPct?: number;
  /**
   * True when the SRP-base discount would RAISE the live price. Reachable whenever
   * Allegro's automation has followed competitors below SRP minus the discount, and
   * it means that mode is a price increase wearing a promotion's clothes.
   */
  raisesPrice?: boolean;
  /**
   * What the CURRENT price leaves, computed by the costs
   * plugin's own `computeEconomics` rather than a second formula here, so the
   * margin can never disagree with the break-even it is measured against.
   *
   * Undefined when the cost or commission is unknown. It is deliberately the
   * SRP-base price: that is the only mode whose price is determinable in advance.
   * The competitor mode lets Allegro pick a price inside [break-even, SRP], so its
   * margin is a range, not a number, and inventing one would be a guess.
   */
  marginAmount?: number;
  /** `netIncome / sellingPrice` as a fraction (0.42 = 42%). */
  marginPct?: number;
}

/** The full per-promotion preview. */
export interface PromotionPreview {
  promotion: PromotionSummary;
  /**
   * The `discount_base` on the linked Allegro config, or null when none is set.
   * Null is preview-only: both mechanisms are shown, and the promotion is not
   * armable until a base is chosen.
   */
  discountBase: DiscountBase | null;
  /** Whether the linked config has armed this promotion. The overlay is held regardless. */
  enabled: boolean;
  /** Rows for SKUs that resolved to an eligible offer under both mechanisms. */
  rows: OfferPreview[];
  /** SKUs held out, with the eligibility-ladder reason. */
  skipped: { sku: string; reason: SyncSkipReason }[];
  /**
   * The scoping the owner asked to see made explicit. `movesAuctions` is how many
   * targeted offers this promotion would actually reprice; everything else - the
   * skipped rows AND the entire rest of the catalogue - stays untouched, because a
   * promotion only ever acts on the offers of its own targeted products.
   */
  coverage: { targeted: number; linked: number; eligible: number; skipped: number };
}

/**
 * Resolve the full per-SKU preview for one promotion.
 *
 * Reuses the sync loop's break-even (`buildBreakEvenResolver` + the category-rate
 * commission) and SRP (`buildSrpBySku`) exactly, so a preview number is the number
 * the armed overlay would compute - the preview cannot flatter a promotion the
 * overlay would then skip. The eligibility ladder (`evaluateSyncEligibility`) is
 * the same gate too, so `missing-break-even` / `missing-srp` / `offer-not-active`
 * read identically here and there.
 */
export const resolvePromotionPreview = async (
  container: MedusaContainer,
  promotionId: string,
): Promise<PromotionPreview | undefined> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const allegro = container.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const options = (await allegro.getSyncOptions()) as AllegroSyncOptions;

  const { data: promoData } = await query.graph({
    entity: "promotion",
    fields: PROMOTION_FIELDS,
    filters: { id: promotionId },
  });
  const raw = (promoData as unknown as RawPromotion[])[0];
  if (!raw) {
    return undefined;
  }
  const summary = summarise(raw, options.salesChannelId);
  const discount = resolveDiscount(toMethod(raw));
  const config = raw.allegro_promotion_config ?? null;
  const discountBase = asDiscountBase(config?.discount_base) ?? null;
  const enabled = Boolean(config?.enabled);
  const rules: AutomationRuleNames = {
    promoted: options.automationRules?.promoted ?? "",
    standard: options.automationRules?.standard ?? "",
  };

  const empty: PromotionPreview = {
    coverage: { eligible: 0, linked: 0, skipped: 0, targeted: 0 },
    discountBase,
    enabled,
    promotion: summary,
    rows: [],
    skipped: [],
  };

  // A promotion that cannot drive Allegro at all, or whose discount does not map,
  // has nothing to resolve per SKU. The block reasons on the summary explain why.
  if (summary.blockReasons.length > 0 || discount.kind === "unsupported") {
    return empty;
  }

  // Targeted variants -> SKUs, carrying the metadata the SRP lookup needs.
  const selection = targetSelectionFromRules(raw.application_method?.target_rules ?? []);
  const variants = await loadTargetVariants(query, selection.productIds, selection.variantIds);
  if (variants.length === 0) {
    return empty;
  }
  const skus = [...new Set(variants.map((variant) => variant.sku).filter(Boolean))] as string[];

  // The offers for those SKUs, plus the shared pricing inputs, resolved once.
  const offers = await allegro.listAllegroOffers({ sku: skus });
  const offerBySku = new Map<string, RawOffer>((offers as RawOffer[]).map((offer) => [offer.sku, offer]));
  const [categoryRateRows, netCostBySku] = await Promise.all([
    allegro.listAllegroCategoryRates({}),
    loadNetCosts(container, options.costsModuleKey, skus),
  ]);
  const categoryRates = buildCategoryRates(categoryRateRows as Record<string, unknown>[]);
  const costs = resolveCostsService(container, options.costsModuleKey) as CostsEconomics | undefined;
  const breakEvenFor = await buildBreakEvenResolver(costs, skus);
  const srpSource = await buildSrpBySku(container, variants as unknown as CatalogVariant[], options);

  const rows: OfferPreview[] = [];
  const skippedRows: { sku: string; reason: SyncSkipReason }[] = [];
  let linked = 0;

  for (const sku of skus) {
    const offer = offerBySku.get(sku);
    if (offer?.offer_id) {
      linked += 1;
    }
    const promoted = offer?.promoted ?? undefined;
    const currency = offer?.price_currency ?? "PLN";
    // Refreshed by offer discovery on every pass (the upsert is unconditional), so
    // this is the live price even when the row's `updated_at` looks old: the ORM
    // simply does not flush an update whose fields all already match.
    const currentPrice = parseAmount(offer?.price_amount ?? null);
    const commission = resolveCommissionFraction(categoryRates, offer?.category_id, promoted);
    const breakEvenRaw = promoted === undefined ? undefined : await breakEvenFor(sku, commission);
    const eligibility = evaluateSyncEligibility({
      breakEvenPrice: breakEvenRaw,
      offerLinked: Boolean(offer?.offer_id),
      offerStatus: offer?.status as never,
      priceSyncEnabled: offer?.price_sync_enabled ?? true,
      promoted,
      srp: resolveSrp(srpSource, sku, currency),
    });
    if (!eligibility.eligible) {
      skippedRows.push({ reason: eligibility.reason, sku });
      continue;
    }
    const baseRule = eligibility.promoted ? rules.promoted : rules.standard;
    const toRule = promotionalRuleName(baseRule, discount.label);
    const override = computeOverridePrice(eligibility.ceiling, eligibility.floor, discount);
    rows.push({
      breakEven: eligibility.floor,
      breakEvenRaw: breakEvenRaw as number,
      // Anchor margin: measured on the price the auction actually sells at.
      ...(currentPrice === undefined
        ? {}
        : await resolveMargin(costs, netCostBySku.get(sku), commission, currentPrice)),
      currentPrice,
      // What-if margin for the SRP-base price, and whether that price is an increase.
      overrideMarginPct: (
        await resolveMargin(costs, netCostBySku.get(sku), commission, override.price)
      ).marginPct,
      raisesPrice: currentPrice !== undefined && override.price > currentPrice,
      currency,
      offerId: offer?.offer_id ?? null,
      override: { clampedToFloor: override.clampedToFloor, price: override.price, revertRule: baseRule },
      promoted: offer?.promoted ?? null,
      ruleSwitch: toRule.ok
        ? { competitorRelativeCaveat: true, fromRule: baseRule, toRule: toRule.name }
        : { skipped: "rule-name-too-long" },
      sku,
      srp: eligibility.ceiling,
    });
  }

  return {
    coverage: { eligible: rows.length, linked, skipped: skippedRows.length, targeted: skus.length },
    discountBase,
    enabled,
    promotion: summary,
    rows,
    skipped: skippedRows,
  };
};

interface RawOffer {
  sku: string;
  offer_id?: string | null;
  category_id?: string | null;
  promoted?: boolean | null;
  price_sync_enabled?: boolean;
  price_currency?: string | null;
  price_amount?: string | null;
  status?: string | null;
}

interface TargetVariant {
  id: string;
  sku: string;
  metadata?: Record<string, unknown> | null;
  productMetadata?: Record<string, unknown> | null;
}

/**
 * Load the targeted variants (by product id and by variant id), carrying the
 * variant and product metadata `buildSrpBySku` reads. Shaped as `CatalogVariant`
 * enough for that reuse without pulling in the inventory read the sync loop needs.
 */
const loadTargetVariants = async (
  query: QueryGraph,
  productIds: ReadonlySet<string>,
  variantIds: ReadonlySet<string>,
): Promise<TargetVariant[]> => {
  const fields = ["id", "sku", "metadata", "product.metadata"];
  const byId = new Map<string, TargetVariant>();
  const collect = (rows: Record<string, unknown>[]): void => {
    for (const row of rows) {
      const sku = (row.sku as string | null)?.trim();
      const id = row.id as string | undefined;
      if (!id || !sku) {
        continue;
      }
      byId.set(id, {
        id,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        productMetadata:
          ((row.product as { metadata?: Record<string, unknown> } | null)?.metadata as
            | Record<string, unknown>
            | null) ?? null,
        sku,
      });
    }
  };
  if (productIds.size > 0) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields,
      filters: { product_id: [...productIds] },
    });
    collect(data);
  }
  if (variantIds.size > 0) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields,
      filters: { id: [...variantIds] },
    });
    collect(data);
  }
  return [...byId.values()];
};

/**
 * Net purchase cost per SKU, for the margin figure.
 *
 * A SOFT read, exactly as the break-even resolver treats the same module: an absent
 * costs plugin or a failed read yields an empty map and simply no margin column
 * content, never a broken preview and never a guessed cost.
 */
const loadNetCosts = async (
  container: MedusaContainer,
  costsModuleKey: string,
  skus: readonly string[],
): Promise<Map<string, number>> => {
  const byShu = new Map<string, number>();
  if (skus.length === 0) {
    return byShu;
  }
  try {
    const costs = resolveCostsService(container, costsModuleKey) as CostsEconomics | undefined;
    if (!costs) {
      return byShu;
    }
    for (const row of await costs.getCostsBySkus([...skus])) {
      const netCost = parseAmount(row.unit_cost_net);
      if (netCost !== undefined) {
        byShu.set(row.sku, netCost);
      }
    }
  } catch {
    return byShu;
  }
  return byShu;
};

/**
 * The margin a given selling price leaves, delegated to the costs plugin.
 *
 * Deliberately NOT reimplemented here. The plugin already owns the relationship
 * between net cost, VAT, commission and break-even; a second formula in this file
 * would be one refactor away from quietly disagreeing with the floor it is shown
 * next to. Missing inputs yield an absent margin rather than a zero, because a
 * margin of "unknown" and a margin of "nothing" are different facts.
 */
const resolveMargin = async (
  costs: CostsEconomics | undefined,
  netCost: number | undefined,
  commissionRate: number | undefined,
  sellingPrice: number,
): Promise<{ marginAmount?: number; marginPct?: number }> => {
  if (!costs || netCost === undefined || commissionRate === undefined) {
    return {};
  }
  try {
    const { netIncome, marginPct } = await costs.computeEconomics({
      commissionRate,
      netCost,
      sellingPrice,
    });
    return { marginAmount: netIncome, marginPct };
  } catch {
    return {};
  }
};

/** The Link module's minimal surface for creating a promotion<->config association. */
interface LinkService {
  create: (definition: Record<string, Record<string, string>>) => Promise<unknown>;
}

/**
 * Persist the `discount_base` choice for a promotion, creating and linking the
 * config row on first write.
 *
 * A Medusa-only write - it touches `allegro_promotion_config` and the link pivot,
 * NOTHING on Allegro. Setting a base is how an operator records which mechanism
 * they intend before arming (arming itself is held); it changes what the preview
 * emphasises and nothing else until the overlay exists.
 *
 * Idempotent: an existing linked config is updated in place; only the first write
 * for a promotion creates a row and the link. `null` clears the choice back to
 * preview-only.
 */
export const setPromotionDiscountBase = async (
  container: MedusaContainer,
  promotionId: string,
  discountBase: DiscountBase | null,
): Promise<{ discountBase: DiscountBase | null }> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const allegro = container.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const { data } = await query.graph({
    entity: "promotion",
    fields: ["id", "allegro_promotion_config.id"],
    filters: { id: promotionId },
  });
  const existingId = (data as { allegro_promotion_config?: { id?: string } | null }[])[0]
    ?.allegro_promotion_config?.id;

  if (existingId) {
    await allegro.updateAllegroPromotionConfigs({ discount_base: discountBase, id: existingId });
    return { discountBase };
  }

  const created = (await allegro.createAllegroPromotionConfigs({
    discount_base: discountBase,
    enabled: false,
  })) as { id: string };
  const link = container.resolve<LinkService>(ContainerRegistrationKeys.LINK);
  await link.create({
    [ALLEGRO_MODULE]: { allegro_promotion_config_id: created.id },
    [Modules.PROMOTION]: { promotion_id: promotionId },
  });
  return { discountBase };
};
