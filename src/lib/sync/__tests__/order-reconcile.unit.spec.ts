import type { AllegroCheckoutForm } from "../../allegro/types";
import {
  advanceReconcileMarks,
  classifyReconcileTier,
  DEFAULT_RECONCILE_CADENCE,
  dueReconcileTiers,
  isFullyPaid,
  planOrderPayment,
  readPaymentFacts,
  readReconcileMarks,
  resolveReconcileCadence,
  selectReconcileBatch,
  TERMINAL_DERIVED_STATUSES,
} from "../order-reconcile";
import type { OrderPaymentState, ReconcileRow, ReconcileTier } from "../order-reconcile";

const row = (patch: Partial<ReconcileRow> = {}): ReconcileRow => ({
  checkout_form_id: "form-1",
  derived_status: "new",
  id: "algorder_1",
  medusa_order_id: "order_1",
  ...patch,
});

const paid = (patch: Partial<OrderPaymentState> = {}): OrderPaymentState => ({
  capturedMinor: 20_600,
  collections: 1,
  totalMinor: 20_600,
  ...patch,
});

const unpaid = (): OrderPaymentState => paid({ capturedMinor: 0, collections: 0 });

describe("classifyReconcileTier", () => {
  it("puts an order with no registered payment in the fast tier", () => {
    expect(classifyReconcileTier(row(), unpaid())).toBe("unpaid");
  });

  it("puts a paid but unfinished order in the slow tier", () => {
    expect(classifyReconcileTier(row({ derived_status: "sent" }), paid())).toBe("open");
  });

  it("treats a row with no Medusa order at all as the most urgent case", () => {
    // The sale exists on Allegro and nothing here represents it. That is exactly what a
    // lost event looks like, so it belongs in the tier that runs every tick.
    expect(classifyReconcileTier(row({ medusa_order_id: null }), undefined)).toBe("unpaid");
  });

  it("sweeps nothing that has reached the end of the ladder", () => {
    for (const status of TERMINAL_DERIVED_STATUSES) {
      expect(classifyReconcileTier(row({ derived_status: status }), paid())).toBeUndefined();
    }
  });

  it("stops sweeping a cancelled order even though it will never be paid", () => {
    // Otherwise the fast tier accumulates every abandoned checkout the store ever saw.
    expect(classifyReconcileTier(row({ derived_status: "cancelled" }), unpaid())).toBeUndefined();
  });

  it("keeps sweeping a `sent` order, because Allegro still moves it to picked-up", () => {
    expect(classifyReconcileTier(row({ derived_status: "sent" }), paid())).toBe("open");
  });

  it("reads an unknown payment state as unpaid rather than as paid", () => {
    // Fail-safe direction: an extra re-read costs one request; assuming paid loses the sale.
    expect(classifyReconcileTier(row(), undefined)).toBe("unpaid");
  });

  it("counts an overpayment as covered", () => {
    expect(isFullyPaid(paid({ capturedMinor: 20_601 }))).toBe(true);
    expect(isFullyPaid(paid({ capturedMinor: 20_599 }))).toBe(false);
  });
});

describe("selectReconcileBatch", () => {
  const rows = [
    row({ checkout_form_id: "a", id: "1", medusa_order_id: "order_a" }),
    row({ checkout_form_id: "b", derived_status: "sent", id: "2", medusa_order_id: "order_b" }),
    row({ checkout_form_id: "c", derived_status: "delivered", id: "3", medusa_order_id: "order_c" }),
    row({ checkout_form_id: "d", id: "4", medusa_order_id: "order_d" }),
  ];
  const states = new Map<string, OrderPaymentState>([
    ["order_a", unpaid()],
    ["order_b", paid()],
    ["order_c", paid()],
    ["order_d", unpaid()],
  ]);
  const paymentFor = (candidate: ReconcileRow): OrderPaymentState | undefined =>
    candidate.medusa_order_id ? states.get(candidate.medusa_order_id) : undefined;

  it("selects only the tiers that are due", () => {
    const only = new Set<ReconcileTier>(["unpaid"]);
    expect(selectReconcileBatch(rows, only, paymentFor, 10).map((r) => r.checkout_form_id)).toEqual([
      "a",
      "d",
    ]);
  });

  it("includes the slow tier when it is due too", () => {
    const both = new Set<ReconcileTier>(["open", "unpaid"]);
    expect(selectReconcileBatch(rows, both, paymentFor, 10).map((r) => r.checkout_form_id)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("stops at the batch limit rather than sweeping a backlog in one run", () => {
    const both = new Set<ReconcileTier>(["open", "unpaid"]);
    expect(selectReconcileBatch(rows, both, paymentFor, 2)).toHaveLength(2);
  });

  it("never selects a terminal row", () => {
    const both = new Set<ReconcileTier>(["open", "unpaid"]);
    const picked = selectReconcileBatch(rows, both, paymentFor, 10);
    expect(picked.some((r) => r.checkout_form_id === "c")).toBe(false);
  });
});

describe("resolveReconcileCadence", () => {
  it("sweeps the unpaid tier on every tick by default", () => {
    expect(resolveReconcileCadence({}).unpaidIntervalMs).toBe(0);
    expect(resolveReconcileCadence({}).openIntervalMs).toBe(900_000);
  });

  it("takes the intervals from the environment", () => {
    const cadence = resolveReconcileCadence({
      ALLEGRO_ORDERS_RECONCILE_BATCH: "10",
      ALLEGRO_ORDERS_RECONCILE_OPEN_INTERVAL_MS: "600000",
      ALLEGRO_ORDERS_RECONCILE_UNPAID_INTERVAL_MS: "60000",
    });
    expect(cadence).toEqual({ batchLimit: 10, openIntervalMs: 600_000, unpaidIntervalMs: 60_000 });
  });

  it("falls back rather than scheduling something nonsensical", () => {
    const cadence = resolveReconcileCadence({
      ALLEGRO_ORDERS_RECONCILE_BATCH: "0",
      ALLEGRO_ORDERS_RECONCILE_OPEN_INTERVAL_MS: "soon",
      ALLEGRO_ORDERS_RECONCILE_UNPAID_INTERVAL_MS: "-1",
    });
    expect(cadence.openIntervalMs).toBe(DEFAULT_RECONCILE_CADENCE.openIntervalMs);
    expect(cadence.unpaidIntervalMs).toBe(DEFAULT_RECONCILE_CADENCE.unpaidIntervalMs);
    // A batch of zero would sweep nothing forever, which is worse than ignoring the value.
    expect(cadence.batchLimit).toBe(1);
  });
});

describe("reconcile marks", () => {
  const cadence = { batchLimit: 50, openIntervalMs: 900_000, unpaidIntervalMs: 0 };

  it("treats a tier that has never been swept as due", () => {
    expect([...dueReconcileTiers(1_000, {}, cadence)].sort()).toEqual(["open", "unpaid"]);
  });

  it("holds the slow tier back until its interval elapses", () => {
    const marks = { openAt: 1_000, unpaidAt: 1_000 };
    expect([...dueReconcileTiers(2_000, marks, cadence)]).toEqual(["unpaid"]);
    expect([...dueReconcileTiers(901_000, marks, cadence)].sort()).toEqual(["open", "unpaid"]);
  });

  it("does not reset the other tier's clock when only one is swept", () => {
    // The bug this guards: a fast sweep every 20s that also stamps the slow mark means the
    // slow tier's interval never elapses and it never runs at all.
    const advanced = advanceReconcileMarks(2_000, { openAt: 1_000 }, new Set<ReconcileTier>(["unpaid"]));
    expect(advanced).toEqual({ openAt: 1_000, unpaidAt: 2_000 });
  });

  it("survives a round trip through the persisted counts blob", () => {
    const marks = advanceReconcileMarks(5_000, {}, new Set<ReconcileTier>(["open", "unpaid"]));
    expect(readReconcileMarks({ created: 3, reconcile: marks })).toEqual(marks);
  });

  it("reads anything else as never swept rather than throwing", () => {
    expect(readReconcileMarks(null)).toEqual({});
    expect(readReconcileMarks(undefined)).toEqual({});
    expect(readReconcileMarks({ reconcile: "yesterday" })).toEqual({});
    expect(readReconcileMarks({ reconcile: { openAt: "soon" } })).toEqual({});
  });
});

describe("readPaymentFacts", () => {
  it("reads the money block Allegro sends", () => {
    const form = {
      id: "form-1",
      payment: {
        finishedAt: "2026-08-19T18:20:00Z",
        paidAmount: { amount: "206.00", currency: "PLN" },
        type: "ONLINE",
      },
    } as AllegroCheckoutForm;
    expect(readPaymentFacts(form)).toEqual({
      amount: 206,
      currency: "pln",
      finishedAt: "2026-08-19T18:20:00Z",
      type: "ONLINE",
    });
  });

  it("reports nothing for a form that carries no payment block", () => {
    expect(readPaymentFacts({ id: "form-1" } as AllegroCheckoutForm)).toEqual({});
  });
});

describe("planOrderPayment", () => {
  const facts = {
    amount: 206,
    currency: "pln",
    finishedAt: "2026-08-19T18:20:00Z",
    type: "ONLINE" as const,
  };

  it("registers the payment for an online order the buyer has paid", () => {
    const plan = planOrderPayment(facts, unpaid(), "pln");
    expect(plan).toMatchObject({ amount: 206, currencyCode: "pln", kind: "register" });
    expect(plan.kind === "register" && plan.capturedAt.toISOString()).toBe(
      "2026-08-19T18:20:00.000Z",
    );
  });

  it("refuses when Allegro reports no finished payment", () => {
    // READY_FOR_PROCESSING alone is not proof money moved, and inventing a capture would
    // have an invoice issued for money nobody received.
    expect(planOrderPayment({ ...facts, finishedAt: undefined }, unpaid(), "pln")).toMatchObject({
      kind: "skip",
    });
  });

  it("refuses cash on delivery, which Allegro also reports as ready for processing", () => {
    const plan = planOrderPayment({ ...facts, type: "CASH_ON_DELIVERY" }, unpaid(), "pln");
    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" && plan.reason).toContain("pays on delivery");
  });

  it("is a no-op on an order that is already paid, which is what makes a re-run safe", () => {
    expect(planOrderPayment(facts, paid(), "pln")).toEqual({
      kind: "skip",
      reason: "already paid in full",
    });
  });

  it("refuses to stack a second collection on a partially paid order", () => {
    const plan = planOrderPayment(facts, paid({ capturedMinor: 10_000 }), "pln");
    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" && plan.reason).toContain("a human decides");
  });

  it("refuses when the currencies do not match", () => {
    expect(planOrderPayment({ ...facts, currency: "eur" }, unpaid(), "pln")).toMatchObject({
      kind: "skip",
    });
  });

  it("refuses when the payment state could not be read", () => {
    expect(planOrderPayment(facts, undefined, "pln")).toMatchObject({ kind: "skip" });
  });

  it("registers what Allegro says was paid, not the larger Medusa total", () => {
    // Recording the Medusa total would show an order paid in full that is not - the same
    // fabrication the `finishedAt` check exists to prevent.
    const plan = planOrderPayment({ ...facts, amount: 200 }, unpaid(), "pln");
    expect(plan).toMatchObject({ amount: 200, kind: "register" });
    expect(plan.kind === "register" && plan.shortfall).toContain("206");
  });

  it("falls back to the order total when Allegro finished a payment without echoing an amount", () => {
    const plan = planOrderPayment({ ...facts, amount: undefined }, unpaid(), "pln");
    expect(plan).toMatchObject({ amount: 206, kind: "register" });
    expect(plan.kind === "register" && plan.shortfall).toBeUndefined();
  });
});
