import type { AllegroOffer } from "../allegro/types";
import { roundAutomationFloor } from "./money";

/**
 * Pure price-automation logic: the drift matrix, the transition rule, the
 * eligibility ladder, and the attach/switch/bounds decision. No I/O, so every
 * one of them is exhaustively unit-testable, and the engines that own the side
 * effects (see `src/workflows`) supply the observed offer plus the account's
 * rules.
 *
 * Decisions this encodes (locked, ported from the production implementation this
 * plugin replaces):
 *
 * - The plugin attaches one of exactly two rules that already exist on the
 *   account, chosen by promotion state (`automationRules.promoted` /
 *   `automationRules.standard`). It never creates, edits, or invents a rule.
 * - Bounds for a push are `[ceil(break-even), SRP]`. The floor covers the
 *   VAT-grossed purchase cost and the commission Allegro takes on the final
 *   price; the ceiling is the recommended retail price.
 * - A promotion flip is surfaced as drift for an operator to see, and corrected
 *   by the write loop as a rule SWITCH - never by silently editing a rule.
 */

/** Allegro publication statuses, as the sync reasons about them. */
export type OfferStatus = NonNullable<NonNullable<AllegroOffer["publication"]>["status"]>;

/**
 * How a linked offer prices right now, as observed on the offer:
 *
 * - `automated` - a price-automation rule is attached.
 * - `fixed` - active offer, no rule attached.
 * - `paused` - a rule is attached but paused. Reserved: the bulk read this
 *   plugin uses cannot distinguish it yet, so the monitor never emits it. Kept
 *   because the column and the badge must handle it the day a paused signal
 *   becomes available, and because the drift matrix already has a correct answer
 *   for it.
 * - `ended` - the offer is not ACTIVE (ENDED / INACTIVE / GOING_TO_BE_*).
 * - `unknown` - not observed this run (offer missing from the listing, or the
 *   read failed).
 */
export type PriceMode = "automated" | "fixed" | "paused" | "ended" | "unknown";

/** The two managed rule names, by promotion state. */
export interface AutomationRuleNames {
  promoted: string;
  standard: string;
}

/** The rule name this plugin expects on an offer, given its promotion state. */
export const expectedRuleForPromoted = (promoted: boolean, rules: AutomationRuleNames): string =>
  promoted ? rules.promoted : rules.standard;

/**
 * Promotion state as written on an audit row.
 *
 * Accepts null as well as undefined, because the stored column is three-state: an
 * unresolved promotion state reads as NULL from the database and as `undefined` from a
 * row object that never carried the key, and both mean "unknown". Testing for null as
 * well is what keeps a NULL from being mislabelled "standard" in the audit trail.
 */
export const promotionStateLabel = (promoted?: boolean | null): string => {
  if (promoted === undefined || promoted === null) {
    return "unknown";
  }
  return promoted ? "promoted" : "standard";
};

export interface PriceModeInput {
  /** False when the offer could not be observed this run (-> `unknown`). */
  observed: boolean;
  /** Offer publication status, if known. */
  status?: OfferStatus;
  /** Attached rule id (`sellingMode.priceAutomation.rule.id`); undefined = none. */
  attachedRuleId?: string;
  /** Set when a paused signal is available. See `PriceMode`. */
  paused?: boolean;
}

/** Derive the price mode from an observed offer's automation state plus status. */
export const resolvePriceMode = (input: PriceModeInput): PriceMode => {
  if (!input.observed) {
    return "unknown";
  }
  if (input.status !== undefined && input.status !== "ACTIVE") {
    return "ended";
  }
  if (input.paused) {
    return "paused";
  }
  return input.attachedRuleId ? "automated" : "fixed";
};

export interface DriftInput {
  priceMode: PriceMode;
  /** Offer promotion state, which selects the expected rule. */
  promoted: boolean;
  /** Resolved name of the attached rule; undefined when none or unresolvable. */
  attachedRuleName?: string;
  rules: AutomationRuleNames;
}

/**
 * Whether the observed automation state drifts from what the configuration says
 * it should be.
 *
 * - `unknown` never drifts: nothing was observed, and reporting drift on an
 *   absent observation would fill the admin with noise every time a listing page
 *   came back short.
 * - `ended` clears drift: a non-ACTIVE offer is not this plugin's to manage.
 * - `automated` drifts when the attached rule's NAME differs from the expected
 *   one. That single comparison is how two distinct problems surface: a promotion
 *   flip (a promoted offer still on the standard rule), and an attached rule id
 *   that resolves to no name on the account at all.
 * - `fixed` / `paused`: an active offer that should be automated is not.
 */
export const computeDrift = (input: DriftInput): boolean => {
  if (input.priceMode === "unknown" || input.priceMode === "ended") {
    return false;
  }
  if (input.priceMode === "automated") {
    return input.attachedRuleName !== expectedRuleForPromoted(input.promoted, input.rules);
  }
  return true;
};

export interface AutomationSnapshot {
  priceMode: PriceMode;
  ruleId?: string;
}

/**
 * Whether `next` is a rule TRANSITION worth auditing against the stored state.
 *
 * A first observation - no prior state, or a prior `unknown` - is a baseline, not
 * a transition, so the append-only audit is not flooded on the initial sweep of
 * a whole catalogue. After that, any change of mode or of attached rule id is a
 * transition and earns a row.
 */
export const isTransition = (
  previous: AutomationSnapshot | undefined,
  next: AutomationSnapshot,
): boolean => {
  if (!previous || previous.priceMode === "unknown") {
    return false;
  }
  return (
    previous.priceMode !== next.priceMode || (previous.ruleId ?? null) !== (next.ruleId ?? null)
  );
};

/** Why the loop declined to touch one offer this run. Each is counted and surfaced. */
export type SyncSkipReason =
  | "not-linked"
  | "sync-disabled"
  | "offer-not-active"
  | "status-unknown"
  | "promotion-unresolved"
  | "missing-break-even"
  | "missing-srp"
  | "invalid-bounds"
  | "missing-medusa-price"
  | "price-outside-bounds";

/** Human sentence for a skip reason, for logs and the admin. */
export const SYNC_SKIP_LABEL: Record<SyncSkipReason, string> = {
  "invalid-bounds": "break-even floor is at or above the SRP ceiling",
  "missing-break-even":
    "missing break-even price (needs a purchase cost and a category commission rate)",
  "missing-medusa-price":
    "the Medusa variant has no price in the offer's currency, so there is no fixed price to push",
  "missing-srp": "missing SRP (the ceiling bound)",
  "not-linked": "not linked to an Allegro offer",
  "offer-not-active": "linked offer is not ACTIVE",
  "price-outside-bounds":
    "the Medusa price is below the break-even floor or above the SRP ceiling, so it was refused rather than pushed",
  "promotion-unresolved": "promotion state could not be resolved",
  "status-unknown": "offer publication status could not be read",
  "sync-disabled": "price sync is disabled for this offer",
};

export interface SyncEligibilityInput {
  /** Whether the SKU is linked to an offer at all. */
  offerLinked: boolean;
  /** Linked offer status, if observed. */
  offerStatus?: OfferStatus;
  /** The per-offer opt-out (`false` = never touched). */
  priceSyncEnabled: boolean;
  /** Floor input: the computed break-even price. */
  breakEvenPrice?: number;
  /** Ceiling input: the SRP. */
  srp?: number;
  /** Promotion state; undefined means it could not be resolved this run. */
  promoted?: boolean;
}

export type SyncEligibility =
  | { eligible: true; promoted: boolean; floor: number; ceiling: number }
  | { eligible: false; reason: SyncSkipReason };

/**
 * Decide whether one offer is safe to write to, and if so hand back the resolved
 * bounds and promotion state.
 *
 * The ORDER of the checks is the reported reason, and it is deliberate: an
 * unlinked SKU reports `not-linked` even when it is also missing an SRP, and the
 * per-offer opt-out short-circuits before any data check so a disabled offer
 * never surfaces a spurious "missing break-even" for an operator to chase.
 *
 * Fail-closed throughout. The ACTIVE gate is the clearest case: a write is only
 * safe against an offer POSITIVELY observed as ACTIVE, so an undefined status
 * (the publication block absent from the read) is its own counted reason and
 * never a pass-through. Likewise a missing break-even or SRP is unsafe and
 * counted, never defaulted - a floor of 0 is a licence to sell at a loss, and a
 * ceiling guessed from the current price lets a rule ratchet downward forever.
 */
export const evaluateSyncEligibility = (input: SyncEligibilityInput): SyncEligibility => {
  if (!input.offerLinked) {
    return { eligible: false, reason: "not-linked" };
  }
  if (!input.priceSyncEnabled) {
    return { eligible: false, reason: "sync-disabled" };
  }
  if (input.offerStatus === undefined) {
    return { eligible: false, reason: "status-unknown" };
  }
  if (input.offerStatus !== "ACTIVE") {
    return { eligible: false, reason: "offer-not-active" };
  }
  if (input.promoted === undefined) {
    return { eligible: false, reason: "promotion-unresolved" };
  }
  if (input.breakEvenPrice === undefined) {
    return { eligible: false, reason: "missing-break-even" };
  }
  if (input.srp === undefined) {
    return { eligible: false, reason: "missing-srp" };
  }
  const floor = roundAutomationFloor(input.breakEvenPrice);
  if (floor >= input.srp) {
    return { eligible: false, reason: "invalid-bounds" };
  }
  return { ceiling: input.srp, eligible: true, floor, promoted: input.promoted };
};

/**
 * The two managed rules, resolved by NAME to their Allegro ids.
 *
 * Fail-loud, and the whole run aborts with nothing written when it fails. A
 * missing name, a renamed rule, or an ambiguous name (two account rules sharing
 * it) all mean the same thing: the plugin does not know which rule the operator
 * meant. Guessing attaches the wrong pricing policy to a live catalogue, and
 * creating the rule would silently take over configuration that belongs to the
 * seller.
 *
 * ## The name that misleads everyone once
 *
 * These two names are selected by PROMOTION STATE in the Allegro sense of the word:
 * whether the offer carries a paid "Wyroznienie" highlight, which changes the
 * commission rate and therefore the break-even floor. On this account they happen
 * to be called "Bitdefender" and "Bitdefender Sale", and "Sale" there does NOT mean
 * a discount or a price reduction of any kind. It is the highlighted variant, and
 * the only thing it changes is which commission rate the floor is computed from.
 *
 * Worth stating here, and ONLY here: this belongs next to the code that resolves
 * the names. It was briefly surfaced in the admin UI and read as though the feature
 * had built auction highlighting instead of the price discount that was asked for,
 * which is exactly the confusion it was meant to prevent. Operator-facing screens
 * talk about prices; this file talks about rules.
 */
export type ExpectedRuleResolution =
  | { ok: true; standardId: string; promotedId: string }
  | { ok: false; error: string };

export const resolveExpectedRuleIds = (
  rules: readonly { id?: string; name?: string }[],
  expected: AutomationRuleNames,
): ExpectedRuleResolution => {
  const idsForName = (target: string): string[] => {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (rule.name === target && rule.id) {
        ids.add(rule.id);
      }
    }
    return [...ids];
  };
  const resolveOne = (target: string): { id: string } | { error: string } => {
    const ids = idsForName(target);
    if (ids.length === 0) {
      return { error: `price-automation rule "${target}" was not found on the Allegro account` };
    }
    if (ids.length > 1) {
      return {
        error: `price-automation rule name "${target}" is ambiguous (${ids.length} rules share it)`,
      };
    }
    return { id: ids[0] as string };
  };

  const standard = resolveOne(expected.standard);
  if ("error" in standard) {
    return { error: standard.error, ok: false };
  }
  const promoted = resolveOne(expected.promoted);
  if ("error" in promoted) {
    return { error: promoted.error, ok: false };
  }
  return { ok: true, promotedId: promoted.id, standardId: standard.id };
};

/** `[floor, ceiling]` price bounds, in the offer currency. */
export interface SyncBounds {
  floor: number;
  ceiling: number;
}

/** Bounds equality at 2 decimal places - the precision commands are sent with. */
export const boundsEqual = (a: SyncBounds, b: SyncBounds): boolean => {
  const cents = (value: number): number => Math.round(value * 100);
  return cents(a.floor) === cents(b.floor) && cents(a.ceiling) === cents(b.ceiling);
};

export interface SyncDecisionInput {
  /** Observed attached rule id (undefined = no rule attached). */
  attachedRuleId?: string;
  /** Observed attached rule name, resolved from the account rules; may be undefined. */
  attachedRuleName?: string;
  /** Resolved promotion state, which selects the expected rule. */
  promoted: boolean;
  /** The bounds this run wants on the offer. */
  desiredBounds: SyncBounds;
  /**
   * The `[floor, ceiling]` actually attached to the offer's rule right now,
   * read from `GET /sale/price-automation/offers/{offerId}/rules`; when that
   * read fails, the bounds on the last successful push instead. Undefined when
   * neither source has a range for this offer.
   */
  attachedBounds?: SyncBounds;
  rules: AutomationRuleNames;
}

/**
 * Whether `decideSyncAction` will need the attached bounds to reach a verdict
 * for this offer - i.e. whether the right rule is already attached. Exposed so
 * the caller spends a rate-limited per-offer read only where the answer can
 * change the outcome: an offer with no rule, or the wrong one, is acted on
 * whatever range it carries.
 */
export const needsAttachedBounds = (input: {
  attachedRuleId?: string;
  attachedRuleName?: string;
  promoted: boolean;
  rules: AutomationRuleNames;
}): boolean =>
  Boolean(input.attachedRuleId) &&
  input.attachedRuleName === expectedRuleForPromoted(input.promoted, input.rules);

/**
 * The `[floor, ceiling]` attached to `ruleId` on `marketplaceId`, out of a
 * `GET /sale/price-automation/offers/{offerId}/rules` response.
 *
 * Undefined, not a guess, whenever the response cannot vouch for a range:
 * no assignment for that marketplace, an assignment for a different rule (the
 * rule changed between the listing and this read), a missing or malformed
 * amount, or a range in another currency than the offer's. Undefined makes
 * the caller treat the offer as carrying no range and re-assert the desired
 * one, which is idempotent - the safe direction for a price floor.
 */
export const readAttachedBounds = (
  response: { rules?: Array<{
    marketplace?: { id?: string };
    rule?: { id?: string };
    configuration?: { priceRange?: {
      minPrice?: { amount?: string; currency?: string };
      maxPrice?: { amount?: string; currency?: string };
    } };
  }> } | undefined,
  marketplaceId: string,
  ruleId: string,
  currency?: string,
): SyncBounds | undefined => {
  const assignment = response?.rules?.find(
    (entry) => entry.marketplace?.id === marketplaceId && entry.rule?.id === ruleId,
  );
  const range = assignment?.configuration?.priceRange;
  const floor = Number.parseFloat(range?.minPrice?.amount ?? "");
  const ceiling = Number.parseFloat(range?.maxPrice?.amount ?? "");
  if (!(Number.isFinite(floor) && Number.isFinite(ceiling))) {
    return undefined;
  }
  if (
    currency &&
    (range?.minPrice?.currency !== currency || range?.maxPrice?.currency !== currency)
  ) {
    return undefined;
  }
  return { ceiling, floor };
};

export type SyncDecision =
  | { act: false }
  | { act: true; kind: "attach" | "switch" | "bounds"; expectedRule: string };

/**
 * Whether the loop should issue a command for this offer, and why.
 *
 * `attachedBounds` is the range read off the offer itself. This used to come
 * from the plugin's own audit trail, on the belief that Allegro's range was
 * write-only; it is not (medusa-allegro#37), and comparing against the offer
 * is what makes a range changed in the seller panel visible - an audit-derived
 * comparison would have called that offer correct forever.
 *
 * The triggers:
 *
 * - `attach` - no rule attached at all.
 * - `switch` - the attached rule's name differs from the expected one. A
 *   promotion flip lands here, and so does an attached id that resolves to no
 *   name on the account: re-asserting the expected rule is idempotent, so
 *   treating an unresolvable id as a switch is both safe and self-healing.
 * - `bounds` - the rule already matches, but the offer carries no range, or a
 *   range other than the desired one - because the cost or the SRP moved, or
 *   because somebody edited it in the seller panel.
 *
 * Only an offer on the right rule already carrying exactly the desired bounds
 * is left alone. The per-run change cap, not this function, is
 * what bounds how many of these land per tick.
 */
export const decideSyncAction = (input: SyncDecisionInput): SyncDecision => {
  const expectedRule = expectedRuleForPromoted(input.promoted, input.rules);
  if (!input.attachedRuleId) {
    return { act: true, expectedRule, kind: "attach" };
  }
  if (input.attachedRuleName !== expectedRule) {
    return { act: true, expectedRule, kind: "switch" };
  }
  if (!(input.attachedBounds && boundsEqual(input.attachedBounds, input.desiredBounds))) {
    return { act: true, expectedRule, kind: "bounds" };
  }
  return { act: false };
};

export interface FixedPriceDecisionInput {
  /** The Medusa variant's price, in the offer's currency. */
  desiredPrice: number;
  /** The offer's current Buy Now price, when Allegro reported one. */
  observedPrice?: number;
  /** Observed attached rule id (undefined = no rule attached). */
  attachedRuleId?: string;
  /** The bounds the desired price has to sit inside. */
  bounds: SyncBounds;
}

export type FixedPriceDecision =
  | { act: false }
  | { act: false; refuse: "price-outside-bounds" }
  | { act: true; kind: "price" | "detach-and-price" };

/**
 * Whether fixed-price mode should write to this offer, and what that write is.
 *
 * Three facts decide it, in this order:
 *
 * - **The bounds still apply.** A Medusa price below the break-even floor or
 *   above the SRP ceiling is REFUSED, not clamped. Clamping would quietly sell at
 *   a price the store never set, and pushing it would sell below cost - the two
 *   failure modes the floor exists to prevent. It is reported as its own counted
 *   reason so an operator sees which variants are mispriced in Medusa rather than
 *   a silent no-op. The floor is passed through `roundAutomationFloor` again -
 *   idempotent on the already-rounded figure `evaluateSyncEligibility` hands over,
 *   and what keeps this function honest for a caller that passes a raw break-even.
 * - **An attached rule wins over a fixed price.** Allegro's engine recalculates
 *   the offer on its own schedule, so a price pushed under a live rule does not
 *   survive. The rule is removed first, and only then is the price set.
 * - **Otherwise, does the price already match?** The Buy Now price is READABLE on
 *   the offer, unlike a rule's price range, so fixed-price mode needs no audit
 *   memory: an offer already at the desired price with no rule attached is left
 *   alone. An offer whose price could not be read is written to rather than
 *   assumed correct, which is idempotent and the fail-closed direction.
 */
export const decideFixedPriceAction = (input: FixedPriceDecisionInput): FixedPriceDecision => {
  const cents = (value: number): number => Math.round(value * 100);
  const floor = roundAutomationFloor(input.bounds.floor);
  if (cents(input.desiredPrice) < cents(floor) || cents(input.desiredPrice) > cents(input.bounds.ceiling)) {
    return { act: false, refuse: "price-outside-bounds" };
  }
  if (input.attachedRuleId) {
    return { act: true, kind: "detach-and-price" };
  }
  if (input.observedPrice !== undefined && cents(input.observedPrice) === cents(input.desiredPrice)) {
    return { act: false };
  }
  return { act: true, kind: "price" };
};

/** Every skip reason at zero, for a run that has counted nothing yet. */
export const emptySkipCounts = (): Record<SyncSkipReason, number> => ({
  "invalid-bounds": 0,
  "missing-break-even": 0,
  "missing-medusa-price": 0,
  "missing-srp": 0,
  "not-linked": 0,
  "offer-not-active": 0,
  "price-outside-bounds": 0,
  "promotion-unresolved": 0,
  "status-unknown": 0,
  "sync-disabled": 0,
});
