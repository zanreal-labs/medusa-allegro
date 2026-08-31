import { PROMO_RULE_PREFIX, promotionalRuleName } from "./preview";
import type { ResolvedDiscount } from "./preview";

/**
 * The promotional price-automation rule: what it must look like on Allegro, and
 * the rules about which rules this plugin is allowed to touch.
 *
 * Pure and I/O-free, so the one decision that can destroy a seller's own pricing
 * configuration - "may I edit this rule?" - is exhaustively testable without a
 * client.
 *
 * ## The ownership invariant
 *
 * This plugin creates and edits EXACTLY the rules whose name starts with
 * `PROMO_RULE_PREFIX`. A hand-managed rule ("Bitdefender", "Bitdefender Sale")
 * never carries it. Every write path asks `isPluginOwned` first and refuses
 * otherwise, so the worst a naming accident can do is stop the overlay, never
 * rewrite a rule a person configured. That is deliberately stricter than the
 * plugin's old "never creates a rule" invariant rather than a relaxation of it:
 * the exception is narrow, named, and enforced in one place.
 *
 * ## The discount lives in the rule
 *
 * Allegro's rule config carries the reduction itself: `changeByPercentage` or
 * `changeByAmount`, each with a SUBTRACT/ADD operation. That is the whole
 * mechanism - a promotion moves an offer onto a rule that already encodes the
 * discount, and reverting moves it back. No price is ever written by this path.
 */

/** `configuration.changeByPercentage` / `changeByAmount`, as Allegro accepts it. */
export type PromoRuleConfig =
  | { changeByPercentage: { operation: "SUBTRACT"; value: string } }
  | { changeByAmount: { operation: "SUBTRACT"; values: { amount: string; currency: string }[] } };

/**
 * The rule configuration for one resolved discount.
 *
 * Percentages go over as their plain decimal string; amounts keep grosze. There is
 * deliberately no whole-unit rounding here: a real command response recorded on
 * 2026-08-17 carried a `283.74` ceiling and Allegro accepted it, so grosze are
 * fine on this resource and rounding them away would only make the discount
 * inaccurate. The one rounding that DOES apply happens upstream in
 * `resolveDiscount`, which rounds a fixed amount UP so a customer can never be
 * given less of a discount than the promotion promises.
 */
export const promoRuleConfig = (
  discount: Extract<ResolvedDiscount, { kind: "percentage" | "fixed" }>,
): PromoRuleConfig =>
  discount.kind === "percentage"
    ? { changeByPercentage: { operation: "SUBTRACT", value: String(discount.percent) } }
    : {
        changeByAmount: {
          operation: "SUBTRACT",
          values: [{ amount: discount.amount.toFixed(2), currency: discount.currency }],
        },
      };

/** Whether this plugin may create, edit or delete a rule with this name. */
export const isPluginOwned = (name: string | undefined): boolean =>
  typeof name === "string" && name.startsWith(PROMO_RULE_PREFIX);

/** An account rule, as the ensure step compares against it. */
export interface AccountRule {
  id?: string;
  name?: string;
  type?: string;
  configuration?: unknown;
}

/**
 * Deep-equality for a rule configuration, compared on the shape Allegro returns
 * rather than by reference.
 *
 * Numeric-looking values are compared as NUMBERS, not strings: Allegro echoes a
 * percentage back as `"10"` for what was sent as `"10"` but may render `10.0`, and
 * a string compare would report drift forever and re-PUT the same rule on every
 * run.
 */
export const configEquals = (a: unknown, b: unknown): boolean => {
  const norm = (value: unknown): unknown => {
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
    if (Array.isArray(value)) {
      return value.map(norm);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = norm((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

export type PromoRuleDecision =
  | { action: "reuse"; ruleId: string }
  | { action: "create"; name: string; config: PromoRuleConfig; type: string }
  | { action: "update"; ruleId: string; name: string; config: PromoRuleConfig }
  | { action: "refuse"; reason: string };

export interface DecidePromoRuleInput {
  /** The hand-managed rule the offer would otherwise sit on, e.g. "Bitdefender". */
  baseRuleName: string;
  /** The base rule as it exists on the account; its TYPE is inherited. */
  baseRule: AccountRule | undefined;
  discount: Extract<ResolvedDiscount, { kind: "percentage" | "fixed" }>;
  /** Every rule currently on the account. */
  accountRules: readonly AccountRule[];
}

/**
 * Decide what to do about the promotional rule for one base rule + discount.
 *
 * Fail-closed at every ambiguity, because the failure mode on the other side is a
 * live catalogue repriced under a rule nobody meant:
 *
 * - The base rule must exist and carry a type. The promotional rule INHERITS that
 *   type, so that a promotion changes the discount and nothing else about how the
 *   price is computed. Inventing a type would silently change the pricing strategy.
 * - A name that resolves to a rule this plugin does not own is refused outright,
 *   never adopted and never edited.
 * - An ambiguous name (two account rules sharing it) is refused: Allegro keeps rule
 *   names unique per seller, so seeing two means something is not what we think.
 * - A rule we own whose config has drifted is UPDATED rather than duplicated,
 *   because rule names are unique and a second one cannot be created anyway.
 */
export const decidePromoRule = (input: DecidePromoRuleInput): PromoRuleDecision => {
  const named = promotionalRuleName(input.baseRuleName, input.discount.label);
  if (!named.ok) {
    return { action: "refuse", reason: named.reason };
  }
  if (!input.baseRule?.type) {
    return {
      action: "refuse",
      reason: `base rule "${input.baseRuleName}" was not found on the account, or carries no type to inherit`,
    };
  }

  const matches = input.accountRules.filter((rule) => rule.name === named.name);
  if (matches.length > 1) {
    return {
      action: "refuse",
      reason: `rule name "${named.name}" is ambiguous (${matches.length} rules share it)`,
    };
  }

  const config = promoRuleConfig(input.discount);
  const existing = matches[0];
  if (!existing) {
    return { action: "create", config, name: named.name, type: input.baseRule.type };
  }
  if (!isPluginOwned(existing.name)) {
    // Unreachable while the name is built with the prefix, and kept because it is
    // the guard that makes the ownership invariant true by construction rather
    // than by the caller remembering it.
    return {
      action: "refuse",
      reason: `rule "${existing.name ?? "?"}" is not plugin-owned and must not be edited`,
    };
  }
  if (!existing.id) {
    return { action: "refuse", reason: `rule "${named.name}" was returned without an id` };
  }
  if (configEquals(existing.configuration, config)) {
    return { action: "reuse", ruleId: existing.id };
  }
  return { action: "update", config, name: named.name, ruleId: existing.id };
};
