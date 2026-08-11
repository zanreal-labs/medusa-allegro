import type { AllegroOffer } from "../../allegro/types";
import {
  buildStockCommandChunks,
  isStockCoverageComplete,
  isStockPlanSafe,
  planStockSync,
  STOCK_COMMAND_SIZE,
} from "../stock-plan";
import type { VariantStock } from "../stock-plan";

const offer = (over: Partial<AllegroOffer> & { id: string }): AllegroOffer => ({
  publication: { status: "ACTIVE" },
  stock: { available: 5 },
  ...over,
});

const linked = (id: string, sku: string, over: Partial<AllegroOffer> = {}): AllegroOffer =>
  offer({ external: { id: sku }, id, ...over });

describe("planStockSync", () => {
  it("plans a write when the quantities differ", () => {
    const plan = planStockSync([{ quantity: 9, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
    expect(plan).toMatchObject({ alreadyInSync: 0, eligible: 1, mismatched: 1 });
  });

  it("counts an offer already at the desired quantity", () => {
    const plan = planStockSync([{ quantity: 5, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.changes).toEqual([]);
    expect(plan).toMatchObject({ alreadyInSync: 1, eligible: 1, mismatched: 0 });
  });

  it("plans a write down to zero", () => {
    // Zero is a real quantity, not an absence. Refusing to push it is how a
    // sold-out item stays purchasable on the marketplace.
    const plan = planStockSync([{ quantity: 0, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.changes).toEqual([{ desired: 0, offerId: "o1" }]);
  });

  it("falls back to the EAN when the offer carries no sygnatura", () => {
    const plan = planStockSync(
      [{ quantity: 9, sku: "5901234123457" }],
      [offer({ ean: "5901234123457", id: "o1" })],
    );
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
  });

  it("counts a non-ACTIVE offer as skipped rather than eligible", () => {
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-1" }],
      [linked("o1", "SKU-1", { publication: { status: "ENDED" } })],
    );
    expect(plan.changes).toEqual([]);
    expect(plan).toMatchObject({ eligible: 0, skippedInactive: 1 });
  });

  it("counts an ambiguous match and writes nothing for it", () => {
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [linked("o1", "SKU-1")],
    );
    expect(plan.changes).toEqual([]);
    expect(plan.ambiguous).toBe(1);
  });

  it("counts an unreadable offer quantity as unresolved, never as zero", () => {
    const plan = planStockSync(
      [{ quantity: 9, sku: "SKU-1" }],
      [linked("o1", "SKU-1", { stock: {} })],
    );
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toBe(1);
    // The offer is still counted as eligible: it IS a writable offer, the delta is
    // simply not computable. Conflating the two would hide the difference between
    // "not ours" and "we could not read it".
    expect(plan.eligible).toBe(1);
  });

  it("counts an unreadable variant quantity as unresolved", () => {
    const plan = planStockSync([{ sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.unresolved).toBe(1);
  });

  it("refuses a negative desired quantity", () => {
    const plan = planStockSync([{ quantity: -1, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.unresolved).toBe(1);
    expect(plan.changes).toEqual([]);
  });

  it("refuses a fractional desired quantity", () => {
    const plan = planStockSync([{ quantity: 1.5, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(plan.unresolved).toBe(1);
  });

  it("counts a variant no offer claimed", () => {
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 4, sku: "SKU-ORPHAN" },
      ],
      [linked("o1", "SKU-1")],
    );
    expect(plan.skippedUnlinked).toBe(1);
  });

  it("ignores an offer that matches no variant at all", () => {
    // Not this store's offer, or not in the Allegro sales channel. It is neither a
    // skip nor a conflict here - discovery is what reports it.
    const plan = planStockSync([], [linked("o1", "SKU-UNKNOWN")]);
    expect(plan).toMatchObject({
      ambiguous: 0,
      changes: [],
      eligible: 0,
      skippedInactive: 0,
      unresolved: 0,
    });
  });

  it("ignores an offer with neither sygnatura nor EAN", () => {
    const plan = planStockSync([{ quantity: 9, sku: "SKU-1" }], [offer({ id: "o1" })]);
    expect(plan.changes).toEqual([]);
    expect(plan.skippedUnlinked).toBe(1);
  });

  it("treats a blank sygnatura as absent and falls through to the EAN", () => {
    const plan = planStockSync(
      [{ quantity: 9, sku: "5901234123457" }],
      [offer({ ean: "5901234123457", external: { id: "   " }, id: "o1" })],
    );
    expect(plan.changes).toEqual([{ desired: 9, offerId: "o1" }]);
  });

  it("counts an ambiguous match as matched, so it is not also reported unlinked", () => {
    // Double-reporting one problem in two buckets makes the totals lie.
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [linked("o1", "SKU-1")],
    );
    expect(plan.skippedUnlinked).toBe(0);
  });
});

describe("isStockPlanSafe", () => {
  it("refuses a plan with an ambiguous match", () => {
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 3, sku: "SKU-1" },
      ],
      [linked("o1", "SKU-1")],
    );
    expect(isStockPlanSafe(plan)).toBe(false);
  });

  it("refuses a plan with an unresolved quantity", () => {
    // A partial quantity push is worse than none: some offers get a fresh figure
    // and others keep a stale one, with no record of which is which.
    const plan = planStockSync([{ sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(isStockPlanSafe(plan)).toBe(false);
  });

  it("accepts a plan whose only gaps are inactive or unlinked", () => {
    // Those are known, bounded exclusions rather than unknowns: an inactive offer
    // has no meaningful quantity, and an unclaimed variant has no offer to write to.
    const plan = planStockSync(
      [
        { quantity: 9, sku: "SKU-1" },
        { quantity: 1, sku: "SKU-ORPHAN" },
      ],
      [linked("o1", "SKU-1"), linked("o2", "SKU-2", { publication: { status: "ENDED" } })],
    );
    expect(isStockPlanSafe(plan)).toBe(true);
    expect(isStockCoverageComplete(plan)).toBe(false);
  });
});

describe("isStockCoverageComplete", () => {
  it("is true only when nothing was skipped", () => {
    const plan = planStockSync([{ quantity: 9, sku: "SKU-1" }], [linked("o1", "SKU-1")]);
    expect(isStockCoverageComplete(plan)).toBe(true);
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
});
