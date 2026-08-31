import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { raiseAllegroAlert } from "../../lib/admin-notification";
import type { AllegroClient } from "../../lib/allegro/client";
import {
  channelScopeFromRules,
  includesAllegroChannel,
  isPromotionActive,
  targetSelectionFromRules,
} from "../../lib/promotions/eligibility";
import { decidePromoRule } from "../../lib/promotions/overlay";
import { promotionalRuleName } from "../../lib/promotions/preview";
import type { AccountRule } from "../../lib/promotions/overlay";
import { asDiscountBase, resolveDiscount } from "../../lib/promotions/preview";
import type { AutomationRuleNames } from "../../lib/sync/price-automation";
import { ALLEGRO_MODULE } from "../../modules/allegro";
import type AllegroModuleService from "../../modules/allegro/service";
import { loadTargetVariants, PROMOTION_FIELDS, toMethod } from "./promotion-resolve";
import type { RawPromotion } from "./promotion-resolve";

/**
 * The promotion overlay: which offers should sit on a PROMOTIONAL price-automation
 * rule right now, instead of their ordinary one.
 *
 * ## How it executes, and why there is almost no execution here
 *
 * The overlay does not push anything. It answers one question per SKU - "which two
 * rule names does this offer expect?" - and hands the answer to the price-sync
 * planner, which already knows how to compare that against the attached rule and
 * emit a `switch`. So applying a promotion and reverting it are the SAME code path
 * the loop runs every hour, with the same change cap, quarantine, circuit breaker,
 * single-flight claim and audit trail.
 *
 * Reverting therefore needs no bookkeeping at all: when a promotion's window closes
 * this map simply stops containing its SKUs, the expected rule reverts to the
 * standard one, and the planner emits the switch back. There is no stored
 * "pre-promotion state" to lose, because the standard rule was never forgotten.
 *
 * ## Three gates before anything moves
 *
 * `promotion_overlay_enabled` (global), `price_sync_enabled` (the loop this rides),
 * and the promotion's own `enabled`. All three default OFF. Arming is three
 * deliberate acts, because this is the only path that reprices a live catalogue on a
 * schedule.
 *
 * ## Only the competitor base executes here
 *
 * `discount_base: "competitor"` is the rule-switch mechanism: the discount lives in
 * the rule's own configuration and Allegro applies it relative to the competitor
 * reference. `discount_base: "srp"` describes a fixed price, which is a different
 * writer entirely (the plugin's fixed-price mode) and is NOT actioned here - live
 * data showed an SRP-based discount on this catalogue would RAISE prices, so
 * quietly executing it through this path would be the worst possible surprise.
 */

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

/** The two rule names an offer expects, plus their resolved Allegro ids. */
export interface PromoRuleOverride {
  names: AutomationRuleNames;
  ids: { standardId: string; promotedId: string };
  promotionId: string;
}

export interface OverlayResult {
  /** SKU -> the promotional rules that SKU's offer should be on. */
  bySku: Map<string, PromoRuleOverride>;
  /** Promotions considered armed and in-window this run. */
  active: number;
  /** Promotions that could not be applied, with the reason. Each is alerted. */
  refused: { promotionId: string; reason: string }[];
}

const EMPTY: OverlayResult = { active: 0, bySku: new Map(), refused: [] };

/**
 * Ensure one promotional rule exists on Allegro and return its id.
 *
 * The ONLY place this plugin creates or edits a rule, and it is fenced by
 * `decidePromoRule`, which refuses anything not carrying the plugin's prefix. A 409
 * on create means another process won the race and created the same name, which is
 * a success for our purposes: the rules are re-read and the existing one reused.
 */
const ensureRule = async (
  client: AllegroClient,
  accountRules: AccountRule[],
  baseRuleName: string,
  discount: Parameters<typeof decidePromoRule>[0]["discount"],
): Promise<{ id: string } | { error: string }> => {
  const baseRule = accountRules.find((rule) => rule.name === baseRuleName);
  const decision = decidePromoRule({ accountRules, baseRule, baseRuleName, discount });

  if (decision.action === "refuse") {
    return { error: decision.reason };
  }
  if (decision.action === "reuse") {
    return { id: decision.ruleId };
  }
  if (decision.action === "update") {
    const updated = await client.updatePriceAutomationRule(decision.ruleId, {
      configuration: decision.config,
      name: decision.name,
    });
    return { id: updated.id ?? decision.ruleId };
  }
  try {
    const created = await client.createPriceAutomationRule({
      configuration: decision.config,
      name: decision.name,
      type: decision.type,
    });
    if (!created.id) {
      return { error: `Allegro created rule "${decision.name}" without returning an id` };
    }
    // Record it so a second base rule in the same run sees it rather than
    // attempting a duplicate create.
    accountRules.push({ configuration: decision.config, id: created.id, name: decision.name });
    return { id: created.id };
  } catch (error) {
    // A 409 means the name now exists - almost certainly this same rule, created
    // concurrently. Re-read and reuse rather than failing the promotion.
    const { rules } = await client.listPriceAutomationRules();
    const found = (rules ?? []).find((rule) => rule.name === decision.name);
    if (found?.id) {
      accountRules.splice(0, accountRules.length, ...(rules as AccountRule[]));
      return { id: found.id };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Build the per-SKU rule overrides for every armed, in-window promotion.
 *
 * Returns an empty map - and touches Allegro not at all - whenever the overlay is
 * disarmed, which is the state it ships in.
 */
export const resolvePromotionOverlay = async (
  container: MedusaContainer,
  client: AllegroClient,
  baseRules: AutomationRuleNames,
): Promise<OverlayResult> => {
  const allegro = container.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  // Fail closed on a service that cannot answer. A module version without the
  // toggle, or a stub that does not implement it, must mean "do not reprice"
  // rather than "assume armed" - the whole point of the gate is that repricing a
  // live catalogue needs a positive, readable yes.
  if (typeof allegro.isPromotionOverlayDisabled !== "function") {
    return EMPTY;
  }
  if (await allegro.isPromotionOverlayDisabled()) {
    return EMPTY;
  }

  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const options = await allegro.getSyncOptions();
  const { data } = await query.graph({ entity: "promotion", fields: PROMOTION_FIELDS });
  const promotions = data as unknown as RawPromotion[];

  const bySku = new Map<string, PromoRuleOverride>();
  const refused: { promotionId: string; reason: string }[] = [];
  let active = 0;
  let accountRules: AccountRule[] | undefined;

  for (const promotion of promotions) {
    const config = promotion.allegro_promotion_config;
    if (!config?.enabled) {
      continue;
    }
    // Only the rule-switch mechanism executes here; see the file header.
    if (asDiscountBase(config.discount_base) !== "competitor") {
      continue;
    }
    if (!(promotion.is_automatic && isPromotionActive(promotion.status, promotion.campaign))) {
      continue;
    }
    if (
      !includesAllegroChannel(
        channelScopeFromRules(promotion.rules ?? []),
        options.salesChannelId,
      )
    ) {
      continue;
    }
    const discount = resolveDiscount(toMethod(promotion));
    if (discount.kind === "unsupported") {
      continue;
    }
    active += 1;

    const selection = targetSelectionFromRules(promotion.application_method?.target_rules ?? []);
    const variants = await loadTargetVariants(query, selection.productIds, selection.variantIds);
    const skus = [...new Set(variants.map((variant) => variant.sku).filter(Boolean))];
    if (skus.length === 0) {
      const reason = "the promotion is armed but targets no SKU with an Allegro offer";
      refused.push({ promotionId: promotion.id, reason });
      await raiseAllegroAlert(container, {
        detail: reason,
        kind: "promotion_no_coverage",
        resourceId: promotion.id,
      });
      continue;
    }

    // Read the account's rules once, and only when a promotion actually needs them.
    accountRules ??= ((await client.listPriceAutomationRules()).rules ?? []) as AccountRule[];

    const standard = await ensureRule(client, accountRules, baseRules.standard, discount);
    const promoted = await ensureRule(client, accountRules, baseRules.promoted, discount);
    if ("error" in standard || "error" in promoted) {
      const reason =
        "error" in standard ? standard.error : (promoted as { error: string }).error;
      refused.push({ promotionId: promotion.id, reason });
      logger.error(
        `[allegro-promotion-overlay] promotion ${promotion.id} not applied: ${reason}. Offers already switched stay on the promotional rule until this is resolved.`,
      );
      await raiseAllegroAlert(container, {
        detail: reason,
        kind: "promotion_half_applied",
        resourceId: promotion.id,
      });
      continue;
    }

    // Built with the SAME helper that named the rules on Allegro. Deriving them
    // separately here is how the planner would compare the attached rule against a
    // name that does not exist, see a permanent mismatch, and re-switch the same
    // offer on every single run.
    const promotedName = promotionalRuleName(baseRules.promoted, discount.label);
    const standardName = promotionalRuleName(baseRules.standard, discount.label);
    if (!(promotedName.ok && standardName.ok)) {
      // Unreachable: ensureRule already refused on this exact condition. Kept so the
      // names can never be silently undefined if that ordering ever changes.
      continue;
    }
    const names: AutomationRuleNames = {
      promoted: promotedName.name,
      standard: standardName.name,
    };
    for (const sku of skus) {
      // First armed promotion wins a contested SKU, deterministically by the order
      // the promotions came back, rather than the last one silently overwriting.
      if (!bySku.has(sku)) {
        bySku.set(sku, {
          ids: { promotedId: promoted.id, standardId: standard.id },
          names,
          promotionId: promotion.id,
        });
      }
    }
  }

  return { active, bySku, refused };
};
