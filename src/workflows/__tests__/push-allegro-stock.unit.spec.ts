import { AllegroApiError } from "../../lib/allegro/errors";
import type { AllegroOffer } from "../../lib/allegro/types";
import { pushAllegroStock } from "../push-allegro-stock";
import { fakeAllegroService, fakeContainer, offerFixture } from "./fixtures";
import type { OfferRowFixture, VariantFixture } from "./fixtures";

interface QuantityScript {
  /** Thrown from `changeOfferQuantity` on the Nth submission (0-based). */
  throwOn?: Record<number, Error>;
  /** Command ids whose report never reaches a terminal state. */
  pendingCommands?: number[];
  /** Offer ids to REPORT as confirmed; defaults to every offer in the command. */
  confirmOnly?: string[];
  /**
   * Non-`quantity` tasks emitted AHEAD of the quantity confirmations.
   *
   * This is the shape that broke the single-page read: a command naming N offers can
   * emit far more than N tasks, because Allegro reports tasks per field. Padding the
   * front of the report pushes the quantity confirmations onto a later page, so a
   * reader that stops after page one sees zero of them.
   */
  noiseTasks?: number;
  /** Omit `count`/`totalCount` from the task pages, leaving only the short-page signal. */
  withoutTaskCounts?: boolean;
}

const fakeClient = (input: { offers?: AllegroOffer[]; script?: QuantityScript }) => {
  const script = input.script ?? {};
  const submissions: { commandId: string; offerIds: string[]; value: number }[] = [];
  const commandIndexById = new Map<string, number>();

  return {
    changeOfferQuantity: (params: { commandId: string; offerIds: string[]; value: number }) => {
      const index = submissions.length;
      const failure = script.throwOn?.[index];
      if (failure) {
        return Promise.reject(failure);
      }
      commandIndexById.set(params.commandId, index);
      submissions.push({
        commandId: params.commandId,
        offerIds: params.offerIds,
        value: params.value,
      });
      return Promise.resolve({ id: params.commandId });
    },
    getOfferQuantityCommandTasks: (
      commandId: string,
      params: { limit?: number; offset?: number } = {},
    ) => {
      const submission = submissions.find((entry) => entry.commandId === commandId);
      const offerIds = (submission?.offerIds ?? []).filter((offerId) =>
        script.confirmOnly ? script.confirmOnly.includes(offerId) : true,
      );
      // The whole report, in Allegro's order: any non-quantity tasks first, then the
      // per-offer quantity confirmations.
      const all = [
        ...Array.from({ length: script.noiseTasks ?? 0 }, (_, index) => ({
          field: "description" as const,
          offer: { id: `noise-${index}` },
          status: "SUCCESS" as const,
        })),
        ...offerIds.map((offerId) => ({
          field: "quantity" as const,
          offer: { id: offerId },
          status: "SUCCESS" as const,
        })),
      ];
      // Paginated, and the fake HONOURS limit/offset. A fake that returned the whole
      // report regardless would let a single-page reader pass.
      const offset = params.offset ?? 0;
      const limit = params.limit ?? all.length;
      const page = all.slice(offset, offset + limit);
      return Promise.resolve({
        tasks: page,
        ...(script.withoutTaskCounts ? {} : { count: page.length, totalCount: all.length }),
      });
    },
    listOffers: () =>
      Promise.resolve({
        count: (input.offers ?? []).length,
        offers: input.offers ?? [],
        totalCount: (input.offers ?? []).length,
      }),
    pollOfferQuantityCommand: (commandId: string) => {
      const index = commandIndexById.get(commandId) ?? -1;
      if (script.pendingCommands?.includes(index)) {
        return Promise.resolve({ completedAt: null, id: commandId });
      }
      const submission = submissions.find((entry) => entry.commandId === commandId);
      const total = submission?.offerIds.length ?? 0;
      return Promise.resolve({
        completedAt: "2026-06-01T00:00:00.000Z",
        id: commandId,
        taskCount: { failed: 0, success: total, total },
      });
    },
    submissions,
  };
};

const fakeInventory = (available: Record<string, number>) => ({
  retrieveAvailableQuantity: (itemId: string) => Promise.resolve(available[itemId] ?? 0),
});

const setup = (input: {
  rows?: OfferRowFixture[];
  live?: AllegroOffer[];
  variants?: VariantFixture[];
  available?: Record<string, number>;
  script?: QuantityScript;
  stockSyncDisabled?: boolean;
  noInventory?: boolean;
  stockLocationIds?: string[];
  syncOptions?: Record<string, unknown>;
}) => {
  const client = fakeClient({ offers: input.live, script: input.script });
  const allegro = fakeAllegroService({
    client,
    offers: input.rows ?? [],
    stockSyncDisabled: input.stockSyncDisabled,
    syncOptions: input.syncOptions,
  });
  const logs: string[] = [];
  const container = fakeContainer({
    allegro,
    ...(input.noInventory ? {} : { inventory: fakeInventory(input.available ?? { inv_1: 9 }) }),
    logs,
    stockLocationIds: input.stockLocationIds,
    variants: input.variants ?? [{ id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" }],
  });
  return { allegro, client, container, logs };
};

/** One mapped, ACTIVE offer at quantity 5 with Medusa reporting 9. */
const healthy = (over: Partial<Parameters<typeof setup>[0]> = {}) =>
  setup({
    live: [offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } })],
    rows: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    ...over,
  });

describe("pushAllegroStock task-report pagination", () => {
  /** Two offers heading for the same quantity, so they share ONE command. */
  const twoOffers = (script: QuantityScript) =>
    setup({
      available: { inv_1: 9, inv_2: 9 },
      live: [
        offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } }),
        offerFixture({ external: { id: "SKU-2" }, id: "o2", stock: { available: 5 } }),
      ],
      rows: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o2", sku: "SKU-2" },
      ],
      script,
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-2" },
      ],
    });

  it("confirms successes that only appear on a LATER task page", async () => {
    // The regression: the confirmation read one page of 1,000 tasks at offset 0. A
    // command can emit more tasks than the offers it names - Allegro reports tasks per
    // FIELD - so the quantity confirmations can sit entirely past the first page. The
    // single-page reader saw none of them and reported both offers as failed, on this
    // run and on every run after it.
    const { allegro, container } = twoOffers({ noiseTasks: 1000 });

    const result = await pushAllegroStock(container as never);

    expect(result).toMatchObject({ complete: true, failed: 0, pending: 0, synced: 2 });
    expect(result.error).toBeUndefined();
    // Both mapping rows stamped, because both quantities really were confirmed.
    expect(allegro.offers.map((row) => Boolean(row.stock_synced_at))).toEqual([true, true]);
  });

  it("pages to exhaustion on the short-page signal alone, with no counts reported", async () => {
    // `count`/`totalCount` are optional in the response, so the loop must not depend
    // on Allegro populating them.
    const { container } = twoOffers({ noiseTasks: 1000, withoutTaskCounts: true });

    const result = await pushAllegroStock(container as never);

    expect(result).toMatchObject({ failed: 0, synced: 2 });
  });

  it("reports offers it could not classify as PENDING, never failed, when the page cap is hit", async () => {
    // Ten full pages of tasks before any confirmation: the read is truncated, so the
    // offers that never appeared are UNKNOWN. Counting them as failed is what turned a
    // healthy push into a permanently broken-looking one, so they are pending and the
    // cap is reported loudly.
    const { allegro, container } = twoOffers({ noiseTasks: 10_000 });

    const result = await pushAllegroStock(container as never);

    expect(result).toMatchObject({ complete: false, failed: 0, pending: 2, synced: 0 });
    expect(result.error).toContain("exceeded 10 page(s)");
    expect(result.error).toContain("pending rather than failed");
    // Nothing may claim a confirmed push.
    expect(allegro.offers.every((row) => !row.stock_synced_at)).toBe(true);
  });

  it("still reports a genuinely rejected offer as failed once the whole report is read", async () => {
    // The other direction: a complete report that simply has no SUCCESS task for one
    // offer. Pagination must not soften that into pending.
    const { container } = twoOffers({ confirmOnly: ["o1"], noiseTasks: 1000 });

    const result = await pushAllegroStock(container as never);

    expect(result).toMatchObject({ failed: 1, pending: 0, synced: 1 });
  });
});

describe("pushAllegroStock: the mapping row is the authority", () => {
  it("records a sku-mismatch on the row and pushes nothing for that offer", async () => {
    // The seller-edit race, end to end. Discovery mapped o1 to SKU-1; the seller has since
    // changed the sygnatura to SKU-OTHER. The row still authorises a write, so the old code
    // re-derived the pairing from the live listing and pushed the WRONG variant's quantity
    // to this listing. Now the disagreement is recorded and the offer is skipped.
    const { allegro, client, result } = await (async () => {
      const context = setup({
        available: { inv_1: 9 },
        live: [offerFixture({ external: { id: "SKU-OTHER" }, id: "o1", stock: { available: 5 } })],
        rows: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
        variants: [{ id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" }],
      });
      return { ...context, result: await pushAllegroStock(context.container as never) };
    })();

    expect(client.submissions).toEqual([]);
    expect(result.conflicted).toBe(1);
    expect(result.error).toContain("contradict their mapping row");
    // Durable, not just counted: visible in the admin, and it holds the offer out of the
    // PRICE path too until somebody resolves it.
    expect(allegro.offers[0]).toMatchObject({ conflict: "sku-mismatch", offer_id: null });
    expect(allegro.offers[0]?.conflict_detail).toContain("SKU-OTHER");
  });

  it("counts a mapped offer that has vanished from the listing", async () => {
    // Previously in no bucket at all, so an offer whose quantity was published nowhere left
    // no trace in the run summary.
    const context = setup({
      live: [],
      rows: [{ id: "row-1", offer_id: "o-gone", sku: "SKU-1" }],
    });

    const result = await pushAllegroStock(context.container as never);

    expect(result.skippedUnmatched).toBe(1);
    expect(result.error).toContain("could not be paired");
    expect(result.complete).toBe(false);
  });

  it("reports an eligible variant that no mapped offer claims", async () => {
    const context = setup({
      live: [offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 9 } })],
      rows: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-ORPHAN" },
      ],
    });

    const result = await pushAllegroStock(context.container as never);

    expect(result.skippedUnlinked).toBe(1);
    expect(result.error).toContain("claimed by no mapped Allegro offer");
  });
});

describe("pushAllegroStock scope warning", () => {
  it("warns that the whole catalogue is in scope when no sales channel is configured", async () => {
    // An unset channel makes every SKU-carrying variant eligible for a WRITE, and the
    // run still reports a clean success. Nothing else says so.
    const { container, logs } = healthy();

    await pushAllegroStock(container as never);

    expect(logs.some((line) => line.includes("no sales channel is configured"))).toBe(true);
  });

  it("stays quiet when the integration is scoped to a sales channel", async () => {
    const { container, logs } = healthy({ syncOptions: { salesChannelId: "sc_1" } });

    await pushAllegroStock(container as never);

    expect(logs.some((line) => line.includes("no sales channel is configured"))).toBe(false);
  });
});

describe("pushAllegroStock", () => {
  it("pushes the available quantity Medusa reports", async () => {
    const { allegro, client, container } = healthy();

    const result = await pushAllegroStock(container as never);

    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]).toMatchObject({ offerIds: ["o1"], value: 9 });
    expect(result).toMatchObject({
      alreadyInSync: 0,
      commands: 1,
      complete: true,
      eligible: 1,
      failed: 0,
      mismatched: 1,
      pending: 0,
      synced: 1,
    });
    expect(allegro.offers[0]?.stock_synced_at).toBeInstanceOf(Date);
  });

  it("sums available quantity across a variant's inventory items", async () => {
    const { client } = await runWith({
      available: { inv_1: 4, inv_2: 5 },
      variants: [{ id: "v1", inventoryItemIds: ["inv_1", "inv_2"], sku: "SKU-1" }],
    });
    expect(client.submissions[0]?.value).toBe(9);
  });

  it("writes nothing when the quantities already match", async () => {
    const { client, result } = await runWith({ available: { inv_1: 5 } });
    expect(client.submissions).toEqual([]);
    expect(result).toMatchObject({ alreadyInSync: 1, complete: true, mismatched: 0 });
  });

  it("pushes a quantity down to zero", async () => {
    // Zero is a real quantity, not an absence. Refusing it is how a sold-out item
    // stays purchasable on the marketplace.
    const { client } = await runWith({ available: { inv_1: 0 } });
    expect(client.submissions[0]?.value).toBe(0);
  });

  it("groups offers by target quantity into one command each", async () => {
    const { client } = await runWith({
      available: { inv_1: 9, inv_2: 9, inv_3: 4 },
      live: [
        offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } }),
        offerFixture({ external: { id: "SKU-2" }, id: "o2", stock: { available: 5 } }),
        offerFixture({ external: { id: "SKU-3" }, id: "o3", stock: { available: 5 } }),
      ],
      rows: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o2", sku: "SKU-2" },
        { id: "row-3", offer_id: "o3", sku: "SKU-3" },
      ],
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-2" },
        { id: "v3", inventoryItemIds: ["inv_3"], sku: "SKU-3" },
      ],
    });

    expect(client.submissions).toHaveLength(2);
    expect(client.submissions.map((entry) => entry.value).toSorted()).toEqual([4, 9]);
    expect(client.submissions.find((entry) => entry.value === 9)?.offerIds.toSorted()).toEqual([
      "o1",
      "o2",
    ]);
  });

  it("refuses the whole plan when a variant quantity is unreadable", async () => {
    // A partial push leaves some offers fresh and others stale with no record of
    // which, so the next run cannot tell either.
    const { client, logs, result } = await runWith({
      noInventory: true,
    });
    expect(client.submissions).toEqual([]);
    expect(result).toMatchObject({ complete: false, unresolved: 1 });
    expect(result.error).toContain("the whole plan was refused");
    expect(logs.some((line) => line.includes("plan refused"))).toBe(true);
  });

  it("refuses the whole plan on an ambiguous match", async () => {
    const { client, result } = await runWith({
      available: { inv_1: 9, inv_2: 9 },
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-1" },
      ],
    });
    expect(client.submissions).toEqual([]);
    expect(result.ambiguous).toBe(1);
  });

  it("holds a conflicted mapping out of the candidate set", async () => {
    // The write path binding on discovery's conflict detection: pushing a quantity
    // to one of two offers contesting a SKU is a real oversell.
    const { client, result } = await runWith({
      rows: [{ conflict: "duplicate-sku", id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    expect(client.submissions).toEqual([]);
    // The variant is then reported unlinked rather than eligible, which is accurate:
    // there is no offer this plugin will write to for it.
    expect(result).toMatchObject({ eligible: 0, skippedUnlinked: 1 });
  });

  it("holds an unmapped offer out of the candidate set", async () => {
    const { client, result } = await runWith({
      rows: [{ id: "row-1", offer_id: null, sku: "SKU-1" }],
    });
    expect(client.submissions).toEqual([]);
    expect(result.skippedUnlinked).toBe(1);
  });

  it("counts a non-ACTIVE offer as skipped and refuses to call the run complete", async () => {
    const { result } = await runWith({
      live: [
        offerFixture({
          external: { id: "SKU-1" },
          id: "o1",
          publication: { status: "ENDED" },
          stock: { available: 5 },
        }),
      ],
    });
    expect(result).toMatchObject({ complete: false, eligible: 0, skippedInactive: 1 });
  });

  it("skips a variant that does not manage inventory, never publishing zero for it", async () => {
    // Publishing 0 would delist it; publishing anything else would be fabricated. It is now
    // its OWN bucket rather than `unresolved`, because "structurally has no quantity" is a
    // bounded permanent fact while `unresolved` means "could not read it" - and refusing
    // the whole plan for the former meant one digital product with an Allegro offer wedged
    // stock sync for the entire catalogue, indefinitely.
    const { client, result } = await runWith({
      variants: [{ id: "v1", inventoryItemIds: [], manageInventory: false, sku: "SKU-1" }],
    });
    expect(client.submissions).toEqual([]);
    expect(result.skippedNoInventory).toBe(1);
    expect(result.unresolved).toBe(0);
    // Reported and not complete, because its quantity is published nowhere.
    expect(result.error).toContain("does not manage inventory");
    expect(result.complete).toBe(false);
  });

  it("aborts the run when no stock location exists, rather than pushing zero everywhere", async () => {
    // `retrieveAvailableQuantity` returns BigNumber(0) for an EMPTY location list - it does
    // not fail - so every variant read as 0, the plan looked perfectly safe, and the run
    // pushed a quantity of 0 across the whole catalogue and reported itself clean. A full
    // marketplace delisting presented as a healthy sync.
    const { allegro, client, container } = healthy({ stockLocationIds: [] });

    await expect(pushAllegroStock(container as never)).rejects.toThrow(/no stock locations exist/u);

    expect(client.submissions).toEqual([]);
    expect(allegro.states.get("stock")).toMatchObject({ status: "error" });
    expect(allegro.states.get("stock")?.last_error).toContain("no stock locations exist");
  });

  it("reports a 403 as the write-scope gap and raises the banner", async () => {
    const { allegro, result } = await runWith({
      script: { throwOn: { 0: new AllegroApiError({ httpStatus: 403, message: "Forbidden" }) } },
    });
    expect(result.error).toContain("WRITE_SCOPE_MISSING");
    expect(result.failed).toBe(1);
    expect(allegro.states.get("stock")).toMatchObject({ write_scope_missing: true });
  });

  it("stops submitting at the first systemic failure and counts the rest as failed", async () => {
    // Offers whose command was never submitted keep a stale quantity, and nothing
    // else records that.
    const { client, result } = await runWith({
      available: { inv_1: 9, inv_2: 4 },
      live: [
        offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } }),
        offerFixture({ external: { id: "SKU-2" }, id: "o2", stock: { available: 5 } }),
      ],
      rows: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o2", sku: "SKU-2" },
      ],
      script: { throwOn: { 1: new AllegroApiError({ httpStatus: 500, message: "Boom" }) } },
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-2" },
      ],
    });

    expect(client.submissions).toHaveLength(1);
    expect(result.commands).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.complete).toBe(false);
  });

  it("reports an unconfirmed command as pending, not failed", async () => {
    // The quantities may well have landed; calling them failures would make the next
    // run treat a working push as broken.
    const { allegro, result } = await runWith({ script: { pendingCommands: [0] } });
    expect(result).toMatchObject({ failed: 0, pending: 1, synced: 0 });
    expect(result.error).toContain("not confirmed within the poll budget");
    // Not stamped: nothing was confirmed.
    expect(allegro.offers[0]?.stock_synced_at).toBeUndefined();
  });

  it("counts an offer with no SUCCESS task inside a terminal command as failed", async () => {
    // A command can report itself complete while individual offers in it were
    // rejected, and counting the command as a success would claim a quantity that
    // never landed.
    const { allegro, result } = await runWith({
      available: { inv_1: 9, inv_2: 9 },
      live: [
        offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } }),
        offerFixture({ external: { id: "SKU-2" }, id: "o2", stock: { available: 5 } }),
      ],
      rows: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o2", sku: "SKU-2" },
      ],
      script: { confirmOnly: ["o1"] },
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-2" },
      ],
    });

    expect(result).toMatchObject({ failed: 1, synced: 1 });
    // Stamped per confirmed offer: only o1's row moves.
    expect(allegro.offers.find((row) => row.offer_id === "o1")?.stock_synced_at).toBeInstanceOf(
      Date,
    );
    expect(allegro.offers.find((row) => row.offer_id === "o2")?.stock_synced_at).toBeUndefined();
  });

  it("writes nothing and records the reason when the kill switch is on", async () => {
    const { allegro, client, result } = await runWith({ stockSyncDisabled: true });
    expect(client.submissions).toEqual([]);
    expect(result.skipped).toContain("stock sync is disabled");
    expect(allegro.states.get("stock")).toMatchObject({ status: "idle" });
    expect(allegro.claims).toEqual([]);
  });

  it("records its counters on the state row", async () => {
    const { allegro } = await runWith({});
    const state = allegro.states.get("stock");
    expect(state).toMatchObject({ last_error: null, status: "ok" });
    expect(state?.counts).toMatchObject({ eligible: 1, synced: 1 });
  });

  it("takes only the stock claim", async () => {
    const { allegro } = await runWith({});
    expect(allegro.claims).toEqual(["stock"]);
  });

  it("reads quantities at the configured locations only", async () => {
    const inventoryCalls: string[][] = [];
    const client = fakeClient({
      offers: [offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } })],
    });
    const allegro = fakeAllegroService({
      client,
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      syncOptions: { stockLocationIds: ["sloc_warehouse"] },
    });
    const container = fakeContainer({
      allegro,
      inventory: {
        retrieveAvailableQuantity: (_itemId: string, locationIds: string[]) => {
          inventoryCalls.push(locationIds);
          return Promise.resolve(9);
        },
      },
      variants: [{ id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" }],
    });

    await pushAllegroStock(container as never);

    expect(inventoryCalls).toEqual([["sloc_warehouse"]]);
  });

  it("materialises every location when none is configured", async () => {
    // `retrieveAvailableQuantity` needs an explicit list, and an empty one reads as
    // "nowhere" - which would report the whole catalogue out of stock.
    const inventoryCalls: string[][] = [];
    const client = fakeClient({
      offers: [offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } })],
    });
    const allegro = fakeAllegroService({
      client,
      offers: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });
    const container = fakeContainer({
      allegro,
      inventory: {
        retrieveAvailableQuantity: (_itemId: string, locationIds: string[]) => {
          inventoryCalls.push(locationIds);
          return Promise.resolve(9);
        },
      },
      stockLocationIds: ["sloc_a", "sloc_b"],
      variants: [{ id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" }],
    });

    await pushAllegroStock(container as never);

    expect(inventoryCalls).toEqual([["sloc_a", "sloc_b"]]);
  });
});

const runWith = async (input: Parameters<typeof setup>[0]) => {
  const context = healthy(input);
  const result = await pushAllegroStock(context.container as never);
  return { ...context, result };
};
