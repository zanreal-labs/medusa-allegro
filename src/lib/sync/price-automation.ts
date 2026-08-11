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
  | "invalid-bounds";

/** Human sentence for a skip reason, for logs and the admin. */
export const SYNC_SKIP_LABEL: Record<SyncSkipReason, string> = {
  "invalid-bounds": "break-even floor is at or above the SRP ceiling",
  "missing-break-even":
    "missing break-even price (needs a purchase cost and a category commission rate)",
  "missing-srp": "missing SRP (the ceiling bound)",
  "not-linked": "not linked to an Allegro offer",
  "offer-not-active": "linked offer is not ACTIVE",
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
   * Bounds recorded on the LAST SUCCESSFUL push for this offer
   * (`allegro_price_push.bound_floor` / `bound_ceiling`). Undefined when no
   * successful bounds-carrying push is on record.
   */
  lastPushedBounds?: SyncBounds;
  rules: AutomationRuleNames;
}

export type SyncDecision =
  | { act: false }
  | { act: true; kind: "attach" | "switch" | "bounds"; expectedRule: string };

/**
 * Whether the loop should issue a command for this offer, and why.
 *
 * Allegro exposes an offer's attached rule id but NOT the price range attached
 * to it: `configuration.priceRange` is writable through the command and readable
 * nowhere. The audit trail is therefore the only bounds memory there is, which
 * is why `lastPushedBounds` comes from the last successful push row rather than
 * from the offer.
 *
 * The triggers:
 *
 * - `attach` - no rule attached at all.
 * - `switch` - the attached rule's name differs from the expected one. A
 *   promotion flip lands here, and so does an attached id that resolves to no
 *   name on the account: re-asserting the expected rule is idempotent, so
 *   treating an unresolvable id as a switch is both safe and self-healing.
 * - `bounds` - the rule already matches, but either no successful
 *   bounds-carrying push is on record (attached outside this plugin, or before
 *   the bounds columns existed) or the desired bounds have drifted from the
 *   recorded ones because the cost or the SRP moved.
 *
 * Only an offer on the right rule whose last successful push carries exactly the
 * desired bounds is left alone. The per-run change cap, not this function, is
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
  if (!(input.lastPushedBounds && boundsEqual(input.lastPushedBounds, input.desiredBounds))) {
    return { act: true, expectedRule, kind: "bounds" };
  }
  return { act: false };
};

/** Every skip reason at zero, for a run that has counted nothing yet. */
export const emptySkipCounts = (): Record<SyncSkipReason, number> => ({
  "invalid-bounds": 0,
  "missing-break-even": 0,
  "missing-srp": 0,
  "not-linked": 0,
  "offer-not-active": 0,
  "promotion-unresolved": 0,
  "status-unknown": 0,
  "sync-disabled": 0,
});
