import { AllegroApiError } from "../../lib/allegro/errors";
import type { PriceAutomationRule } from "../../lib/allegro/types";
import { runPriceAutomationMonitor } from "../run-price-automation-monitor";
import { ACCOUNT_RULES, fakeAllegroService, fakeContainer, offerFixture, RULES } from "./fixtures";
import type { OfferRowFixture } from "./fixtures";

const client = (
  over: {
    rules?: PriceAutomationRule[];
    rulesError?: Error;
    offers?: ReturnType<typeof offerFixture>[];
  } = {},
) => ({
  listOffers: () =>
    Promise.resolve({
      count: (over.offers ?? []).length,
      offers: over.offers ?? [],
      totalCount: (over.offers ?? []).length,
    }),
  listPriceAutomationRules: () => {
    if (over.rulesError) {
      return Promise.reject(over.rulesError);
    }
    return Promise.resolve({ rules: over.rules ?? ACCOUNT_RULES });
  },
});

const run = async (input: {
  offers?: OfferRowFixture[];
  live?: ReturnType<typeof offerFixture>[];
  rules?: PriceAutomationRule[];
  rulesError?: Error;
  rulesConfigured?: boolean;
}) => {
  const allegro = fakeAllegroService({
    client: client({ offers: input.live, rules: input.rules, rulesError: input.rulesError }),
    offers: input.offers ?? [],
    syncOptions: (input.rulesConfigured === false ? {} : { automationRules: { ...RULES } }),
  });
  const container = fakeContainer({ allegro });
  const result = await runPriceAutomationMonitor(container as never);
  return { allegro, result };
};

describe("runPriceAutomationMonitor", () => {
  it("records the observed automation state on the mapping row", async () => {
    const { allegro, result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });

    expect(result).toMatchObject({ drift: 0, scanned: 1, updated: 1 });
    expect(allegro.offers[0]).toMatchObject({
      automation_rule: RULES.standard,
      automation_rule_id: "rule-standard",
      price_automation_drift: false,
      price_mode: "automated",
    });
    expect(allegro.offers[0]?.automation_synced_at).toBeInstanceOf(Date);
  });

  it("reports an active offer with no rule as fixed, and as drift", async () => {
    const { allegro, result } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(result.drift).toBe(1);
    expect(allegro.offers[0]).toMatchObject({ price_automation_drift: true, price_mode: "fixed" });
    expect(result.error).toContain("drift from the expected price-automation rule");
  });

  it("surfaces a promotion flip as drift", async () => {
    // A promoted offer still on the standard rule. The monitor never corrects it -
    // it makes it visible so an operator sees it before the write loop acts.
    const { result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
    });
    expect(result.drift).toBe(1);
  });

  it("reports a non-ACTIVE offer as ended and clears its drift", async () => {
    const { allegro, result } = await run({
      live: [offerFixture({ id: "o1", publication: { status: "ENDED" } })],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(result.drift).toBe(0);
    expect(allegro.offers[0]?.price_mode).toBe("ended");
  });

  it("appends no audit row on a first observation", async () => {
    // A baseline, not a transition. Otherwise the initial sweep of a catalogue
    // appends one row per offer and buries the transitions that matter.
    const { allegro, result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(result.transitions).toBe(0);
    expect(allegro.pushes).toEqual([]);
  });

  it("appends an observed audit row on a real transition", async () => {
    const { allegro, result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-promoted" } } },
        }),
      ],
      offers: [
        {
          automation_rule: RULES.standard,
          automation_rule_id: "rule-standard",
          automation_synced_at: new Date("2026-06-01T00:00:00.000Z"),
          id: "row-1",
          offer_id: "o1",
          price_mode: "automated",
          sku: "SKU-1",
        },
      ],
    });

    expect(result.transitions).toBe(1);
    expect(allegro.pushes[0]).toMatchObject({
      // `observed`, not `success`: nothing was written to Allegro. The bounds memory
      // reads only `success` rows, so this must not look like a push.
      price_mode_new: "automated",
      price_mode_old: "automated",
      pushed_by: "price-automation-monitor",
      result: "observed",
      rule_id_new: "rule-promoted",
      rule_id_old: "rule-standard",
      rule_name_new: RULES.promoted,
      rule_name_old: RULES.standard,
      sku: "SKU-1",
    });
  });

  it("writes nothing when the observed state already matches", async () => {
    const { result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [
        {
          automation_rule: RULES.standard,
          automation_rule_id: "rule-standard",
          automation_synced_at: new Date("2026-06-01T00:00:00.000Z"),
          id: "row-1",
          offer_id: "o1",
          price_automation_drift: false,
          price_mode: "automated",
          sku: "SKU-1",
        },
      ],
    });
    expect(result).toMatchObject({ scanned: 1, transitions: 0, updated: 0 });
  });

  it("writes a never-observed row even when every other column coincidentally matches", async () => {
    // Otherwise `automation_synced_at` keeps reading as "never looked at" forever,
    // and staleness is the monitor's only honest health signal.
    const { result } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [
        {
          automation_synced_at: null,
          id: "row-1",
          offer_id: "o1",
          price_automation_drift: true,
          price_mode: "fixed",
          sku: "SKU-1",
        },
      ],
    });
    expect(result.updated).toBe(1);
  });

  it("leaves a linked offer absent from the listing untouched", async () => {
    // Discovery's unlink pass owns clearing a stale link, and it has the
    // empty-response guard that makes that safe. The monitor must not guess.
    const { allegro, result } = await run({
      live: [],
      offers: [{ id: "row-1", offer_id: "o-gone", price_mode: "automated", sku: "SKU-1" }],
    });
    expect(result).toMatchObject({ notObserved: 1, scanned: 0, updated: 0 });
    expect(allegro.offers[0]?.price_mode).toBe("automated");
  });

  it("skips an unlinked mapping row entirely", async () => {
    const { result } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [{ id: "row-1", offer_id: null, sku: "SKU-1" }],
    });
    expect(result).toMatchObject({ notObserved: 0, scanned: 0 });
  });

  it("aborts the whole sweep with zero writes on a systemic rules failure", async () => {
    // A 429 means the observation is unreliable, not that these offers have no
    // rules. Writing "no rule attached" across the catalogue would be an actively
    // false signal the write loop would then act on.
    const { allegro, result } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [{ id: "row-1", offer_id: "o1", price_mode: "automated", sku: "SKU-1" }],
      rulesError: new AllegroApiError({ httpStatus: 429, message: "Too many requests" }),
    });

    expect(result.systemic).toBe(true);
    expect(result.scanned).toBe(0);
    expect(allegro.offers[0]?.price_mode).toBe("automated");
    expect(allegro.states.get("price-automation")).toMatchObject({ status: "error" });
  });

  it("skips the sweep when the rules resource is not provisioned", async () => {
    const { result } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      rulesError: new AllegroApiError({ httpStatus: 400, message: "Feature unavailable" }),
    });
    expect(result.featureUnavailable).toBe(true);
    expect(result.systemic).toBe(false);
    expect(result.scanned).toBe(0);
  });

  it("still records the mode and rule name with no rules configured, but no drift", async () => {
    // Observing a catalogue is useful before the two rules are chosen; drift needs
    // an expectation to drift FROM, so it is false rather than a guess.
    const { allegro, result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
      rulesConfigured: false,
    });

    expect(result.rulesNotConfigured).toBe(true);
    expect(result.drift).toBe(0);
    expect(allegro.offers[0]).toMatchObject({
      automation_rule: RULES.standard,
      price_automation_drift: false,
      price_mode: "automated",
    });
    expect(result.error).toContain("`automationRules` option is not configured");
  });

  it("leaves the rule name undefined when the attached id is not on the account", async () => {
    // Which is itself drift: the offer is priced by a rule nobody configured.
    const { allegro, result } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-unknown" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(allegro.offers[0]).toMatchObject({
      automation_rule: null,
      automation_rule_id: "rule-unknown",
      price_automation_drift: true,
    });
    expect(result.drift).toBe(1);
  });

  it("records its counters on the state row", async () => {
    const { allegro } = await run({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { priceAutomation: { rule: { id: "rule-standard" } } },
        }),
      ],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    const state = allegro.states.get("price-automation");
    expect(state).toMatchObject({ last_error: null, status: "ok" });
    expect(state?.counts).toMatchObject({ scanned: 1, updated: 1 });
  });

  it("takes only the price-automation claim", async () => {
    const { allegro } = await run({
      live: [offerFixture({ id: "o1" })],
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(allegro.claims).toEqual(["price-automation"]);
  });
});
