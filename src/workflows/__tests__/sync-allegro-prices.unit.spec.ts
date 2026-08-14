import { AllegroAuthError } from "../../lib/allegro/auth-error";
import { AllegroApiError } from "../../lib/allegro/errors";
import type { AllegroOffer, PriceAutomationRule } from "../../lib/allegro/types";
import { QUARANTINE_AFTER_FAILURES } from "../../lib/sync/failure-state";
import {
  MANUAL_PUSH_WINDOW_MS,
  pushSingleAllegroOffer,
  syncAllegroPrices,
} from "../sync-allegro-prices";
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
  /** Offers whose price-change command fails, by offer id. */
  priceTallyFor?: Record<string, { failed: number; success: number; total: number }>;
  /** Offers whose rule-REMOVAL command fails, by offer id. */
  removalTallyFor?: Record<string, { failed: number; success: number; total: number }>;
}

const fakeClient = (input: {
  offers?: AllegroOffer[];
  rules?: PriceAutomationRule[];
  rulesError?: Error;
  script?: CommandScript;
}) => {
  const commands: { offerId: string; ruleId: string; min?: string; max?: string }[] = [];
  /** Every fixed-price write, in order, exactly as the SDK would send it. */
  const priceCommands: {
    commandId: string;
    offerId: string;
    amount: string;
    currency: string;
    marketplaceId?: string;
  }[] = [];
  /** Every rule REMOVAL, in order. */
  const removals: { offerId: string; marketplaceId?: string }[] = [];
  const script = input.script ?? {};
  const offerIdByCommand = new Map<string, string>();
  const offerIdByRemoval = new Map<string, string>();
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
    changeOfferPrice: (params: {
      commandId: string;
      offerId: string;
      price: { amount: string; currency: string };
      marketplaceId?: string;
    }) => {
      const failure = script.throwFor?.[params.offerId];
      if (failure) {
        return Promise.reject(failure);
      }
      priceCommands.push({
        amount: params.price.amount,
        commandId: params.commandId,
        currency: params.price.currency,
        marketplaceId: params.marketplaceId,
        offerId: params.offerId,
      });
      offerIdByCommand.set(params.commandId, params.offerId);
      return Promise.resolve({ id: params.commandId });
    },
    commands,
    getOffer: (offerId: string) =>
      Promise.resolve(
        (input.offers ?? []).find((offer) => offer.id === offerId) ?? offerFixture({ id: offerId }),
      ),
    getOfferPriceAutomationCommandTasks: () =>
      Promise.resolve({ tasks: [{ message: "rejected by Allegro", status: "FAIL" as const }] }),
    getOfferPriceChangeCommandTasks: () =>
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
    pollOfferPriceChangeCommand: (commandId: string) => {
      const offerId = offerIdByCommand.get(commandId) ?? "";
      return Promise.resolve({
        completedAt: "2026-06-01T00:00:00.000Z",
        id: commandId,
        taskCount: script.priceTallyFor?.[offerId] ?? { failed: 0, success: 1, total: 1 },
      });
    },
    priceCommands,
    removals,
    removeOfferPriceAutomation: (params: { offerId: string; marketplaceId?: string }) => {
      sequence += 1;
      const commandId = `rm-${sequence}`;
      offerIdByRemoval.set(commandId, params.offerId);
      removals.push({ marketplaceId: params.marketplaceId, offerId: params.offerId });
      return Promise.resolve({ id: commandId });
    },
    pollOfferPriceAutomationCommand: (commandId: string) => {
      const removedOffer = offerIdByRemoval.get(commandId);
      if (removedOffer !== undefined) {
        return Promise.resolve({
          completedAt: "2026-06-01T00:00:00.000Z",
          id: commandId,
          taskCount: script.removalTallyFor?.[removedOffer] ?? { failed: 0, success: 1, total: 1 },
        });
      }
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
  /** Trip the kill switch only after N reads, i.e. mid-run. */
  killSwitchTripsAfterReads?: number;
  noCosts?: boolean;
  /** Simulates the claim being taken over mid-run: every heartbeat reports it lost. */
  claimLost?: boolean;
}) => {
  const client = fakeClient({
    offers: input.live,
    rules: input.rules,
    rulesError: input.rulesError,
    script: input.script,
  });
  const allegro = fakeAllegroService({
    categories: input.categories ?? CAT_RATES,
    claimLost: input.claimLost,
    client,
    offers: input.rows ?? [],
    killSwitchTripsAfterReads: input.killSwitchTripsAfterReads,
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

describe("pushSingleAllegroOffer: a failed push never settles the provider as healthy", () => {
  /** A provider row carrying a standing write-scope condition from the scheduled loop. */
  const standing = (over: Parameters<typeof setup>[0] = {}) =>
    setup({
      live: [offerFixture({ id: "o1" })],
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" }],
      states: [
        {
          last_error: "WRITE_SCOPE_MISSING: reconnect Allegro with the offer write scope.",
          provider: "prices",
          status: "error",
          write_scope_missing: true,
        },
      ],
      ...over,
    });

  it("does not settle the provider as ok when the command fails", async () => {
    // The regression: the failed-command exit passed no `lastError`, so the row fell back to
    // the standing line - null on a provider with no quarantines - and was written
    // `status: "ok"`, `last_error: null`, `last_synced_at: now`. An operator's FAILED push
    // therefore made a broken provider read as freshly healthy.
    const { allegro, container } = standing({
      script: { tallyFor: { o1: { failed: 1, success: 0, total: 1 } } },
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.ok).toBe(false);
    const state = allegro.states.get("prices");
    expect(state?.status).toBe("error");
    expect(state?.last_error).toContain('the manual push for "SKU-1" failed');
  });

  it("keeps the write-scope banner text while the flag is still raised", async () => {
    // A no-mapping exit touches nothing about the scope, so the flag stays set - and the line
    // explaining it has to stay with it, or the admin renders a banner with no text.
    const { allegro, container } = standing();

    const result = await pushSingleAllegroOffer(container as never, "SKU-UNKNOWN", "operator");

    expect(result.ok).toBe(false);
    const state = allegro.states.get("prices");
    expect(state?.status).toBe("error");
    expect(state?.last_error).toContain("WRITE_SCOPE_MISSING");
    expect(state?.write_scope_missing).toBe(true);
  });

  it("still settles ok when the push genuinely succeeds and nothing is standing", async () => {
    // The contrast, so the guard above cannot be satisfied by simply never reporting ok.
    const { allegro, container } = healthy();

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.status).toBe("synced");
    expect(allegro.states.get("prices")).toMatchObject({ last_error: null, status: "ok" });
  });
});

describe("syncAllegroPrices: the claim is re-asserted between commands", () => {
  it("abandons the remaining commands when the claim is taken over mid-run", async () => {
    // A full-catalogue push is minutes of sequential commands, each with its own 15s poll,
    // so the claim was routinely taken over mid-flight - and the run carried on pushing
    // prices concurrently with the run that had replaced it. Two writers issuing
    // price-automation commands for the same offers is exactly what single-flight prevents.
    const { allegro, client, container } = setup({
      claimLost: true,
      costs: { "SKU-1": 100, "SKU-2": 100 },
      live: [offerFixture({ id: "o1" }), offerFixture({ id: "o2" })],
      rows: [
        { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
        { category_id: "cat-1", id: "row-2", offer_id: "o2", promoted: false, sku: "SKU-2" },
      ],
      variants: [
        { id: "v1", metadata: { srp: 500 }, sku: "SKU-1" },
        { id: "v2", metadata: { srp: 500 }, sku: "SKU-2" },
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    // Not a single command: the heartbeat is checked BEFORE each one.
    expect(client.commands).toEqual([]);
    expect(summary.synced).toBe(0);
    // Read as systemic, so nothing is quarantined over it - the offers are fine, the run
    // is not.
    expect(summary.systemic).toBe(true);
    expect(summary.error).toContain("claim was taken over");
    // And the outcome is NOT written over the successor's state row.
    expect(allegro.states.get("prices")?.status).not.toBe("error");
  });

  it("heartbeats under its own claim token while it still holds it", async () => {
    const { allegro, client, container } = healthy();

    await syncAllegroPrices(container as never);

    expect(client.commands).toHaveLength(1);
    expect(allegro.heartbeats.map((beat) => beat.provider)).toEqual(["prices"]);
    expect(allegro.heartbeats[0]?.token).toEqual(expect.any(String));
  });
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

  it("takes the price-list SRP in the OFFER's currency, not whichever row came last", async () => {
    // `currency_code` was requested by the query and then ignored, so on a multi-currency
    // price list - the normal shape for a store selling in more than one - the last row won
    // for that SKU. A EUR amount could become the PLN ceiling of a price-automation rule,
    // roughly a quarter of the intended figure, and the rule would be licensed to sell down
    // to it. The EUR row is listed LAST here, so an order-dependent implementation picks it.
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
      priceListPrices: [
        { amount: 420, currency: "pln", variantId: "v1" },
        { amount: 99, currency: "eur", variantId: "v1" },
      ],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.synced).toBe(1);
    // The PLN ceiling, because the offer fixture prices in PLN. 99 would have been the EUR
    // amount misapplied, and it also sits below the 137 floor, so the offer would instead
    // have been skipped as an inverted range - silently unsynced rather than mispriced.
    expect(allegro.pushes[0]).toMatchObject({ bound_ceiling: "420.00" });
  });

  it("skips an offer whose currency has no price-list SRP, rather than converting", async () => {
    // No cross-currency conversion: a converted ceiling would depend on a rate this plugin
    // does not have and cannot audit. Fail-closed with `missing-srp` instead.
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
      priceListPrices: [{ amount: 99, currency: "eur", variantId: "v1" }],
      variants: [{ id: "v1", sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.synced).toBe(0);
    expect(summary.skippedCounts["missing-srp"]).toBe(1);
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
    expect(summary.error).toContain("no two distinct rule names are configured");
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

describe("pushSingleAllegroOffer: the manual blast-radius cap", () => {
  /** `changeCap` manual pushes already on the audit, inside the rolling window. */
  const spentBudget = (count: number, over: Parameters<typeof setup>[0] = {}) =>
    setup({
      live: [offerFixture({ id: "o1" })],
      pushes: Array.from({ length: count }, (_, index) => ({
        id: `algpush_prior_${index}`,
        offer_id: "o-other",
        pushed_at: new Date(Date.now() - 60_000),
        pushed_by: "operator",
        result: "success",
        sku: `SKU-OTHER-${index}`,
      })),
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" }],
      syncOptions: { automationRules: { ...RULES }, changeCap: 3, srpMetadataKey: "srp" },
      ...over,
    });

  it("refuses once the rolling hour has spent the changeCap budget", async () => {
    // Each call takes the claim, so calls serialise - but serialising is not bounding.
    // Nothing stopped a script looping over this route from repricing the whole catalogue,
    // walking straight around the `changeCap` that exists to stop the scheduled loop doing
    // exactly that before a human sees it.
    const { client, container } = spentBudget(3);

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.status).toBe("rate-limited");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("changeCap");
    // Refused before any Allegro write.
    expect(client.commands).toEqual([]);
  });

  it("allows the push while the budget still has room", async () => {
    const { client, container } = spentBudget(2);

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.status).toBe("synced");
    expect(client.commands).toHaveLength(1);
  });

  it("does not count the scheduled loop's own pushes against an operator", async () => {
    // `pushed_by` already distinguishes a human from the loop, so the cap needs no new state.
    // Counting the loop's rows would make an hourly full-catalogue pass lock operators out.
    const { client, container } = spentBudget(0, {
      pushes: Array.from({ length: 50 }, (_, index) => ({
        id: `algpush_loop_${index}`,
        offer_id: "o-other",
        pushed_at: new Date(Date.now() - 60_000),
        pushed_by: "price-sync",
        result: "success",
        sku: `SKU-LOOP-${index}`,
      })),
    });

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.status).toBe("synced");
    expect(client.commands).toHaveLength(1);
  });

  it("does not count manual pushes older than the window", async () => {
    const { container } = spentBudget(0, {
      pushes: Array.from({ length: 10 }, (_, index) => ({
        id: `algpush_old_${index}`,
        offer_id: "o-other",
        pushed_at: new Date(Date.now() - MANUAL_PUSH_WINDOW_MS - 60_000),
        pushed_by: "operator",
        result: "success",
        sku: `SKU-OLD-${index}`,
      })),
    });

    expect((await pushSingleAllegroOffer(container as never, "SKU-1", "operator")).status).toBe(
      "synced",
    );
  });

  it("leaves the provider row's standing report untouched when it refuses", async () => {
    // Being over budget says nothing about the provider's health, so the refusal must neither
    // invent a provider error nor erase what the scheduled loop last reported.
    const { allegro, container } = spentBudget(3, {
      states: [
        {
          last_error: "WRITE_SCOPE_MISSING: reconnect Allegro with the offer write scope.",
          provider: "prices",
          status: "error",
          write_scope_missing: true,
        },
      ],
    });

    await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(allegro.states.get("prices")?.last_error).toContain("WRITE_SCOPE_MISSING");
  });
});

describe("syncAllegroPrices: the kill switch is re-read mid-run", () => {
  it("stops before the next command when the switch is flipped during the run", async () => {
    // The switch is a predicate rather than a boolean precisely so it is re-read at the moment
    // of the run - and the README sells it as the way to stop a runaway NOW. But it was only
    // ever evaluated once, before the claim, so a full-catalogue push kept issuing price
    // commands for its whole remaining duration after an operator had flipped it. The
    // per-command fence checked the claim and not the switch.
    const { allegro, client, container } = setup({
      costs: { "SKU-1": 100, "SKU-2": 100, "SKU-3": 100 },
      // Clear for the pre-claim read; tripped by the first per-command fence.
      killSwitchTripsAfterReads: 1,
      live: [
        offerFixture({ id: "o1" }),
        offerFixture({ id: "o2" }),
        offerFixture({ id: "o3" }),
      ],
      rows: [
        { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
        { category_id: "cat-1", id: "row-2", offer_id: "o2", promoted: false, sku: "SKU-2" },
        { category_id: "cat-1", id: "row-3", offer_id: "o3", promoted: false, sku: "SKU-3" },
      ],
      variants: [
        { id: "v1", metadata: { srp: 500 }, sku: "SKU-1" },
        { id: "v2", metadata: { srp: 500 }, sku: "SKU-2" },
        { id: "v3", metadata: { srp: 500 }, sku: "SKU-3" },
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    // The run started (it was not skipped pre-claim) but issued nothing.
    expect(summary.skipped).toBeUndefined();
    expect(client.commands).toEqual([]);
    expect(summary.synced).toBe(0);
    expect(summary.error).toContain("stopped mid-flight");
    // Nothing claims a push that was stopped.
    expect(allegro.offers.every((row) => !row.price_synced_at)).toBe(true);
  });

  it("still pushes the whole batch while the switch stays clear", async () => {
    const { client, container } = healthy();

    await syncAllegroPrices(container as never);

    expect(client.commands).toHaveLength(1);
  });
});

describe("syncAllegroPrices: monitor mode", () => {
  /** Monitor needs no rule names at all, so the fixture states none. */
  const monitoring = (over: Parameters<typeof setup>[0] = {}) =>
    setup({
      live: [offerFixture({ id: "o1" })],
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" }],
      ...over,
      syncOptions: {
        automationRules: undefined,
        pricingMode: "monitor",
        srpMetadataKey: "srp",
        ...over.syncOptions,
      },
    });

  it("writes nothing to Allegro and reports the bounds it computed", async () => {
    const { client, container } = monitoring();

    const summary = await syncAllegroPrices(container as never);

    expect(client.commands).toEqual([]);
    expect(client.priceCommands).toEqual([]);
    expect(client.removals).toEqual([]);
    expect(summary.mode).toBe("monitor");
    expect(summary.scanned).toBe(1);
    expect(summary.monitored).toBe(1);
    expect(summary.synced).toBe(0);
  });

  it("runs without any automation rule names, rather than reporting itself inert", async () => {
    // The whole point of naming this mode: with no rules configured the loop used
    // to report an error and do nothing. A store that has DECIDED not to use rules
    // is not misconfigured.
    const { allegro, container } = monitoring();

    const summary = await syncAllegroPrices(container as never);

    expect(summary.error).toBeUndefined();
    expect(allegro.states.get("prices")?.status).toBe("ok");
  });

  it("counts an offer priced below its break-even floor", async () => {
    // Break-even on a 100 net cost at 10% commission is 123 gross / 0.9 = 136.67,
    // so an offer listed at 120 is under water.
    const { container } = monitoring({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { price: { amount: "120.00", currency: "PLN" } },
        }),
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.belowFloor).toBe(1);
    expect(summary.aboveCeiling).toBe(0);
  });

  it("counts an offer priced above its SRP ceiling", async () => {
    const { container } = monitoring({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: { price: { amount: "900.00", currency: "PLN" } },
        }),
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.aboveCeiling).toBe(1);
    expect(summary.belowFloor).toBe(0);
  });

  it("reports the same skip reasons an armed run would, so the report is honest", async () => {
    const { container } = monitoring({ noCosts: true });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.skippedCounts["missing-break-even"]).toBe(1);
    expect(summary.monitored).toBe(0);
  });

  it("runs even while the price-write toggle is disarmed, because it cannot write", async () => {
    const { client, container } = monitoring({ priceSyncDisabled: true });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.skipped).toBeUndefined();
    expect(summary.monitored).toBe(1);
    expect(client.commands).toEqual([]);
    expect(client.priceCommands).toEqual([]);
  });

  it("refuses an operator's manual push, rather than writing one offer anyway", async () => {
    const { client, container } = monitoring();

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("monitor");
    expect(client.commands).toEqual([]);
    expect(client.priceCommands).toEqual([]);
  });
});

describe("syncAllegroPrices: fixed-price mode", () => {
  /**
   * A store pricing from Medusa. The variant's own price is 300 PLN, inside the
   * 136.67 floor and the 500 SRP ceiling the other fixtures already establish.
   */
  const fixedPrice = (over: Parameters<typeof setup>[0] = {}) =>
    setup({
      live: [offerFixture({ id: "o1" })],
      rows: [{ category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" }],
      variants: [
        { id: "v1", metadata: { srp: 500 }, prices: [{ amount: 300 }], sku: "SKU-1" },
      ],
      ...over,
      syncOptions: {
        automationRules: undefined,
        pricingMode: "fixed_price",
        srpMetadataKey: "srp",
        ...over.syncOptions,
      },
    });

  it("pushes the Medusa variant price, and attaches no rule", async () => {
    const { client, container } = fixedPrice();

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([
      {
        amount: "300.00",
        commandId: expect.any(String),
        currency: "PLN",
        marketplaceId: "allegro-pl",
        offerId: "o1",
      },
    ]);
    expect(client.commands).toEqual([]);
    expect(summary.synced).toBe(1);
    expect(summary.mode).toBe("fixed_price");
  });

  it("needs no automation rule names configured", async () => {
    const { container } = fixedPrice();

    const summary = await syncAllegroPrices(container as never);

    expect(summary.error).toBeUndefined();
  });

  it("removes an attached rule BEFORE setting the price", async () => {
    const { client, container } = fixedPrice({
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

    const summary = await syncAllegroPrices(container as never);

    expect(client.removals).toEqual([{ marketplaceId: "allegro-pl", offerId: "o1" }]);
    expect(client.priceCommands).toHaveLength(1);
    expect(summary.synced).toBe(1);
  });

  it("does not set the price when the rule removal did not confirm", async () => {
    // A half-applied pair - rule still on, price changed - is exactly the fight
    // with Allegro's engine the ordering exists to avoid.
    const { client, container } = fixedPrice({
      live: [
        offerFixture({
          id: "o1",
          sellingMode: {
            price: { amount: "199.99", currency: "PLN" },
            priceAutomation: { rule: { id: "rule-standard" } },
          },
        }),
      ],
      script: { removalTallyFor: { o1: { failed: 1, success: 0, total: 1 } } },
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.synced).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it("refuses a Medusa price below the break-even floor rather than clamping it", async () => {
    const { client, container } = fixedPrice({
      variants: [{ id: "v1", metadata: { srp: 500 }, prices: [{ amount: 50 }], sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.skippedCounts["price-outside-bounds"]).toBe(1);
  });

  it("refuses a Medusa price above the SRP ceiling", async () => {
    const { client, container } = fixedPrice({
      variants: [{ id: "v1", metadata: { srp: 500 }, prices: [{ amount: 900 }], sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.skippedCounts["price-outside-bounds"]).toBe(1);
  });

  it("skips a variant with no Medusa price in the offer's currency", async () => {
    const { client, container } = fixedPrice({
      variants: [
        { id: "v1", metadata: { srp: 500 }, prices: [{ amount: 300, currency: "eur" }], sku: "SKU-1" },
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.skippedCounts["missing-medusa-price"]).toBe(1);
  });

  it("ignores a price-list row, because a sale price is not the store's price", async () => {
    const { client, container } = fixedPrice({
      variants: [
        {
          id: "v1",
          metadata: { srp: 500 },
          prices: [{ amount: 199, priceListId: "plist_sale" }],
          sku: "SKU-1",
        },
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.skippedCounts["missing-medusa-price"]).toBe(1);
  });

  it("leaves an offer alone when it is already at the Medusa price with no rule", async () => {
    const { client, container } = fixedPrice({
      live: [
        offerFixture({ id: "o1", sellingMode: { price: { amount: "300.00", currency: "PLN" } } }),
      ],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.priceCommands).toEqual([]);
    expect(summary.alreadyInSync).toBe(1);
  });

  it("records the pushed price on the audit row, and leaves the rule bounds null", async () => {
    // `bound_floor` / `bound_ceiling` are the only memory of the price RANGE
    // attached to an automation rule. A fixed price written into them would be
    // read back as a range that was never attached.
    const { allegro, container } = fixedPrice();

    await syncAllegroPrices(container as never);

    const [row] = allegro.pushes;
    expect(row).toMatchObject({
      price_amount: "300.00",
      price_currency: "PLN",
      price_mode_new: "fixed",
      result: "success",
    });
    expect(row?.bound_floor ?? null).toBeNull();
    expect(row?.bound_ceiling ?? null).toBeNull();
    expect(row?.rule_name_new ?? null).toBeNull();
  });

  it("still respects the price-write kill switch", async () => {
    const { client, container } = fixedPrice({ priceSyncDisabled: true });

    const summary = await syncAllegroPrices(container as never);

    expect(summary.skipped).toBeDefined();
    expect(client.priceCommands).toEqual([]);
  });

  it("pushes one offer on an explicit operator action, and says what it set", async () => {
    const { client, container } = fixedPrice();

    const result = await pushSingleAllegroOffer(container as never, "SKU-1", "operator");

    expect(result.ok).toBe(true);
    expect(result.status).toBe("synced");
    expect(result.message).toContain("300.00 PLN");
    expect(client.priceCommands).toHaveLength(1);
  });
});

describe("syncAllegroPrices: a mode change between guard and claim", () => {
  it("holds rather than writing without the kill switch it was started without", async () => {
    // `getPricingMode` answers `monitor`, so the run is started with no
    // price-write guard attached; `getSyncOptions` then reports a writing mode.
    // Writing here would write past a toggle nobody consulted.
    const client = fakeClient({ offers: [offerFixture({ id: "o1" })] });
    const allegro = fakeAllegroService({
      categories: CAT_RATES,
      client,
      offers: [
        { category_id: "cat-1", id: "row-1", offer_id: "o1", promoted: false, sku: "SKU-1" },
      ],
      pushes: [],
      states: [],
      syncOptions: { automationRules: { ...RULES }, pricingMode: "automation_rule", srpMetadataKey: "srp" },
    });
    allegro.getPricingMode = () => Promise.resolve("monitor");
    const container = fakeContainer({
      allegro,
      costs: fakeCostsService({ "SKU-1": 100 }),
      variants: [{ id: "v1", metadata: { srp: 500 }, sku: "SKU-1" }],
    });

    const summary = await syncAllegroPrices(container as never);

    expect(client.commands).toEqual([]);
    expect(summary.error).toContain("the pricing mode changed");
  });
});
