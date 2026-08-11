import { AllegroAuthError } from "../../lib/allegro/auth-error";
import { AllegroApiError } from "../../lib/allegro/errors";
import type { AllegroOffer, PriceAutomationRule } from "../../lib/allegro/types";
import { QUARANTINE_AFTER_FAILURES } from "../../lib/sync/failure-state";
import { pushSingleAllegroOffer, syncAllegroPrices } from "../sync-allegro-prices";
import {
  ACCOUNT_RULES,
  fakeAllegroService,
  fakeContainer,
  fakeCostsService,
  offerFixture,
  RULES,
} from "./fixtures";
import type {
  CategoryRateFixture,
  OfferRowFixture,
  PushRowFixture,
  StateRowFixture,
  VariantFixture,
} from "./fixtures";

/** A `since` inside both TTL windows, so a fixture cannot rot with wall-clock time. */
const RECENT = new Date(Date.now() - 60_000).toISOString();

interface CommandScript {
  /** Thrown from `assignOfferPriceAutomation` for the given offer id. */
  throwFor?: Record<string, Error>;
  /** Task tally reported for the given offer id; defaults to one success. */
  tallyFor?: Record<string, { failed: number; success: number; total: number }>;
  /** Offers whose command never reaches a terminal state. */
  pendingFor?: string[];
  /**
   * Offers whose command is still IN PROGRESS at the poll budget: Allegro has
   * scheduled the task and finished none of it (`total: 1, success: 0, failed: 0`)
   * and `completedAt` is still null.
   *
   * Distinct from `pendingFor`, and the distinction is the whole point: this shape
   * satisfied the loop's old local terminality test (`taskCount.total > 0`) while
   * failing the SDK's real one, so it was recorded as a confirmed success.
   */
  inProgressFor?: string[];
  /** Offers whose command reports `completedAt` but carries no task tally at all. */
  noTallyFor?: string[];
}

const fakeClient = (input: {
  offers?: AllegroOffer[];
  rules?: PriceAutomationRule[];
  rulesError?: Error;
  script?: CommandScript;
}) => {
  const commands: { offerId: string; ruleId: string; min?: string; max?: string }[] = [];
  const script = input.script ?? {};
  const offerIdByCommand = new Map<string, string>();
  let sequence = 0;

  return {
    assignOfferPriceAutomation: (params: {
      offerId: string;
      ruleId: string;
      bounds?: { min: { amount: string }; max: { amount: string } };
    }) => {
      const failure = script.throwFor?.[params.offerId];
      if (failure) {
        return Promise.reject(failure);
      }
      sequence += 1;
      const commandId = `cmd-${sequence}`;
      offerIdByCommand.set(commandId, params.offerId);
      commands.push({
        max: params.bounds?.max.amount,
        min: params.bounds?.min.amount,
        offerId: params.offerId,
        ruleId: params.ruleId,
      });
      return Promise.resolve({ id: commandId });
    },
    commands,
    getOffer: (offerId: string) =>
      Promise.resolve(
        (input.offers ?? []).find((offer) => offer.id === offerId) ?? offerFixture({ id: offerId }),
      ),
    getOfferPriceAutomationCommandTasks: () =>
      Promise.resolve({ tasks: [{ message: "rejected by Allegro", status: "FAIL" as const }] }),
    listOffers: () =>
      Promise.resolve({
        count: (input.offers ?? []).length,
        offers: input.offers ?? [],
        totalCount: (input.offers ?? []).length,
      }),
    listPriceAutomationRules: () => {
      if (input.rulesError) {
        return Promise.reject(input.rulesError);
      }
      return Promise.resolve({ rules: input.rules ?? ACCOUNT_RULES });
    },
    pollOfferPriceAutomationCommand: (commandId: string) => {
      const offerId = offerIdByCommand.get(commandId) ?? "";
      if (script.pendingFor?.includes(offerId)) {
        return Promise.resolve({ completedAt: null, id: commandId });
      }
      if (script.inProgressFor?.includes(offerId)) {
        // Scheduled, not finished. `total > 0` but `success + failed < total`.
        return Promise.resolve({
          completedAt: null,
          id: commandId,
          taskCount: { failed: 0, success: 0, total: 1 },
        });
      }
      if (script.noTallyFor?.includes(offerId)) {
        return Promise.resolve({ completedAt: "2026-06-01T00:00:00.000Z", id: commandId });
      }
      return Promise.resolve({
        completedAt: "2026-06-01T00:00:00.000Z",
        id: commandId,
        taskCount: script.tallyFor?.[offerId] ?? { failed: 0, success: 1, total: 1 },
      });
    },
  };
};

const CAT_RATES: CategoryRateFixture[] = [
  { category_id: "cat-1", commission_rate: 10, id: "r1", promoted_commission_rate: 15 },
];

const setup = (input: {
  rows?: OfferRowFixture[];
  live?: AllegroOffer[];
  variants?: VariantFixture[];
  costs?: Record<string, number>;
  categories?: CategoryRateFixture[];
  pushes?: PushRowFixture[];
  states?: StateRowFixture[];
  script?: CommandScript;
  rules?: PriceAutomationRule[];
  rulesError?: Error;
  syncOptions?: Record<string, unknown>;
  priceSyncDisabled?: boolean;
  noCosts?: boolean;
}) => {
  const client = fakeClient({
    offers: input.live,
    rules: input.rules,
    rulesError: input.rulesError,
    script: input.script,
  });
  const allegro = fakeAllegroService({
    categories: input.categories ?? CAT_RATES,
    client,
    offers: input.rows ?? [],
    priceSyncDisabled: input.priceSyncDisabled,
    pushes: input.pushes ?? [],
    states: input.states ?? [],
    syncOptions: {
      automationRules: { ...RULES },
      srpMetadataKey: "srp",
      ...input.syncOptions,
    },
  });
  const logs: string[] = [];
  const container = fakeContainer({
    allegro,
    ...(input.noCosts ? {} : { costs: fakeCostsService(input.costs ?? { "SKU-1": 100 }) }),
    logs,
    variants: input.variants ?? [{ id: "v1", metadata: { srp: 500 }, sku: "SKU-1" }],
  });
  return { allegro, client, container, logs };
};

/** A healthy, fully-resolvable single-offer setup. */
const healthy = (over: Partial<Parameters<typeof setup>[0]> = {}) =>
  setup({
    live: [offerFixture({ id: "o1" })],
    rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" }],
    ...over,
  });

describe("syncAllegroPrices: command terminality", () => {
  it("treats an in-progress command at the poll budget as PENDING, not a success", async () => {
    // The regression this pins is the worst failure mode in the loop. The local test
    // was `completedAt || taskCount.total > 0`, which an in-progress command satisfies
    // (total 1, success 0, failed 0). It therefore reached the success path: stamped
    // `price_synced_at`, wrote `result: "success"` with the bounds, and so taught
    // `fetchLastSuccessfulBounds` that those bounds had LANDED. `decideSyncAction` then
    // answered `act: false` on every subsequent run and the offer was never corrected
    // again - silently, forever.
    const { allegro, container } = healthy({ script: { inProgressFor: ["o1"] } });

    const summary = await syncAllegroPrices(container as never);

    expect(summary).toMatchObject({ failed: 0, pending: 1, synced: 0 });
    // No success row: the bounds memory must not learn these bounds.
    expect(allegro.pushes.filter((row) => row.result === "success")).toHaveLength(0);
    expect(allegro.pushes[0]).toMatchObject({
      allegro_command_id: "cmd-1",
      error: "not terminal within the poll budget",
      result: "skipped",
    });
    // And no synced stamp, so the admin does not claim a push that was not confirmed.
    expect(allegro.offers[0]?.price_synced_at).toBeUndefined();
  });

  it("re-pushes on the next run after a pending command, because nothing was recorded", async () => {
    // The consequence of the above, and the reason `skipped` is safe: an unconfirmed
    // push leaves no success bounds, so the next tick plans the same command again.
    // Re-asserting a rule and a range is idempotent.
    const { allegro, client, container } = healthy({ script: { inProgressFor: ["o1"] } });

    await syncAllegroPrices(container as never);
    await syncAllegroPrices(container as never);

    expect(client.commands).toHaveLength(2);
    expect(allegro.pushes.filter((row) => row.result === "success")).toHaveLength(0);
  });

  it("treats a terminal command carrying no task tally as pending, not a success", async () => {
    // `completedAt` set with no `taskCount` is not evidence that the offer's task
    // succeeded. Success is asserted on positive evidence only.
    const { allegro, container } = healthy({ script: { noTallyFor: ["o1"] } });

    const summary = await syncAllegroPrices(container as never);

    expect(summary).toMatchObject({ failed: 0, pending: 1, synced: 0 });
    expect(allegro.pushes[0]).toMatchObject({ result: "skipped" });
    expect(allegro.offers[0]?.price_synced_at).toBeUndefined();
  });

  it("treats a command that scheduled no task at all as failed", async () => {
    // Terminal, zero failures, and zero successes: the offer criteria matched nothing,
    // so nothing was attached. Counting it as a success is how an unattached offer
    // reads as managed.
    const { allegro, container } = healthy({
      script: { tallyFor: { o1: { failed: 0, success: 0, total: 0 } } },
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary).toMatchObject({ pending: 0, synced: 0 });
    expect(summary.failed).toBe(1);
    expect(allegro.pushes[0]).toMatchObject({
      error: "command completed without scheduling a task for the offer",
      result: "failed",
    });
    expect(allegro.offers[0]?.price_synced_at).toBeUndefined();
  });
});

describe("syncAllegroPrices: the write decision", () => {
  it("attaches the standard rule with the computed bounds", async () => {
    // net 100 at 23% VAT is 123 gross; a 10% commission gives 123/0.9 = 136.67, and
    // the floor ceils to a whole unit: 137. The ceiling is the SRP verbatim.
    const { allegro, client, container } = healthy();

    const summary = await syncAllegroPrices(container as never);

    expect(summary).toMatchObject({ alreadyInSync: 0, failed: 0, scanned: 1, synced: 1 });
    expect(client.commands).toEqual([
      { max: "500.00", min: "137.00", offerId: "o1", ruleId: "rule-standard" },
    ]);
    expect(allegro.pushes[0]).toMatchObject({
      bound_ceiling: "500.00",
      bound_floor: "137.00",
      offer_id: "o1",
      promotion_state: "standard",
      result: "success",
      rule_name_new: RULES.standard,
      sku: "SKU-1",
    });
    expect(allegro.offers[0]?.price_synced_at).toBeInstanceOf(Date);
  });

  it("uses the promoted rule and the promoted commission rate", async () => {
    // 123 / (1 - 0.15) = 144.71, ceiling to 145. A promoted offer floored on the
    // standard rate would be floored too low, which is the unsafe direction.
    const { client } = await runWith({
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
    });
    expect(client.commands[0]).toMatchObject({ min: "145.00", ruleId: "rule-promoted" });
  });

  it("does nothing when the rule and the recorded bounds already match", async () => {
    const { allegro, client } = await runWith({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      pushes: [
        {
          bound_ceiling: "500.00",
          bound_floor: "137.00",
          id: "algpush_1",
          offer_id: "o1",
          pushed_at: new Date("2026-06-01T00:00:00.000Z"),
          result: "success",
          sku: "SKU-1",
        },
      ],
    });
    expect(client.commands).toEqual([]);
    expect(allegro.pushes).toHaveLength(1);
  });

  it("re-pushes bounds when the rule matches but no successful push is on record", async () => {
    // Allegro does not expose an attached rule's range, so "no bounds recorded"
    // means the range is unknown, not correct.
    const { client } = await runWith({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
    });
    expect(client.commands).toHaveLength(1);
  });

  it("ignores an observed audit row when reading bounds memory", async () => {
    // The monitor's `observed` rows record state it did not write. Reading them as
    // bounds memory would claim a range this plugin never pushed.
    const { client } = await runWith({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      pushes: [
        {
          bound_ceiling: "500.00",
          bound_floor: "137.00",
          id: "algpush_1",
          offer_id: "o1",
          pushed_at: new Date("2026-06-01T00:00:00.000Z"),
          result: "observed",
          sku: "SKU-1",
        },
      ],
    });
    expect(client.commands).toHaveLength(1);
  });

  it("treats a newer success without bounds as no bounds on record", async () => {
    // Newest-first, first-success-wins: a later success that carries no bounds
    // claims the slot, so an older row's stale bounds cannot look current.
    const { client } = await runWith({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      pushes: [
        {
          bound_ceiling: "500.00",
          bound_floor: "137.00",
          id: "algpush_1",
          offer_id: "o1",
          pushed_at: new Date("2026-06-01T00:00:00.000Z"),
          result: "success",
          sku: "SKU-1",
        },
        {
          id: "algpush_2",
          offer_id: "o1",
          pushed_at: new Date("2026-06-02T00:00:00.000Z"),
          result: "success",
          sku: "SKU-1",
        },
      ],
    });
    expect(client.commands).toHaveLength(1);
  });

  it("switches the rule on a promotion flip", async () => {
    const { allegro, client } = await runWith({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
    });
    expect(client.commands[0]?.ruleId).toBe("rule-promoted");
    expect(allegro.pushes[0]).toMatchObject({
      rule_id_old: "rule-standard",
      rule_name_new: RULES.promoted,
      rule_name_old: RULES.standard,
    });
  });
});

describe("syncAllegroPrices: skip reasons", () => {
  it("skips an unlinked mapping row", async () => {
    const { summary } = await runWith({
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: null, promoted: false, sku: "SKU-1" }],
    });
    expect(summary.skippedCounts["not-linked"]).toBe(1);
    expect(summary.scanned).toBe(0);
  });

  it("skips a per-offer opt-out", async () => {
    const { client, summary } = await runWith({
      rows: [
        {
          category_id: "cat-1",
          id: "row-1",
          offer_id: "o1",
          price_sync_enabled: false,
          promoted: false,
          sku: "SKU-1",
        },
      ],
    });
    expect(summary.skippedCounts["sync-disabled"]).toBe(1);
    expect(client.commands).toEqual([]);
  });

  it("skips a non-ACTIVE offer", async () => {
    const { summary } = await runWith({
      live: [offerFixture({ id: "o1", publication: { status: "ENDED" } })],
    });
    expect(summary.skippedCounts["offer-not-active"]).toBe(1);
  });

  it("skips an offer whose status could not be read", async () => {
    const { summary } = await runWith({ live: [offerFixture({ id: "o1", publication: {} })] });
    expect(summary.skippedCounts["status-unknown"]).toBe(1);
  });

  it("skips an unresolved promotion state, stored as NULL", async () => {
    // `promoted: null` EXPLICITLY, and that is the point of the fix. This test used to
    // omit the key, so the fake produced `undefined` and the gate fired - but the column
    // was `boolean NOT NULL default false`, so the database could never hand the loop an
    // undefined. The test passed while the behaviour it described was unreachable in
    // production, and every row with an unresolved promo sweep priced at the STANDARD
    // commission instead, giving promoted offers a floor below their true break-even.
    const { client, summary } = await runWith({
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: null, sku: "SKU-1" }],
    });

    expect(summary.skippedCounts["promotion-unresolved"]).toBe(1);
    // Skipped means NOTHING was pushed: no command, so no floor computed on a guessed
    // commission rate.
    expect(client.commands).toEqual([]);
    expect(summary.synced).toBe(0);
  });

  it("skips a row that never carried the promotion key at all", async () => {
    // Belt and braces on the same gate: an absent key and a NULL must behave alike, so a
    // row written by an older version cannot slip through as "standard".
    const { summary } = await runWith({
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(summary.skippedCounts["promotion-unresolved"]).toBe(1);
  });

  it("skips with missing-break-even when no costs module is registered", async () => {
    // A soft dependency: an absent costs plugin is a supported configuration, and it
    // must never produce a defaulted floor.
    const { client, summary } = await runWith({ noCosts: true });
    expect(summary.skippedCounts["missing-break-even"]).toBe(1);
    expect(client.commands).toEqual([]);
  });

  it("skips with missing-break-even when the SKU has no cost on file", async () => {
    const { summary } = await runWith({ costs: {} });
    expect(summary.skippedCounts["missing-break-even"]).toBe(1);
  });

  it("skips with missing-break-even when the category has no rate row", async () => {
    const { summary } = await runWith({ categories: [] });
    expect(summary.skippedCounts["missing-break-even"]).toBe(1);
  });

  it("skips a promoted offer whose promoted rate is blank even when the standard one is set", async () => {
    // The case a single "has a rate row?" check would get wrong: the standard rate
    // is filled in, the promoted one is not, and flooring on the standard rate would
    // under-floor every promoted offer in the category.
    const { summary } = await runWith({
      categories: [
        { category_id: "cat-1", commission_rate: 10, id: "r1", promoted_commission_rate: null },
      ],
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: true, sku: "SKU-1" }],
    });
    expect(summary.skippedCounts["missing-break-even"]).toBe(1);
  });

  it("skips with missing-srp when no SRP source is configured", async () => {
    const { logs, summary } = await runWith({ syncOptions: { srpMetadataKey: undefined } });
    expect(summary.skippedCounts["missing-srp"]).toBe(1);
    // Worth a dedicated warning: the symptom is a whole catalogue skipped, which
    // reads like a data problem rather than a configuration one.
    expect(logs.some((line) => line.includes("no SRP source is configured"))).toBe(true);
  });

  it("skips with missing-srp when the variant carries no value under the key", async () => {
    const { summary } = await runWith({ variants: [{ id: "v1", sku: "SKU-1" }] });
    expect(summary.skippedCounts["missing-srp"]).toBe(1);
  });

  it("warns when a write loop is armed over an unscoped catalogue", async () => {
    // An unset sales channel makes EVERY variant with a SKU eligible, and no
    // per-offer counter can express that: the run reports a clean success and the
    // only symptom is on Allegro. So it has to be said out loud.
    const { logs } = await runWith({});
    expect(logs.some((line) => line.includes("no sales channel is configured"))).toBe(true);
  });

  it("does not warn about scope when a sales channel is configured", async () => {
    const { logs } = await runWith({ syncOptions: { salesChannelId: "sc_allegro" } });
    expect(logs.some((line) => line.includes("no sales channel is configured"))).toBe(false);
  });

  it("reads the SRP from a price list when one is configured", async () => {
    const allegro = fakeAllegroService({
      categories: CAT_RATES,
      client: fakeClient({ offers: [offerFixture({ id: "o1" })] }),
      offers: [
        { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
      ],
      syncOptions: { automationRules: { ...RULES }, srpPriceListId: "plist_1" },
    });
    const container = fakeContainer({
      allegro,
      costs: fakeCostsService({ "SKU-1": 100 }),
      priceListPrices: [{ amount: 420, variantId: "v1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.synced).toBe(1);
    expect(summary.skippedCounts["missing-srp"]).toBe(0);
  });

  it("skips an inverted range", async () => {
    const { summary } = await runWith({
      variants: [{ id: "v1", metadata: { srp: 100 }, sku: "SKU-1" }],
    });
    expect(summary.skippedCounts["invalid-bounds"]).toBe(1);
  });

  it("holds a conflicted mapping out and counts it separately", async () => {
    const { client, summary } = await runWith({
      rows: [
        {
          category_id: "cat-1",
          conflict: "duplicate-sku",
          id: "row-1",
          offer_id: "o1",
          promoted: false,
          sku: "SKU-1",
        },
      ],
    });
    expect(summary.conflicted).toBe(1);
    expect(client.commands).toEqual([]);
    expect(summary.error).toContain("mapping carries a conflict");
  });
});

describe("syncAllegroPrices: fail-loud rule resolution", () => {
  it("writes nothing when a configured rule is missing from the account", async () => {
    const { allegro, client, summary } = await runWith({
      rules: [{ id: "rule-standard", name: RULES.standard }],
    });
    expect(client.commands).toEqual([]);
    expect(allegro.pushes).toEqual([]);
    expect(summary.error).toContain('"Store Sale" was not found');
    expect(allegro.states.get("prices")).toMatchObject({ status: "error" });
  });

  it("writes nothing when a rule name is ambiguous", async () => {
    const { client, summary } = await runWith({
      rules: [
        { id: "rule-a", name: RULES.standard },
        { id: "rule-b", name: RULES.standard },
        { id: "rule-promoted", name: RULES.promoted },
      ],
    });
    expect(client.commands).toEqual([]);
    expect(summary.error).toContain("is ambiguous");
  });

  it("stays inert with no automationRules option, and says so", async () => {
    const { client, summary } = await runWith({ syncOptions: { automationRules: undefined } });
    expect(client.commands).toEqual([]);
    expect(summary.error).toContain("`automationRules` option is not configured");
  });
});

describe("syncAllegroPrices: the change cap", () => {
  it("caps the run and leaves the remainder for the next tick", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      category_id: "cat-1",
      id: `row-${index}`,
      offer_id: `o${index}`,
      promoted: false,
      sku: `SKU-${index}`,
    }));
    const { client, summary } = await runWith({
      costs: Object.fromEntries(rows.map((row) => [row.sku, 100])),
      live: rows.map((row) => offerFixture({ id: row.offer_id })),
      rows,
      syncOptions: { changeCap: 2 },
      variants: rows.map((row, index) => ({
        id: `v${index}`,
        metadata: { srp: 500 },
        sku: row.sku,
      })),
    });

    expect(summary.capped).toBe(true);
    expect(client.commands).toHaveLength(2);
    expect(summary.synced).toBe(2);
  });
});

describe("syncAllegroPrices: the circuit breaker", () => {
  it("stops at the first 403 and records the write-scope gap without quarantining", async () => {
    // One systemic condition, not a hundred bad offers. Quarantining the catalogue
    // over a configuration problem one reconnect fixes would be the worse failure.
    const rows = Array.from({ length: 3 }, (_, index) => ({
      category_id: "cat-1",
      id: `row-${index}`,
      offer_id: `o${index}`,
      promoted: false,
      sku: `SKU-${index}`,
    }));
    const { allegro, client, summary } = await runWith({
      costs: Object.fromEntries(rows.map((row) => [row.sku, 100])),
      live: rows.map((row) => offerFixture({ id: row.offer_id })),
      rows,
      script: {
        throwFor: {
          o0: new AllegroApiError({ httpStatus: 403, message: "Forbidden" }),
        },
      },
      variants: rows.map((row, index) => ({
        id: `v${index}`,
        metadata: { srp: 500 },
        sku: row.sku,
      })),
    });

    expect(client.commands).toEqual([]);
    expect(summary.writeScopeMissing).toBe(true);
    expect(summary.systemic).toBe(true);
    expect(summary.quarantined).toEqual([]);
    expect(summary.error).toContain("WRITE_SCOPE_MISSING");
    expect(allegro.states.get("prices")).toMatchObject({ write_scope_missing: true });
  });

  it("clears a stale write-scope flag once a command gets a non-403 response", async () => {
    const { allegro, summary } = await runWith({
      states: [{ provider: "prices", status: "ok", write_scope_missing: true }],
    });
    expect(summary.writeScopeMissing).toBe(false);
    expect(allegro.states.get("prices")).toMatchObject({ write_scope_missing: false });
  });

  it("leaves the write-scope flag untouched on a run that issued no command", async () => {
    const { allegro } = await runWith({
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: null, sku: "SKU-1" }],
      states: [{ provider: "prices", status: "error", write_scope_missing: true }],
    });
    expect(allegro.states.get("prices")).toMatchObject({ write_scope_missing: true });
  });

  it("treats a 429 as systemic and holds the run", async () => {
    const { summary } = await runWith({
      script: { throwFor: { o1: new AllegroApiError({ httpStatus: 429, message: "Slow down" }) } },
    });
    expect(summary.systemic).toBe(true);
    expect(summary.writeScopeMissing).toBe(false);
    expect(summary.quarantined).toEqual([]);
  });

  it("treats an auth error as systemic", async () => {
    const { summary } = await runWith({
      script: { throwFor: { o1: new AllegroAuthError("token dead", "invalid_grant", 400) } },
    });
    expect(summary.systemic).toBe(true);
    expect(summary.error).toContain("SYSTEMIC");
  });

  it("treats an all-failed tick as systemic even without a systemic status code", async () => {
    const { summary } = await runWith({
      script: { tallyFor: { o1: { failed: 1, success: 0, total: 1 } } },
    });
    expect(summary.failed).toBe(1);
    expect(summary.systemic).toBe(true);
    expect(summary.quarantined).toEqual([]);
  });

  it("does not read a run of pending commands as an outage", async () => {
    // `pending` is neither a success nor a failure. Counting it as failure would let
    // a slow Allegro look like a dead one.
    const { summary } = await runWith({ script: { pendingFor: ["o1"] } });
    expect(summary.pending).toBe(1);
    expect(summary.systemic).toBe(false);
    expect(summary.failed).toBe(0);
  });

  it("grows a streak when one offer fails while another succeeds", async () => {
    const rows = [
      { category_id: "cat-1", id: "row-0", offer_id: "o0", promoted: false, sku: "SKU-0" },
      { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
    ];
    const { allegro, summary } = await runWith({
      costs: { "SKU-0": 100, "SKU-1": 100 },
      live: rows.map((row) => offerFixture({ id: row.offer_id })),
      rows,
      script: { tallyFor: { o0: { failed: 1, success: 0, total: 1 } } },
      variants: [
        { id: "v0", metadata: { srp: 500 }, sku: "SKU-0" },
        { id: "v1", metadata: { srp: 500 }, sku: "SKU-1" },
      ],
    });

    expect(summary.systemic).toBe(false);
    expect(summary.failed).toBe(1);
    expect(summary.synced).toBe(1);
    const failures = allegro.states.get("prices")?.failures as {
      streaks: Record<string, { count: number }>;
    };
    expect(failures.streaks.o0).toMatchObject({ count: 1 });
  });

  it("quarantines an offer at the threshold and holds it out of the next run", async () => {
    const rows = [
      { category_id: "cat-1", id: "row-0", offer_id: "o0", promoted: false, sku: "SKU-0" },
      { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
    ];
    const { allegro, client, summary } = await runWith({
      costs: { "SKU-0": 100, "SKU-1": 100 },
      live: rows.map((row) => offerFixture({ id: row.offer_id })),
      rows,
      script: { tallyFor: { o0: { failed: 1, success: 0, total: 1 } } },
      states: [
        {
          failures: {
            quarantined: {},
            streaks: { o0: { count: QUARANTINE_AFTER_FAILURES - 1, error: "old", since: RECENT } },
          },
          provider: "prices",
          status: "error",
        },
      ],
      variants: [
        { id: "v0", metadata: { srp: 500 }, sku: "SKU-0" },
        { id: "v1", metadata: { srp: 500 }, sku: "SKU-1" },
      ],
    });

    expect(summary.quarantined).toEqual(["o0"]);
    expect(summary.error).toContain("quarantined after repeated failures");
    // Both offers were still attempted this run. The quarantine is the CONSEQUENCE
    // of o0's fifth failure, not something applied retroactively - it takes effect
    // from the NEXT run, which is what the sibling test covers.
    expect(client.commands.map((command) => command.offerId).toSorted()).toEqual(["o0", "o1"]);
    expect(allegro.states.get("prices")).toMatchObject({ status: "error" });
  });

  it("holds an already-quarantined offer out of the candidate list", async () => {
    const { client, summary } = await runWith({
      states: [
        {
          failures: { quarantined: { o1: { error: "broken", since: RECENT } }, streaks: {} },
          provider: "prices",
          status: "error",
        },
      ],
    });
    // The point of quarantine: it stops consuming the run's budget.
    expect(client.commands).toEqual([]);
    expect(summary.quarantined).toEqual(["o1"]);
    expect(summary.failed).toBe(0);
  });
});

describe("syncAllegroPrices: the kill switch", () => {
  it("writes nothing and records the reason", async () => {
    const { allegro, client, summary } = await runWith({ priceSyncDisabled: true });
    expect(client.commands).toEqual([]);
    expect(summary.skipped).toContain("price sync is disabled");
    // Recorded, not silent: "disabled" and "broken" both look like "nothing
    // happened" from outside.
    expect(allegro.states.get("prices")).toMatchObject({ status: "idle" });
    expect(allegro.claims).toEqual([]);
  });
});

describe("pushSingleAllegroOffer", () => {
  it("pushes one offer and reports the bounds it applied", async () => {
    const { allegro, client, container } = healthy();

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    expect(result).toMatchObject({ ok: true, status: "synced" });
    expect(result.message).toContain("137.00-500.00 PLN");
    expect(client.commands).toHaveLength(1);
    expect(allegro.pushes[0]).toMatchObject({ pushed_by: "user_1", result: "success" });
  });

  it("overrides the per-offer opt-out, because the operator asked for this offer", async () => {
    const { client, container } = healthy({
      rows: [
        {
          category_id: "cat-1",
          id: "row-1",
          offer_id: "o1",
          price_sync_enabled: false,
          promoted: false,
          sku: "SKU-1",
        },
      ],
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    expect(result.status).toBe("synced");
    expect(client.commands).toHaveLength(1);
  });

  it("still respects the global kill switch", async () => {
    const { client, container } = healthy({ priceSyncDisabled: true });
    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");
    expect(result.ok).toBe(false);
    expect(client.commands).toEqual([]);
  });

  it("still respects the eligibility data checks", async () => {
    const { container } = healthy({ noCosts: true });
    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");
    expect(result).toMatchObject({ ok: true, status: "skipped" });
    expect(result.message).toContain("missing break-even");
  });

  it("refuses an unresolved conflict", async () => {
    const { container } = healthy({
      rows: [
        {
          category_id: "cat-1",
          conflict: "duplicate-sku",
          id: "row-1",
          offer_id: "o1",
          promoted: false,
          sku: "SKU-1",
        },
      ],
    });
    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");
    expect(result).toMatchObject({ ok: false, status: "skipped" });
  });

  it("reports an unknown SKU rather than throwing", async () => {
    const { container } = healthy();
    const result = await pushSingleAllegroOffer(container as never, "SKU-NOPE", "user_1");
    expect(result).toMatchObject({ ok: false, status: "error" });
    expect(result.message).toContain("No Allegro mapping");
  });

  it("clears the offer's quarantine and streak on success", async () => {
    // The remedy path: a repaired offer must stop being reported AND must not resume
    // a stale streak that would re-quarantine it after one more blip.
    const { allegro, container } = healthy({
      states: [
        {
          failures: {
            quarantined: { o1: { error: "was broken", since: RECENT } },
            streaks: { o1: { count: 2, error: "was broken", since: RECENT } },
          },
          provider: "prices",
          status: "error",
        },
      ],
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    expect(result.status).toBe("synced");
    expect(allegro.states.get("prices")).toMatchObject({ failures: null, status: "ok" });
  });

  it("keeps every OTHER offer's quarantine on the health line", async () => {
    // A per-offer action must never wipe the quarantine signal for the rest of the
    // catalogue off the admin.
    const { allegro, container } = healthy({
      states: [
        {
          failures: {
            quarantined: { "o-other": { error: "still broken", since: RECENT } },
            streaks: {},
          },
          provider: "prices",
          status: "error",
        },
      ],
    });

    await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    const state = allegro.states.get("prices");
    expect(state?.status).toBe("error");
    expect(state?.last_error).toContain("o-other");
  });

  it("reports a noop when the offer is already correct", async () => {
    const { container } = healthy({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      pushes: [
        {
          bound_ceiling: "500.00",
          bound_floor: "137.00",
          id: "algpush_1",
          offer_id: "o1",
          pushed_at: new Date("2026-06-01T00:00:00.000Z"),
          result: "success",
          sku: "SKU-1",
        },
      ],
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    expect(result).toMatchObject({ ok: true, status: "noop" });
  });

  it("reports the write-scope gap and raises the banner", async () => {
    const { allegro, container } = healthy({
      script: { throwFor: { o1: new AllegroApiError({ httpStatus: 403, message: "Forbidden" }) } },
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "user_1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Reconnect Allegro");
    expect(allegro.states.get("prices")).toMatchObject({ write_scope_missing: true });
  });
});

/** Run one price-sync tick over a `setup` fixture and hand back everything. */
const runWith = async (input: Parameters<typeof setup>[0]) => {
  const context = healthy(input);
  const summary = await syncAllegroPrices(context.container as never);
  return { ...context, summary };
};
