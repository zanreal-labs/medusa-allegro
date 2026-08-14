import {
  boundsEqual,
  computeDrift,
  decideFixedPriceAction,
  decideSyncAction,
  emptySkipCounts,
  evaluateSyncEligibility,
  expectedRuleForPromoted,
  isTransition,
  promotionStateLabel,
  resolveExpectedRuleIds,
  resolvePriceMode,
  SYNC_SKIP_LABEL,
} from "../price-automation";
import type { AutomationRuleNames, SyncSkipReason } from "../price-automation";
import { roundAutomationFloor } from "../money";

const RULES: AutomationRuleNames = { promoted: "Store Sale", standard: "Store" };

describe("expectedRuleForPromoted", () => {
  it("selects the rule by promotion state", () => {
    expect(expectedRuleForPromoted(true, RULES)).toBe("Store Sale");
    expect(expectedRuleForPromoted(false, RULES)).toBe("Store");
  });
});

describe("promotionStateLabel", () => {
  it("distinguishes unresolved from not-promoted", () => {
    // The distinction is the point: an audit row saying "standard" asserts the
    // offer was observed as not promoted, which selects the standard commission
    // rate. "unknown" asserts nothing.
    expect(promotionStateLabel()).toBe("unknown");
    expect(promotionStateLabel(false)).toBe("standard");
    expect(promotionStateLabel(true)).toBe("promoted");
  });
});

describe("roundAutomationFloor", () => {
  it("ceils to a whole unit", () => {
    expect(roundAutomationFloor(45.01)).toBe(46);
    expect(roundAutomationFloor(45.99)).toBe(46);
  });

  it("leaves an exact whole value alone", () => {
    expect(roundAutomationFloor(45)).toBe(45);
  });

  it("does not let a binary artefact push the floor a whole unit up", () => {
    // 45.000000000000004 is what `33.62 * 1.23 / (1 - 0.1)`-shaped arithmetic
    // produces. Ceiling the raw float gives 46 - a full unit above the true
    // break-even, which prices the offer out of the market for no reason.
    expect(roundAutomationFloor(45.000_000_000_000_004)).toBe(45);
  });

  it("rounds to grosze before ceiling, so a sub-grosz excess is not a whole unit", () => {
    expect(roundAutomationFloor(45.0004)).toBe(45);
    expect(roundAutomationFloor(45.005)).toBe(46);
  });
});

describe("resolvePriceMode", () => {
  it("reports unknown when the offer was not observed", () => {
    expect(resolvePriceMode({ attachedRuleId: "r1", observed: false, status: "ACTIVE" })).toBe(
      "unknown",
    );
  });

  it("reports ended for any non-ACTIVE status, rule attached or not", () => {
    expect(resolvePriceMode({ observed: true, status: "ENDED" })).toBe("ended");
    expect(resolvePriceMode({ attachedRuleId: "r1", observed: true, status: "INACTIVE" })).toBe(
      "ended",
    );
    expect(resolvePriceMode({ observed: true, status: "GOING_TO_BE_ACTIVATED" })).toBe("ended");
  });

  it("reports automated when a rule is attached to an active offer", () => {
    expect(resolvePriceMode({ attachedRuleId: "r1", observed: true, status: "ACTIVE" })).toBe(
      "automated",
    );
  });

  it("reports fixed for an active offer with no rule", () => {
    expect(resolvePriceMode({ observed: true, status: "ACTIVE" })).toBe("fixed");
  });

  it("prefers paused over automated when a paused signal is present", () => {
    expect(
      resolvePriceMode({ attachedRuleId: "r1", observed: true, paused: true, status: "ACTIVE" }),
    ).toBe("paused");
  });

  it("treats an absent status as observed rather than ended", () => {
    // An absent publication block is not evidence the offer ended. The eligibility
    // ladder is where that ambiguity is refused (`status-unknown`); the mode read
    // must not silently claim "ended".
    expect(resolvePriceMode({ attachedRuleId: "r1", observed: true })).toBe("automated");
  });
});

describe("computeDrift", () => {
  it("never drifts on an unobserved offer", () => {
    expect(computeDrift({ priceMode: "unknown", promoted: true, rules: RULES })).toBe(false);
  });

  it("clears drift on an ended offer", () => {
    expect(
      computeDrift({
        attachedRuleName: "Something Else",
        priceMode: "ended",
        promoted: false,
        rules: RULES,
      }),
    ).toBe(false);
  });

  it("does not drift when the attached rule matches the promotion state", () => {
    expect(
      computeDrift({
        attachedRuleName: "Store Sale",
        priceMode: "automated",
        promoted: true,
        rules: RULES,
      }),
    ).toBe(false);
    expect(
      computeDrift({
        attachedRuleName: "Store",
        priceMode: "automated",
        promoted: false,
        rules: RULES,
      }),
    ).toBe(false);
  });

  it("surfaces a promotion flip as drift", () => {
    // A promoted offer still on the standard rule. This is the case the monitor
    // exists to catch, and it must never be auto-corrected by the monitor itself.
    expect(
      computeDrift({
        attachedRuleName: "Store",
        priceMode: "automated",
        promoted: true,
        rules: RULES,
      }),
    ).toBe(true);
  });

  it("surfaces an unresolvable rule id as drift", () => {
    // The rule id resolved to no name on the account, so `attachedRuleName` is
    // undefined. That is a real problem (the offer is on a rule nobody configured)
    // and it must not read as healthy.
    expect(computeDrift({ priceMode: "automated", promoted: false, rules: RULES })).toBe(true);
  });

  it("drifts for an active offer that should be automated but is not", () => {
    expect(computeDrift({ priceMode: "fixed", promoted: false, rules: RULES })).toBe(true);
    expect(computeDrift({ priceMode: "paused", promoted: true, rules: RULES })).toBe(true);
  });
});

describe("isTransition", () => {
  it("treats a first observation as a baseline, not a transition", () => {
    // Otherwise the initial sweep of a catalogue appends one audit row per offer,
    // which buries the transitions that matter.
    expect(isTransition(undefined, { priceMode: "automated", ruleId: "r1" })).toBe(false);
  });

  it("treats a prior unknown as a baseline too", () => {
    expect(isTransition({ priceMode: "unknown" }, { priceMode: "automated", ruleId: "r1" })).toBe(
      false,
    );
  });

  it("detects a mode change", () => {
    expect(isTransition({ priceMode: "fixed" }, { priceMode: "automated", ruleId: "r1" })).toBe(
      true,
    );
  });

  it("detects a rule swap at the same mode", () => {
    expect(
      isTransition(
        { priceMode: "automated", ruleId: "r1" },
        { priceMode: "automated", ruleId: "r2" },
      ),
    ).toBe(true);
  });

  it("is not a transition when nothing moved", () => {
    expect(
      isTransition(
        { priceMode: "automated", ruleId: "r1" },
        { priceMode: "automated", ruleId: "r1" },
      ),
    ).toBe(false);
  });

  it("normalizes undefined and null rule ids to the same absence", () => {
    expect(isTransition({ priceMode: "fixed", ruleId: undefined }, { priceMode: "fixed" })).toBe(
      false,
    );
  });
});

describe("evaluateSyncEligibility", () => {
  const eligible = {
    breakEvenPrice: 40,
    offerLinked: true,
    offerStatus: "ACTIVE" as const,
    priceSyncEnabled: true,
    promoted: false,
    srp: 100,
  };

  it("passes a fully resolved offer and returns rounded bounds", () => {
    const result = evaluateSyncEligibility({ ...eligible, breakEvenPrice: 40.2 });
    expect(result).toEqual({ ceiling: 100, eligible: true, floor: 41, promoted: false });
  });

  it("reports not-linked first, even when other data is also missing", () => {
    // The order of the ladder IS the reported reason. An unlinked SKU is not an
    // SRP problem, and reporting it as one sends an operator to the wrong screen.
    const result = evaluateSyncEligibility({
      ...eligible,
      breakEvenPrice: undefined,
      offerLinked: false,
      srp: undefined,
    });
    expect(result).toEqual({ eligible: false, reason: "not-linked" });
  });

  it("short-circuits on the per-offer opt-out before any data check", () => {
    // A disabled offer must never surface a spurious "missing break-even" for
    // somebody to chase.
    const result = evaluateSyncEligibility({
      ...eligible,
      breakEvenPrice: undefined,
      priceSyncEnabled: false,
      srp: undefined,
    });
    expect(result).toEqual({ eligible: false, reason: "sync-disabled" });
  });

  it("refuses an unreadable status rather than assuming it is active", () => {
    const result = evaluateSyncEligibility({ ...eligible, offerStatus: undefined });
    expect(result).toEqual({ eligible: false, reason: "status-unknown" });
  });

  it("refuses a non-ACTIVE offer", () => {
    const result = evaluateSyncEligibility({ ...eligible, offerStatus: "ENDED" });
    expect(result).toEqual({ eligible: false, reason: "offer-not-active" });
  });

  it("refuses an unresolved promotion state", () => {
    // The promotion state selects the commission rate, which sets the floor.
    // Guessing "not promoted" understates the commission and so understates the
    // floor - the unsafe direction.
    const result = evaluateSyncEligibility({ ...eligible, promoted: undefined });
    expect(result).toEqual({ eligible: false, reason: "promotion-unresolved" });
  });

  it("refuses a missing break-even instead of defaulting the floor", () => {
    const result = evaluateSyncEligibility({ ...eligible, breakEvenPrice: undefined });
    expect(result).toEqual({ eligible: false, reason: "missing-break-even" });
  });

  it("refuses a missing SRP instead of defaulting the ceiling", () => {
    const result = evaluateSyncEligibility({ ...eligible, srp: undefined });
    expect(result).toEqual({ eligible: false, reason: "missing-srp" });
  });

  it("checks the status before the promotion state", () => {
    const result = evaluateSyncEligibility({
      ...eligible,
      offerStatus: "ENDED",
      promoted: undefined,
    });
    expect(result).toEqual({ eligible: false, reason: "offer-not-active" });
  });

  it("checks break-even before SRP", () => {
    const result = evaluateSyncEligibility({
      ...eligible,
      breakEvenPrice: undefined,
      srp: undefined,
    });
    expect(result).toEqual({ eligible: false, reason: "missing-break-even" });
  });

  it("refuses an empty price range", () => {
    const result = evaluateSyncEligibility({ ...eligible, breakEvenPrice: 100, srp: 100 });
    expect(result).toEqual({ eligible: false, reason: "invalid-bounds" });
  });

  it("refuses a range the floor rounding inverts", () => {
    // Break-even 99.4 rounds up to a floor of 100, which is the SRP. The raw
    // numbers look fine; the bounds that would actually be sent do not.
    const result = evaluateSyncEligibility({ ...eligible, breakEvenPrice: 99.4, srp: 100 });
    expect(result).toEqual({ eligible: false, reason: "invalid-bounds" });
  });

  it("has a label for every skip reason", () => {
    // A counted reason with no sentence is a number nobody can act on.
    for (const reason of Object.keys(emptySkipCounts()) as SyncSkipReason[]) {
      expect(SYNC_SKIP_LABEL[reason]).toBeTruthy();
    }
  });
});

describe("resolveExpectedRuleIds", () => {
  it("resolves both names to ids", () => {
    expect(
      resolveExpectedRuleIds(
        [
          { id: "r-std", name: "Store" },
          { id: "r-promo", name: "Store Sale" },
        ],
        RULES,
      ),
    ).toEqual({ ok: true, promotedId: "r-promo", standardId: "r-std" });
  });

  it("fails loud on a missing standard rule", () => {
    const result = resolveExpectedRuleIds([{ id: "r-promo", name: "Store Sale" }], RULES);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"Store" was not found');
  });

  it("fails loud on a missing promoted rule", () => {
    const result = resolveExpectedRuleIds([{ id: "r-std", name: "Store" }], RULES);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"Store Sale" was not found');
  });

  it("fails loud on an ambiguous name rather than picking one", () => {
    // Two account rules sharing a name means the plugin does not know which
    // pricing policy the operator meant. Picking either attaches the wrong one to
    // a live catalogue.
    const result = resolveExpectedRuleIds(
      [
        { id: "r-a", name: "Store" },
        { id: "r-b", name: "Store" },
        { id: "r-promo", name: "Store Sale" },
      ],
      RULES,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("is ambiguous (2 rules share it)");
  });

  it("treats one rule listed twice under the same id as unambiguous", () => {
    // Duplicate entries for the SAME id are a listing artefact, not a
    // configuration problem: there is still exactly one rule.
    expect(
      resolveExpectedRuleIds(
        [
          { id: "r-std", name: "Store" },
          { id: "r-std", name: "Store" },
          { id: "r-promo", name: "Store Sale" },
        ],
        RULES,
      ),
    ).toEqual({ ok: true, promotedId: "r-promo", standardId: "r-std" });
  });

  it("ignores a matching rule that carries no id", () => {
    const result = resolveExpectedRuleIds(
      [{ name: "Store" }, { id: "r-promo", name: "Store Sale" }],
      RULES,
    );
    expect(result.ok).toBe(false);
  });

  it("reports the standard rule first when both are missing", () => {
    const result = resolveExpectedRuleIds([], RULES);
    expect(result.ok === false && result.error).toContain('"Store"');
  });
});

describe("boundsEqual", () => {
  it("compares at 2 decimal places", () => {
    expect(boundsEqual({ ceiling: 100, floor: 41 }, { ceiling: 100.001, floor: 41.004 })).toBe(
      true,
    );
  });

  it("separates a one-grosz difference", () => {
    expect(boundsEqual({ ceiling: 100, floor: 41 }, { ceiling: 100.01, floor: 41 })).toBe(false);
  });
});

describe("decideSyncAction", () => {
  const desiredBounds = { ceiling: 100, floor: 41 };

  it("attaches when no rule is present", () => {
    expect(decideSyncAction({ desiredBounds, promoted: false, rules: RULES })).toEqual({
      act: true,
      expectedRule: "Store",
      kind: "attach",
    });
  });

  it("switches on a promotion flip", () => {
    expect(
      decideSyncAction({
        attachedRuleId: "r-std",
        attachedRuleName: "Store",
        desiredBounds,
        promoted: true,
        rules: RULES,
      }),
    ).toEqual({ act: true, expectedRule: "Store Sale", kind: "switch" });
  });

  it("switches when the attached rule id resolves to no name", () => {
    // Re-asserting the expected rule is idempotent, so treating an unresolvable
    // id as a switch is both safe and self-healing.
    expect(
      decideSyncAction({
        attachedRuleId: "r-unknown",
        desiredBounds,
        promoted: false,
        rules: RULES,
      }),
    ).toEqual({ act: true, expectedRule: "Store", kind: "switch" });
  });

  it("re-pushes bounds when no successful push is on record", () => {
    // Allegro does not expose an attached rule's price range, so "the rule matches
    // and we have never recorded bounds" means the range is unknown, not correct.
    expect(
      decideSyncAction({
        attachedRuleId: "r-std",
        attachedRuleName: "Store",
        desiredBounds,
        promoted: false,
        rules: RULES,
      }),
    ).toEqual({ act: true, expectedRule: "Store", kind: "bounds" });
  });

  it("re-pushes bounds when the desired range drifted", () => {
    expect(
      decideSyncAction({
        attachedRuleId: "r-std",
        attachedRuleName: "Store",
        desiredBounds,
        lastPushedBounds: { ceiling: 100, floor: 39 },
        promoted: false,
        rules: RULES,
      }),
    ).toEqual({ act: true, expectedRule: "Store", kind: "bounds" });
  });

  it("does nothing when the rule matches and the recorded bounds match", () => {
    expect(
      decideSyncAction({
        attachedRuleId: "r-std",
        attachedRuleName: "Store",
        desiredBounds,
        lastPushedBounds: { ceiling: 100, floor: 41 },
        promoted: false,
        rules: RULES,
      }),
    ).toEqual({ act: false });
  });

  it("prefers a switch over a bounds push when both apply", () => {
    // A rule switch carries the bounds with it, so reporting "bounds" here would
    // hide the promotion flip from the audit trail.
    expect(
      decideSyncAction({
        attachedRuleId: "r-std",
        attachedRuleName: "Store",
        desiredBounds,
        lastPushedBounds: { ceiling: 100, floor: 39 },
        promoted: true,
        rules: RULES,
      }),
    ).toEqual({ act: true, expectedRule: "Store Sale", kind: "switch" });
  });
});

describe("decideFixedPriceAction", () => {
  /** The bounds `evaluateSyncEligibility` hands over: the floor is already rounded up. */
  const BOUNDS = { ceiling: 500, floor: 137 };

  it("sets the price on an offer with no rule attached", () => {
    expect(
      decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 300, observedPrice: 199.99 }),
    ).toEqual({ act: true, kind: "price" });
  });

  it("removes the rule first when one is attached", () => {
    // Allegro's engine recalculates on its own schedule, so a price pushed under a
    // live rule does not survive.
    expect(
      decideFixedPriceAction({
        attachedRuleId: "rule-standard",
        bounds: BOUNDS,
        desiredPrice: 300,
        observedPrice: 199.99,
      }),
    ).toEqual({ act: true, kind: "detach-and-price" });
  });

  it("leaves an offer alone once it already carries the price", () => {
    expect(
      decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 300, observedPrice: 300 }),
    ).toEqual({ act: false });
  });

  it("writes rather than assumes when the current price could not be read", () => {
    // Fail-closed and idempotent: re-setting a price that already matches costs one
    // command, whereas assuming a match leaves a wrong price up for ever.
    expect(decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 300 })).toEqual({
      act: true,
      kind: "price",
    });
  });

  it("still removes the rule on an offer already at the right price", () => {
    // The price matching is not the whole story: while the rule is attached, the
    // engine owns the price and will move it again.
    expect(
      decideFixedPriceAction({
        attachedRuleId: "rule-standard",
        bounds: BOUNDS,
        desiredPrice: 300,
        observedPrice: 300,
      }),
    ).toEqual({ act: true, kind: "detach-and-price" });
  });

  it("refuses a price below the break-even floor rather than clamping it", () => {
    // Clamping sells at a price the store never set; pushing sells below cost.
    // Refusing is the only answer that is neither.
    expect(
      decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 50, observedPrice: 199.99 }),
    ).toEqual({ act: false, refuse: "price-outside-bounds" });
  });

  it("refuses a price above the SRP ceiling", () => {
    expect(
      decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 900, observedPrice: 199.99 }),
    ).toEqual({ act: false, refuse: "price-outside-bounds" });
  });

  it("compares against the ROUNDED floor, so the two modes agree on where it is", () => {
    // `roundAutomationFloor` rounds a break-even UP to the next whole unit, and it
    // is what an automation rule's range would have been given. Applying it here
    // too means a price the rule path would have refused cannot slip through this
    // one, whichever of the two the caller handed over.
    const floor = 136.666;
    expect(roundAutomationFloor(floor)).toBe(137);
    expect(
      decideFixedPriceAction({ bounds: { ceiling: 500, floor }, desiredPrice: 136.99 }),
    ).toEqual({ act: false, refuse: "price-outside-bounds" });
    expect(
      decideFixedPriceAction({ bounds: { ceiling: 500, floor }, desiredPrice: 137 }),
    ).toEqual({ act: true, kind: "price" });
  });

  it("accepts a price exactly on either bound", () => {
    expect(decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 137 })).toEqual({
      act: true,
      kind: "price",
    });
    expect(decideFixedPriceAction({ bounds: BOUNDS, desiredPrice: 500 })).toEqual({
      act: true,
      kind: "price",
    });
  });
});
