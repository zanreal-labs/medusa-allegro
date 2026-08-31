import { round2 } from "../sync/money";
import type { AutomationRuleNames, SyncSkipReason } from "../sync/price-automation";

/**
 * The pure core of the read-only promotion preview.
 *
 * Everything here is I/O-free so it can be exhaustively unit-tested: the engine
 * that owns the reads (`src/workflows/lib/promotion-resolve.ts`) supplies the
 * native Medusa promotion, the offer, the resolved break-even and SRP, and this
 * decides what WOULD happen if the promotion were armed - which rule an offer
 * switches to, or what price an override would set - and never touches Allegro.
 *
 * ## The two mechanisms, chosen by discount base (never guessed)
 *
 * A promotion carries a `discount_base` the operator sets per promotion. It is the
 * encoding of the two things the owner asked for, and it is the ONLY input that
 * selects a mechanism:
 *
 * - `competitor` -> **rule switch.** The offer is moved onto a promotional
 *   price-automation rule that carries the reduction in its own config
 *   (`changeByPercentage` / `changeByAmount` SUBTRACT), applied relative to the
 *   competitor reference and clamped to `[break-even, SRP]`. Revert = switch back
 *   to the standard rule. No price is ever written.
 * - `srp` -> **price override.** The automation rule is detached and a fixed Buy
 *   Now price of `SRP - discount` (clamped at break-even) is set. Revert =
 *   re-attach the standard rule with its recorded bounds - the existing attach
 *   path, from `allegro_price_push` bounds memory.
 * - unset (`null`) -> preview-only, NOT armable. Nothing silently picks a
 *   mechanism; an operator must choose the base before a promotion can be armed.
 *
 * The competitor-relative caveat is load-bearing and surfaced per SKU: a
 * competitor-base rule does NOTHING when our offer is already the cheapest
 * (Allegro sends the price to the range max instead), so the reduction only bites
 * where a cheaper competitor exists. That is a fact about the mechanism, not a
 * defect, and the preview says so rather than promising a discount that will not
 * land.
 */

/** How a promotion computes its reduction, and therefore which mechanism applies. */
export type DiscountBase = "srp" | "competitor";

/** The two valid discount bases, for validating a persisted or submitted value. */
export const DISCOUNT_BASES: readonly DiscountBase[] = ["srp", "competitor"];

/** Narrow an arbitrary value to a `DiscountBase`, or undefined when it is neither. */
export const asDiscountBase = (value: unknown): DiscountBase | undefined =>
  value === "srp" || value === "competitor" ? value : undefined;

/** The Medusa application-method fields the preview reasons about. */
export interface PromotionMethod {
  /** `percentage` or `fixed`; anything else is unsupported. */
  type?: string | null;
  /** Percent (for `percentage`) or money amount (for `fixed`), as a number. */
  value?: number | null;
  /** ISO currency for a `fixed` amount. */
  currency_code?: string | null;
  /** `items` is the only target this maps to; `order` / `shipping_methods` do not. */
  target_type?: string | null;
  /** `each` is honoured; `across` spreads across a basket and cannot map to one offer. */
  allocation?: string | null;
  /** A per-order unit cap, which a per-offer Allegro discount cannot express. */
  max_quantity?: number | null;
}

/**
 * A discount the preview could resolve to a single per-offer reduction, or the
 * reason it could not.
 *
 * `unsupported` is a first-class outcome: a Medusa promotion can be shaped in ways
 * that have no faithful per-offer Allegro equivalent (an order-level discount, a
 * basket-spread `across` allocation, a unit cap), and pretending otherwise would
 * be a mispricing. Each unsupported shape names itself so the preview can explain
 * why an offer is skipped rather than silently dropping it.
 */
export type ResolvedDiscount =
  | { kind: "percentage"; percent: number; label: string }
  | { kind: "fixed"; amount: number; currency: string; label: string }
  | { kind: "unsupported"; reason: string };

/**
 * Map a Medusa application method onto a single per-offer discount, or say why it
 * cannot map.
 *
 * The checks are ordered so the reported reason is the most fundamental one: a
 * missing type is reported before a bad target, an unsupported target before an
 * allocation quirk. Every rejection is explicit; there is no default that would
 * turn an unmappable promotion into a plausible-looking one.
 */
export const resolveDiscount = (method: PromotionMethod): ResolvedDiscount => {
  const type = method.type?.trim();
  if (type !== "percentage" && type !== "fixed") {
    return { kind: "unsupported", reason: `unsupported application method type "${type ?? "none"}"` };
  }
  // Only an item-level discount maps to an offer. An order- or shipping-level
  // discount is about the basket, not a product, and has no per-offer meaning.
  if (method.target_type && method.target_type !== "items") {
    return {
      kind: "unsupported",
      reason: `discount targets "${method.target_type}", not items, so it has no per-offer equivalent`,
    };
  }
  // `across` spreads one discount over every item in a qualifying basket, so the
  // per-offer amount depends on the rest of the cart and cannot be a fixed rule.
  if (method.allocation === "across") {
    return {
      kind: "unsupported",
      reason: "allocation is `across` (spread over the basket), which has no fixed per-offer value",
    };
  }
  // `once` discounts a single unit per order, so it is not a per-unit price either.
  if (method.allocation === "once") {
    return {
      kind: "unsupported",
      reason: "allocation is `once` (a single unit per order), which is not a per-unit price",
    };
  }
  // `max_quantity` is deliberately NOT disqualifying, and getting that wrong made the
  // whole feature unusable once already.
  //
  // Medusa's own validation (`allowedAllocationForQuantity` in the promotion module)
  // REQUIRES `max_quantity` for both `each` and `once`, and forbids it for `across`.
  // So every item-targeted promotion a person can actually save carries one, and
  // rejecting any capped discount rejected 100% of valid promotions - the first real
  // promotion built by hand hit exactly that and reported "no per-offer equivalent"
  // for a plain 10% off.
  //
  // What the cap really means: Medusa discounts at most N units of this item per
  // ORDER, while an Allegro offer price applies to every unit bought. The two diverge
  // only for a single order larger than N. `each` is the closest and only expressible
  // per-unit shape, so it is accepted, and the divergence is a property of the cap
  // rather than a reason to refuse to price anything.
  const value = method.value;
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return { kind: "unsupported", reason: "discount value is missing or not positive" };
  }
  if (type === "percentage") {
    if (value >= 100) {
      return { kind: "unsupported", reason: `percentage discount ${value}% is not below 100%` };
    }
    return { kind: "percentage", label: `-${trimNumber(value)}%`, percent: value };
  }
  const currency = method.currency_code?.trim().toUpperCase();
  if (!currency) {
    return { kind: "unsupported", reason: "fixed discount carries no currency" };
  }
  // Round the reduction UP to grosze, never down: a customer must never get a
  // smaller discount than the promotion promises. This over-discounts by at most a
  // grosz and the break-even clamp still stops it breaching cost.
  const amount = ceil2(value);
  return { amount, currency, kind: "fixed", label: `-${formatMoney(amount)} ${currency}` };
};

/** Trim a float to a short human string ("10", "12.5") without trailing zeros. */
const trimNumber = (value: number): string => String(round2(value));

/** Two-decimal money string. */
export const formatMoney = (value: number): string => value.toFixed(2);

/**
 * A grosz's worth of float noise. Subtracted before a ceil and added before a
 * floor so a value already exact at two decimals (whose binary form may sit a
 * whisker above or below) is not bumped a whole grosz the wrong way.
 */
const CENT_EPSILON = 1e-9;

/** Round UP to two decimals - the safe direction for a promised discount. */
export const ceil2 = (value: number): number => Math.ceil(value * 100 - CENT_EPSILON) / 100;

/** Round DOWN to two decimals - the safe direction for an overridden SELLING price. */
export const floor2 = (value: number): number => Math.floor(value * 100 + CENT_EPSILON) / 100;

/**
 * The prefix that marks a price-automation rule as plugin-owned.
 *
 * A hand-managed rule (`"Bitdefender"`, `"Bitdefender Sale"`) never carries it, and
 * that is the whole safety property: the overlay only ever creates, edits or
 * deletes a rule whose name starts with this, and treats a name collision with a
 * rule LACKING the prefix as fail-closed - it never adopts or edits a rule a human
 * configured. `❯` is a single character a person is vanishingly unlikely to type
 * into a rule name, and it leaves room under Allegro's 33-char rule-name limit for
 * the base name and the discount suffix.
 */
export const PROMO_RULE_PREFIX = "ZR❯";

/** Allegro's hard limit on a price-automation rule name. */
export const ALLEGRO_RULE_NAME_MAX = 33;

export type PromotionalRuleName =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * The name of the plugin-owned promotional rule for a given base rule and
 * discount.
 *
 * `<prefix><base> <discountLabel>`, e.g. `ZR❯Bitdefender -10%`. Fails closed when
 * the result would exceed Allegro's 33-character limit rather than truncating: a
 * truncated name could collide with another discount's rule or with a hand-managed
 * one, and the overlay must never guess which rule a name refers to.
 */
export const promotionalRuleName = (
  baseRuleName: string,
  discountLabel: string,
): PromotionalRuleName => {
  const name = `${PROMO_RULE_PREFIX}${baseRuleName} ${discountLabel}`;
  if ([...name].length > ALLEGRO_RULE_NAME_MAX) {
    return {
      ok: false,
      reason: `promotional rule name "${name}" exceeds Allegro's ${ALLEGRO_RULE_NAME_MAX}-character limit`,
    };
  }
  return { name, ok: true };
};

/** The clamped Buy Now price an SRP-base override would set. */
export interface OverridePrice {
  /** `SRP - discount`, rounded down, then floored at break-even. */
  price: number;
  /** True when the discount would breach break-even and the price was floored to it. */
  clampedToFloor: boolean;
}

/**
 * The overridden price for an `srp`-base promotion: `SRP - discount`, rounded DOWN
 * (a selling price must never round up past the promised discount), then clamped
 * so it never falls below break-even.
 *
 * A discount deep enough to breach break-even is not rejected here - it is clamped
 * to the floor and flagged, because "the promotion wanted a lower price than cost
 * allows" is a thing the operator should SEE in the preview, not a silent skip.
 */
export const computeOverridePrice = (
  srp: number,
  breakEven: number,
  discount: Extract<ResolvedDiscount, { kind: "percentage" | "fixed" }>,
): OverridePrice => {
  const raw = discount.kind === "percentage" ? srp * (1 - discount.percent / 100) : srp - discount.amount;
  const rounded = floor2(raw);
  if (rounded < breakEven) {
    return { clampedToFloor: true, price: breakEven };
  }
  return { clampedToFloor: false, price: rounded };
};

/** Why a promotion, as a whole, cannot drive Allegro. Distinct from per-offer skips. */
export type PromotionBlockReason =
  | "not-automatic"
  | "allegro-channel-excluded"
  | "discount-base-unset"
  | "discount-unsupported"
  | "no-target-products";

export const PROMOTION_BLOCK_LABEL: Record<PromotionBlockReason, string> = {
  "allegro-channel-excluded":
    "the promotion is scoped to sales channels that do not include the Allegro channel",
  "discount-base-unset":
    "no discount base is set, so no mechanism is selected - this promotion is preview-only until an operator picks SRP or competitor",
  "discount-unsupported": "the discount shape has no faithful per-offer Allegro equivalent",
  "not-automatic":
    "the promotion is code-based; only automatic promotions (is_automatic) can drive Allegro, because there is no cart to enter a code on",
  "no-target-products": "the promotion targets no products",
};

/** A per-SKU skip specific to the preview, on top of the sync eligibility ladder. */
export type PreviewSkipReason = SyncSkipReason | "rule-name-too-long";

/** The resolved mechanism for one previewed offer. */
export type PreviewMechanism =
  | {
      kind: "rule-switch";
      /** The standard rule the offer sits on today (by Wyroznienie state). */
      fromRule: string;
      /** The plugin-owned promotional rule it would switch to. */
      toRule: string;
      /**
       * True for the uncontested case: a competitor-base rule does not lower the
       * price when we are already cheapest. Surfaced, never hidden.
       */
      competitorRelativeCaveat: true;
    }
  | {
      kind: "price-override";
      /** The clamped Buy Now price the override would set. */
      price: number;
      /** True when the discount was deep enough to be floored at break-even. */
      clampedToFloor: boolean;
      /** The rule that would be re-attached on expiry (the revert plan). */
      revertRule: string;
    };

/** One resolved preview row for a covered SKU, or the reason it is skipped. */
export type PreviewRow =
  | {
      sku: string;
      skipped: false;
      /** Whether the offer carries the paid Wyroznienie highlight. NOT a discount. */
      promoted: boolean;
      mechanism: PreviewMechanism;
      /** Break-even floor, whole-PLN (what a rule range would use). */
      breakEven: number;
      /** The raw, un-rounded break-even, shown because whole-PLN rounding is unverified. */
      breakEvenRaw: number;
      /** SRP ceiling in the offer currency. */
      srp: number;
      currency: string;
      discountLabel: string;
    }
  | { sku: string; skipped: true; reason: PreviewSkipReason };

export interface AssemblePreviewRowInput {
  sku: string;
  currency: string;
  promoted: boolean;
  discountBase: DiscountBase;
  discount: Extract<ResolvedDiscount, { kind: "percentage" | "fixed" }>;
  /** Whole-PLN break-even floor (as the sync loop computes it). */
  breakEven: number;
  /** The raw break-even before whole-PLN rounding. */
  breakEvenRaw: number;
  srp: number;
  rules: AutomationRuleNames;
}

/**
 * Assemble one non-skipped preview row: pick the mechanism from the discount base,
 * name the rules, and (for an override) compute the clamped price.
 *
 * The caller has already run the sync eligibility ladder and resolved break-even
 * and SRP, so this is pure assembly. The one thing that can still fail here is a
 * promotional rule name that will not fit Allegro's 33-char limit, which is a
 * `rule-name-too-long` skip rather than a truncated guess.
 */
export const assemblePreviewRow = (input: AssemblePreviewRowInput): PreviewRow => {
  const baseRule = input.promoted ? input.rules.promoted : input.rules.standard;
  if (input.discountBase === "competitor") {
    const toRule = promotionalRuleName(baseRule, input.discount.label);
    if (!toRule.ok) {
      return { reason: "rule-name-too-long", sku: input.sku, skipped: true };
    }
    return {
      breakEven: input.breakEven,
      breakEvenRaw: input.breakEvenRaw,
      currency: input.currency,
      discountLabel: input.discount.label,
      mechanism: {
        competitorRelativeCaveat: true,
        fromRule: baseRule,
        kind: "rule-switch",
        toRule: toRule.name,
      },
      promoted: input.promoted,
      skipped: false,
      sku: input.sku,
      srp: input.srp,
    };
  }
  const override = computeOverridePrice(input.srp, input.breakEven, input.discount);
  return {
    breakEven: input.breakEven,
    breakEvenRaw: input.breakEvenRaw,
    currency: input.currency,
    discountLabel: input.discount.label,
    mechanism: {
      clampedToFloor: override.clampedToFloor,
      kind: "price-override",
      price: override.price,
      revertRule: baseRule,
    },
    promoted: input.promoted,
    skipped: false,
    sku: input.sku,
    srp: input.srp,
  };
};
