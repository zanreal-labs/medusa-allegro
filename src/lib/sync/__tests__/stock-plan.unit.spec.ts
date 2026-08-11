import type { AllegroOffer } from "../../allegro/types";
import {
  buildStockCommandChunks,
  isStockCoverageComplete,
  isStockPlanSafe,
  planStockSync,
  STOCK_COMMAND_SIZE,
} from "../stock-plan";
import type { AuthorizedOffer, VariantStock } from "../stock-plan";

const offer = (over: Partial<AllegroOffer> & { id: string }): AllegroOffer => ({
  publication: { status: "ACTIVE" },
  stock: { available: 5 },
  ...over,
});

const linked = (id: string, sku: string, over: Partial<AllegroOffer> = {}): AllegroOffer =>
  offer({ external: { id: sku }, id, ...over });

/**
 * The authorised pairs a healthy mapping table would hold for these offers.
 *
 * Derived from each offer's sygnatura, which is what discovery would have recorded. Stated
 * explicitly per test wherever the point IS that the row and the listing disagree - that
 * disagreement is no longer something the planner is allowed to resolve on its own.
 */
const authorize = (...offers: AllegroOffer[]): AuthorizedOffer[] =>
  offers
    .filter((entry) => entry.external?.id?.trim())
    .map((entry) => ({ offerId: entry.id, sku: entry.external?.id?.trim() as string }));

/** A plan over one offer/variant pair whose mapping row agrees with the listing. */
const planOne = (variant: VariantStock, live: AllegroOffer, authorized?: AuthorizedOffer[]) =>
  planStockSync([variant], [live], authorized ?? authorize(live));

describe("planStockSync", () => {
  it("plans a write when the quantities differ", () => {
    const plan = planOne({ quantity: 9, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
    expect(plan).toMatchObject({ alreadyInSync: 0, eligible: 1, mismatched: 1 });
  });

  it("counts an offer already at the desired quantity", () => {
    const plan = planOne({ quantity: 5, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.changes).toEqual([]);
    expect(plan).toMatchObject({ alreadyInSync: 1, eligible: 1, mismatched: 0 });
  });

  it("plans a write down to zero", () => {
    // Zero is a real quantity, not an absence. Refusing to push it is how a
    // sold-out item stays purchasable on the marketplace.
    const plan = planOne({ quantity: 0, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.changes).toEqual([{ desired: 0, offerId: "o1" }]);
  });

  it("counts a non-ACTIVE offer as skipped rather than eligible", () => {
    const plan = planOne(
      { quantity: 9, sku: "SKU-1" },
      linked("o1", "SKU-1", { publication: { status: "ENDED" } }),
    );
    expect(plan.changes).toEqual([]);
    expect(plan).toMatchObject({ eligible: 0, skippedInactive: 1 });
  });

  it("counts an ambiguous match and writes nothing for it", () => {
    const live = linked("o1", "SKU-1");
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [live],
      authorize(live),
    );
    expect(plan.changes).toEqual([]);
    expect(plan.ambiguous).toBe(1);
  });

  it("counts an unreadable offer quantity as unresolved, never as zero", () => {
    const plan = planOne({ quantity: 9, sku: "SKU-1" }, linked("o1", "SKU-1", { stock: {} }));
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toBe(1);
    // The offer is still counted as eligible: it IS a writable offer, the delta is
    // simply not computable. Conflating the two would hide the difference between
    // "not ours" and "we could not read it".
    expect(plan.eligible).toBe(1);
  });

  it("counts an unreadable variant quantity as unresolved", () => {
    const plan = planOne({ absent: "unreadable", sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.unresolved).toBe(1);
  });

  it("refuses a negative desired quantity", () => {
    const plan = planOne({ quantity: -1, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.unresolved).toBe(1);
    expect(plan.changes).toEqual([]);
  });

  it("refuses a fractional desired quantity", () => {
    const plan = planOne({ quantity: 1.5, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(plan.unresolved).toBe(1);
  });

  it("counts a variant no authorised offer claimed", () => {
    const live = linked("o1", "SKU-1");
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 4, sku: "SKU-ORPHAN" },
      ],
      [live],
      authorize(live),
    );
    expect(plan.skippedUnlinked).toBe(1);
  });

  it("counts an ambiguous match as claimed, so it is not also reported unlinked", () => {
    // Double-reporting one problem in two buckets makes the totals lie.
    const live = linked("o1", "SKU-1");
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [live],
      authorize(live),
    );
    expect(plan.skippedUnlinked).toBe(0);
  });
});

describe("planStockSync: the mapping row supplies the pairing", () => {
  it("pushes the quantity of the variant the ROW records, not the live sygnatura", () => {
    // The core of the fix. The row is what authorises the write, so it is also what says
    // which variant the quantity comes from. Re-deriving that from the live listing let a
    // seller's sygnatura edit silently re-point the write.
    const live = linked("o1", "SKU-1");
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-1" }],
      [live],
      [{ offerId: "o1", sku: "SKU-1" }],
    );
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
  });

  it("records a conflict and writes nothing when the live sygnatura differs from the row", () => {
    // The seller-edit race: discovery mapped offer o1 to SKU-A, then the seller changed the
    // sygnatura to SKU-B. The old planner re-derived the pairing from the listing and
    // pushed SKU-B's quantity to a listing the row said was product A's.
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-A" },
        { quantity: 77, sku: "SKU-B" },
      ],
      [linked("o1", "SKU-B")],
      [{ offerId: "o1", sku: "SKU-A" }],
    );

    expect(plan.changes).toEqual([]);
    expect(plan.conflicted).toBe(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      conflict: "sku-mismatch",
      offerId: "o1",
      sku: "SKU-A",
    });
    expect(plan.conflicts[0]?.conflict_detail).toContain("SKU-B");
    // Skipped and counted, not a whole-plan refusal: this is a KNOWN, bounded problem.
    expect(isStockPlanSafe(plan)).toBe(true);
    expect(isStockCoverageComplete(plan)).toBe(false);
  });

  it("keeps writing the other offers when one contradicts its row", () => {
    // A recorded conflict must not become a catalogue-wide outage.
    const good = linked("o2", "SKU-OK");
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-A" },
        { quantity: 4, sku: "SKU-OK" },
      ],
      [linked("o1", "SKU-RENAMED"), good],
      [
        { offerId: "o1", sku: "SKU-A" },
        { offerId: "o2", sku: "SKU-OK" },
      ],
    );

    expect(plan.changes).toEqual([{ desired: 4, offerId: "o2" }]);
    expect(plan.conflicted).toBe(1);
  });

  it("plans an EAN-linked offer's quantity, matching barcode to barcode", () => {
    // The EAN path used to look the offer's EAN up in the SKU map, so an offer linked by
    // barcode matched nothing, fell through UNCOUNTED, and had its quantity published
    // nowhere while the run reported a clean success. The variant's barcode is what the
    // offer's EAN is compared against now, exactly as discovery does it.
    const live = offer({ ean: "5901234123457", id: "o1" });
    const plan = planStockSync(
      [{ ean: "5901234123457", quantity: 9, sku: "SKU-1" }],
      [live],
      [{ offerId: "o1", sku: "SKU-1" }],
    );

    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
    expect(plan.conflicted).toBe(0);
  });

  it("conflicts an EAN-linked offer whose EAN no longer matches the variant barcode", () => {
    const plan = planStockSync(
      [{ ean: "5901234123457", quantity: 9, sku: "SKU-1" }],
      [offer({ ean: "9999999999999", id: "o1" })],
      [{ offerId: "o1", sku: "SKU-1" }],
    );

    expect(plan.changes).toEqual([]);
    expect(plan.conflicted).toBe(1);
  });

  it("conflicts an offer that carries neither a sygnatura nor an EAN", () => {
    // Nothing on Allegro corroborates the mapping, and a blanked sygnatura is the same
    // seller edit as a renamed one.
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-1" }],
      [offer({ id: "o1" })],
      [{ offerId: "o1", sku: "SKU-1" }],
    );

    expect(plan.changes).toEqual([]);
    expect(plan.conflicted).toBe(1);
    expect(plan.conflicts[0]?.conflict_detail).toContain("neither a sygnatura nor an EAN");
  });

  it("treats a blank sygnatura as absent and falls through to the EAN", () => {
    const plan = planStockSync(
      [{ ean: "5901234123457", quantity: 9, sku: "SKU-1" }],
      [offer({ ean: "5901234123457", external: { id: "   " }, id: "o1" })],
      [{ offerId: "o1", sku: "SKU-1" }],
    );
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
  });

  it("counts an authorised offer that is absent from the listing", () => {
    // Previously invisible: no bucket at all, so an offer whose quantity was published
    // nowhere left no trace in the summary.
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-1" }],
      [],
      [{ offerId: "o-gone", sku: "SKU-1" }],
    );

    expect(plan.skippedUnmatched).toBe(1);
    expect(plan.changes).toEqual([]);
    expect(isStockCoverageComplete(plan)).toBe(false);
  });

  it("counts an authorised offer whose SKU is not an eligible variant", () => {
    const plan = planStockSync(
      [],
      [linked("o1", "SKU-GONE")],
      [{ offerId: "o1", sku: "SKU-GONE" }],
    );
    expect(plan.skippedUnmatched).toBe(1);
  });

  it("ignores a live offer the mapping table does not authorise", () => {
    // Not this store's offer, or held out by a discovery conflict. It is not counted here at
    // all, because the authorised set is what the contract is about.
    const plan = planStockSync([{ quantity: 9, sku: "SKU-1" }], [linked("o1", "SKU-1")], []);
    expect(plan).toMatchObject({ ambiguous: 0, changes: [], conflicted: 0, eligible: 0 });
    // The variant is still reported as claimed by nobody.
    expect(plan.skippedUnlinked).toBe(1);
  });
});

describe("planStockSync: a variant with no inventory does not wedge the catalogue", () => {
  it("skips it in its own bucket rather than refusing the plan", () => {
    // The availability bug: a variant that does not manage inventory has no quantity, which
    // used to be indistinguishable from "we could not read the quantity" and therefore
    // refused the WHOLE plan. One digital product with an Allegro offer stopped stock sync
    // for every other offer, indefinitely.
    const plan = planStockSync(
      [
        { absent: "no-inventory", sku: "SKU-DIGITAL" },
        { quantity: 9, sku: "SKU-1" },
      ],
      [linked("o1", "SKU-DIGITAL"), linked("o2", "SKU-1")],
      [
        { offerId: "o1", sku: "SKU-DIGITAL" },
        { offerId: "o2", sku: "SKU-1" },
      ],
    );

    expect(plan.skippedNoInventory).toBe(1);
    expect(plan.unresolved).toBe(0);
    // Safe, so the healthy offer still gets its quantity.
    expect(isStockPlanSafe(plan)).toBe(true);
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o2" }]);
    // But not complete: its quantity is published nowhere.
    expect(isStockCoverageComplete(plan)).toBe(false);
  });

  it("still refuses the plan when a quantity could not be READ", () => {
    // The contrast. An unreadable quantity is an unknown of unknown blast radius, so the
    // whole plan is refused exactly as before.
    const plan = planStockSync(
      [
        { absent: "unreadable", sku: "SKU-BROKEN" },
        { quantity: 9, sku: "SKU-1" },
      ],
      [linked("o1", "SKU-BROKEN"), linked("o2", "SKU-1")],
      [
        { offerId: "o1", sku: "SKU-BROKEN" },
        { offerId: "o2", sku: "SKU-1" },
      ],
    );

    expect(plan.unresolved).toBe(1);
    expect(isStockPlanSafe(plan)).toBe(false);
  });
});

describe("isStockPlanSafe", () => {
  it("refuses a plan with an ambiguous match", () => {
    const live = linked("o1", "SKU-1");
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [live],
      authorize(live),
    );
    expect(isStockPlanSafe(plan)).toBe(false);
  });

  it("refuses a plan with an unresolved quantity", () => {
    // A partial quantity push is worse than none: some offers get a fresh figure
    // and others keep a stale one, with no record of which is which.
    const plan = planOne({ absent: "unreadable", sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(isStockPlanSafe(plan)).toBe(false);
  });

  it("accepts a plan whose only gaps are inactive or unlinked", () => {
    // Those are known, bounded exclusions rather than unknowns: an inactive offer
    // has no meaningful quantity, and an unclaimed variant has no offer to write to.
    const active = linked("o1", "SKU-1");
    const ended = linked("o2", "SKU-2", { publication: { status: "ENDED" } });
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 1, sku: "SKU-ORPHAN" },
        { quantity: 1, sku: "SKU-2" },
      ],
      [active, ended],
      authorize(active, ended),
    );
    expect(isStockPlanSafe(plan)).toBe(true);
    expect(isStockCoverageComplete(plan)).toBe(false);
  });
});

describe("isStockCoverageComplete", () => {
  it("is true only when nothing was skipped", () => {
    const plan = planOne({ quantity: 9, sku: "SKU-1" }, linked("o1", "SKU-1"));
    expect(isStockCoverageComplete(plan)).toBe(true);
  });

  it("is false when an offer contradicts its mapping row", () => {
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-A" }],
      [linked("o1", "SKU-B")],
      [{ offerId: "o1", sku: "SKU-A" }],
    );
    expect(isStockCoverageComplete(plan)).toBe(false);
  });
});

describe("buildStockCommandChunks", () => {
  it("groups by target quantity", () => {
    // Forced by the API: one command sets ONE fixed value across every offer it
    // names. It is also what makes a full reconciliation cheap.
    const chunks = buildStockCommandChunks([
      { desired: 5, offerId: "a" },
      { desired: 9, offerId: "b" },
      { desired: 5, offerId: "c" },
    ]);
    expect(chunks).toEqual([
      [
        { desired: 5, offerId: "a" },
        { desired: 5, offerId: "c" },
      ],
      [{ desired: 9, offerId: "b" }],
    ]);
  });

  it("chunks a large group to the command size", () => {
    const changes = Array.from({ length: 5 }, (_, index) => ({
      desired: 5,
      offerId: `o${index}`,
    }));
    const chunks = buildStockCommandChunks(changes, 2);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2, 1]);
  });

  it("defaults to Allegro's 1,000-offer limit", () => {
    const changes = Array.from({ length: STOCK_COMMAND_SIZE + 1 }, (_, index) => ({
      desired: 5,
      offerId: `o${index}`,
    }));
    const chunks = buildStockCommandChunks(changes);
    expect(chunks.map((chunk) => chunk.length)).toEqual([STOCK_COMMAND_SIZE, 1]);
  });

  it("produces nothing for an empty plan", () => {
    expect(buildStockCommandChunks([])).toEqual([]);
  });

  it("refuses a non-positive command size instead of looping forever", () => {
    // A zero or negative stride makes the slicing loop never advance, so this hung the
    // stock run rather than failing it - the hardest failure of the lot to diagnose,
    // because a wedged loop looks exactly like a slow Allegro.
    expect(() => buildStockCommandChunks([{ desired: 1, offerId: "o1" }], 0)).toThrow(
      /positive integer/u,
    );
    expect(() => buildStockCommandChunks([{ desired: 1, offerId: "o1" }], -5)).toThrow(
      /positive integer/u,
    );
    expect(() => buildStockCommandChunks([{ desired: 1, offerId: "o1" }], 1.5)).toThrow(
      /positive integer/u,
    );
  });
});
