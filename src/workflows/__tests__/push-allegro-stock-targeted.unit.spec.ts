import type { AllegroOffer } from "../../lib/allegro/types";
import { pushTargetedAllegroStock } from "../push-allegro-stock";
import { fakeAllegroService, fakeContainer, offerFixture } from "./fixtures";
import type { OfferRowFixture, VariantFixture } from "./fixtures";

/**
 * The event-driven quantity push.
 *
 * It is the same function as the scheduled sweep with the scope narrowed, and these
 * tests are written to hold that line: every safety property the sweep has must still
 * bind when a sale triggers a push at an arbitrary moment, and the narrowing must
 * genuinely narrow - a push for one SKU must not read or write the catalogue.
 */

/** Records what the push asked Allegro for, and what it told it. */
const fakeClient = (offers: AllegroOffer[]) => {
  const submissions: { commandId: string; offerIds: string[]; value: number }[] = [];
  /** Every `offer.id` the push filtered on, so "did it read the catalogue?" is answerable. */
  const offerReads: (string | undefined)[] = [];

  return {
    changeOfferQuantity: (params: {
      commandId: string;
      offerIds: string[];
      value: number;
    }) => {
      submissions.push({ ...params });
      return Promise.resolve({ id: params.commandId });
    },
    getOfferQuantityCommandTasks: (commandId: string) => {
      const submission = submissions.find((entry) => entry.commandId === commandId);
      const tasks = (submission?.offerIds ?? []).map((offerId) => ({
        field: "quantity" as const,
        offer: { id: offerId },
        status: "SUCCESS" as const,
      }));
      return Promise.resolve({ count: tasks.length, tasks, totalCount: tasks.length });
    },
    listOffers: (params: { offerId?: string } = {}) => {
      offerReads.push(params.offerId);
      // Deliberately does NOT filter. `listOffersByIds` matches the response by id
      // itself, precisely because an ignored or misread filter answers with the wrong
      // offers - so a fake that filtered for it would hide the bug it guards against.
      return Promise.resolve({
        count: offers.length,
        offers,
        totalCount: offers.length,
      });
    },
    offerReads,
    pollOfferQuantityCommand: (commandId: string) => {
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

const setup = (input: {
  rows?: OfferRowFixture[];
  live?: AllegroOffer[];
  variants?: VariantFixture[];
  available?: Record<string, number>;
  stockSyncDisabled?: boolean;
  killSwitchTripsAfterReads?: number;
  claimHeld?: boolean;
  noInventory?: boolean;
}) => {
  const client = fakeClient(input.live ?? []);
  const allegro = fakeAllegroService({
    claimHeld: input.claimHeld,
    client,
    killSwitchTripsAfterReads: input.killSwitchTripsAfterReads,
    offers: input.rows ?? [],
    stockSyncDisabled: input.stockSyncDisabled,
  });
  const logs: string[] = [];
  const container = fakeContainer({
    allegro,
    ...(input.noInventory
      ? {}
      : {
          inventory: {
            retrieveAvailableQuantity: (itemId: string) =>
              Promise.resolve((input.available ?? { inv_1: 9, inv_2: 4 })[itemId] ?? 0),
          },
        }),
    logs,
    variants: input.variants ?? [
      { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
      { id: "v2", inventoryItemIds: ["inv_2"], sku: "SKU-2" },
    ],
  });
  return { allegro, client, container, logs };
};

/** Two mapped, ACTIVE offers; Medusa says 9 and 4, Allegro is showing 5 and 4. */
const twoOffers = (over: Partial<Parameters<typeof setup>[0]> = {}) =>
  setup({
    live: [
      offerFixture({ external: { id: "SKU-1" }, id: "o1", stock: { available: 5 } }),
      offerFixture({ external: { id: "SKU-2" }, id: "o2", stock: { available: 4 } }),
    ],
    rows: [
      { id: "row-1", offer_id: "o1", sku: "SKU-1" },
      { id: "row-2", offer_id: "o2", sku: "SKU-2" },
    ],
    ...over,
  });

describe("pushTargetedAllegroStock", () => {
  it("writes only the named SKU's offer and never pages the catalogue", async () => {
    const { client, container } = twoOffers();

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    // One command, for one offer, at Medusa's quantity. SKU-2 is mismatched too as far
    // as the sweep is concerned, but nobody asked about it.
    expect(client.submissions).toEqual([
      { commandId: expect.any(String), offerIds: ["o1"], value: 9 },
    ]);
    expect(result.synced).toBe(1);
    // Read by id, not paged: an unfiltered read is what makes a sale cost a catalogue
    // pass, which is the entire reason this path is separate from the sweep.
    expect(client.offerReads).toEqual(["o1"]);
  });

  it("pushes the union of a multi-line sale in one command when the quantity agrees", async () => {
    const { client, container } = twoOffers({
      available: { inv_1: 7, inv_2: 7 },
    });

    await pushTargetedAllegroStock(container as never, ["SKU-1", "SKU-2"]);

    // One command per target quantity, exactly as the sweep groups them - the point of
    // coalescing SKUs into one push rather than pushing per event.
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]?.offerIds.sort()).toEqual(["o1", "o2"]);
    expect(client.submissions[0]?.value).toBe(7);
  });

  it("writes nothing and takes no claim when handed no SKUs", async () => {
    const { allegro, client, container } = twoOffers();

    const result = await pushTargetedAllegroStock(container as never, ["", "  "]);

    expect(result.skipped).toBe("no SKUs to push");
    // Taking the claim to discover there is nothing to do would block a reconciliation
    // for no reason.
    expect(allegro.claims).toEqual([]);
    expect(client.submissions).toEqual([]);
  });

  it("stands down when a reconciliation already holds the stock claim", async () => {
    const { client, container } = twoOffers({ claimHeld: true });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    // The collision this path makes likely rather than theoretical: the sweep runs on a
    // schedule, the event push fires whenever a sale happens, and two runs setting
    // quantities on one offer is what single-flight exists to prevent.
    expect(result.skipped).toContain("in progress");
    expect(client.submissions).toEqual([]);
  });

  it("stops mid-flight when the kill switch is flipped, without writing", async () => {
    // Clear at the pre-claim read, disabled by the first per-command fence.
    const { client, container } = twoOffers({ killSwitchTripsAfterReads: 1 });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    expect(client.submissions).toEqual([]);
    expect(result.error).toContain("stopped mid-flight");
  });

  it("refuses to run at all while stock sync is disabled", async () => {
    const { client, container } = twoOffers({ stockSyncDisabled: true });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    expect(result.skipped).toContain("stock sync is disabled");
    expect(client.submissions).toEqual([]);
  });

  it("refuses the WHOLE push when a quantity could not be read", async () => {
    // No inventory module: the quantity is unknown rather than absent, and its blast
    // radius is unknown with it.
    const { client, container } = twoOffers({ noInventory: true });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1", "SKU-2"]);

    // Not "push the one we are sure about". A partial push leaves some offers fresh and
    // others stale with nothing recording which is which, and the next run cannot tell
    // either - the same rule the sweep follows, inherited rather than restated.
    expect(client.submissions).toEqual([]);
    expect(result.unresolved).toBeGreaterThan(0);
    expect(result.error).toContain("whole plan was refused");
  });

  it("refuses the whole push when a SKU matches more than one variant", async () => {
    const { client, container } = twoOffers({
      variants: [
        { id: "v1", inventoryItemIds: ["inv_1"], sku: "SKU-1" },
        // Two variants claiming one SKU: which one's quantity belongs on the offer is
        // not a decision this plugin may take.
        { id: "v1b", inventoryItemIds: ["inv_2"], sku: "SKU-1" },
      ],
    });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    expect(client.submissions).toEqual([]);
    expect(result.ambiguous).toBe(1);
  });

  it("does not write to an offer whose sygnatura no longer matches its mapping row", async () => {
    const { client, container } = twoOffers({
      live: [
        // The seller renamed the sygnatura between discovery and now. Re-pairing on the
        // live value is what pushed one variant's quantity onto another's listing.
        offerFixture({ external: { id: "SOMETHING-ELSE" }, id: "o1", stock: { available: 5 } }),
      ],
      rows: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
    });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    expect(client.submissions).toEqual([]);
    expect(result.conflicted).toBe(1);
  });

  it("skips an offer the mapping row marks conflicted", async () => {
    const { client, container } = twoOffers({
      rows: [
        { conflict: "sku-mismatch", id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o2", sku: "SKU-2" },
      ],
    });

    await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    // A conflicted row authorises nothing, on this path exactly as on the sweep.
    expect(client.submissions).toEqual([]);
  });

  it("writes nothing when Allegro already carries the quantity", async () => {
    const { client, container } = twoOffers({ available: { inv_1: 5 } });

    const result = await pushTargetedAllegroStock(container as never, ["SKU-1"]);

    // The event is a hint that a SKU is worth re-reading, never a source of quantity:
    // an event for a variant whose offer is already correct costs one read and no write.
    expect(client.submissions).toEqual([]);
    expect(result.alreadyInSync).toBe(1);
  });
});
