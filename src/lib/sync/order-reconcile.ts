import type { AllegroCheckoutForm } from "../allegro/types";
import { parseAmount } from "./money";
import type { DerivedOrderStatus } from "./order-status";

/**
 * The reconciliation sweep: re-check open Allegro orders instead of trusting the
 * event journal to have named every one of them.
 *
 * The event drain is the fast path and stays the fast path. This is the loop
 * underneath it, and it exists because the drain has exactly one failure mode that
 * nothing else recovers from: an event that is consumed but not applied moves the
 * cursor past itself. A payment that finalized during such a window is money the
 * store never learns about, and no retry looks at it again - the journal has moved
 * on and the order sits `pending` forever.
 *
 * Re-reading the checkout form is authoritative, cheap, and idempotent: the whole
 * apply path keys on `checkout_form_id`, so a form that is already consistent
 * costs one Allegro read and writes nothing.
 *
 * ## Two tiers, because the two questions have very different urgency
 *
 * - **`unpaid`** - an order whose Medusa payment does not yet cover its total.
 *   This is the window in which the buyer is actively paying, and it is where a
 *   lost event costs the most: no payment means no invoice and no fulfillment.
 *   Swept on EVERY drain tick.
 * - **`open`** - paid, but not finished: awaiting shipment, in transit. A lost
 *   event here delays a status label, not the money. Swept on a slow interval.
 *
 * An order in a terminal state is swept by neither. Nothing upstream will move it
 * again, so re-reading it forever is pure API cost.
 */

/**
 * Statuses at the end of the ladder: cancelled, fully returned, or picked up.
 *
 * `sent` is deliberately NOT here. Allegro still moves an order from `SENT` to
 * `PICKED_UP`, and a sweep that stopped at `sent` would leave every delivered order
 * reading as in-transit for good.
 */
export const TERMINAL_DERIVED_STATUSES: ReadonlySet<DerivedOrderStatus> = new Set<DerivedOrderStatus>(
  ["cancelled", "delivered", "returned"],
);

/** Which sweep an order belongs to, or `undefined` when it needs neither. */
export type ReconcileTier = "unpaid" | "open";

/** The bookkeeping row as the sweep reads it. */
export interface ReconcileRow {
  id: string;
  checkout_form_id: string;
  medusa_order_id?: string | null;
  derived_status?: DerivedOrderStatus | null;
}

/**
 * Whether the Medusa order's registered payments cover its total.
 *
 * Compared in minor units, like every other money comparison in this plugin: a
 * float comparison of 206 against 205.99999999999997 is how an order that is paid
 * to the grosz reads as underpaid.
 */
export interface OrderPaymentState {
  /** The order's own total, in minor units. */
  totalMinor: number;
  /** Captured across every payment collection linked to the order, net of refunds. */
  capturedMinor: number;
  /** How many payment collections the order already carries. */
  collections: number;
}

export const isFullyPaid = (state: OrderPaymentState | undefined): boolean =>
  state !== undefined && state.capturedMinor >= state.totalMinor;

/**
 * Classify one row.
 *
 * A row with no Medusa order yet is `unpaid` by definition and the most urgent case
 * there is - the sale exists on Allegro and nothing represents it here, which is
 * precisely what a lost event looks like.
 *
 * A CANCELLED order is terminal even when unpaid, and that ordering matters: an
 * order the buyer abandoned is never going to be paid, and treating it as urgent
 * would pin the fast sweep to a set that only ever grows.
 */
export const classifyReconcileTier = (
  row: ReconcileRow,
  payment: OrderPaymentState | undefined,
): ReconcileTier | undefined => {
  const status = row.derived_status ?? undefined;
  if (status && TERMINAL_DERIVED_STATUSES.has(status)) {
    return undefined;
  }
  if (!row.medusa_order_id) {
    return "unpaid";
  }
  return isFullyPaid(payment) ? "open" : "unpaid";
};

/**
 * The rows to sweep this run, oldest bookkeeping row first.
 *
 * Bounded, because the sweep costs one Allegro read per row and an unbounded one
 * would turn a backlog into a rate-limit incident. The bound is a batch, not a
 * filter: what does not fit is picked up by the next tick, which is seconds away
 * for the unpaid tier.
 */
export const selectReconcileBatch = <T extends ReconcileRow>(
  rows: readonly T[],
  tiers: ReadonlySet<ReconcileTier>,
  paymentFor: (row: T) => OrderPaymentState | undefined,
  limit: number,
): T[] => {
  const selected: T[] = [];
  for (const row of rows) {
    const tier = classifyReconcileTier(row, paymentFor(row));
    if (tier && tiers.has(tier)) {
      selected.push(row);
      if (selected.length >= limit) {
        break;
      }
    }
  }
  return selected;
};

/**
 * How often each tier is swept.
 *
 * ## Where these numbers come from
 *
 * Allegro's global limit is **9000 requests per minute per client_id**, documented at
 * developer.allegro.pl/tutorials/basic-information-VL6YelvVKTn#limits. Exceeding it
 * blocks the client id for that minute and answers 429; the block clears by itself.
 *
 * Two things about that limit are worth writing down, because both were checked
 * against the OpenAPI spec rather than assumed:
 *
 * - The order endpoints - `GET /order/events`, `GET /order/event-stats`,
 *   `GET /order/checkout-forms`, `GET /order/checkout-forms/{id}` - carry **no**
 *   per-resource limit of their own. That is a real negative, not a gap: Allegro
 *   states per-resource limits inline in the endpoint description where they exist
 *   (`/order/customer-returns` says 25/s per user, 50/s per clientId), and these four
 *   say nothing. Only the 9000/min global limit applies.
 * - Allegro documents **no** rate-limit response headers. There is no
 *   `X-RateLimit-Remaining` to budget against, so a client cannot see how much of the
 *   minute it has spent. Staying far below the ceiling is the only available strategy,
 *   which is why the batch cap exists at all.
 *
 * The real budget is therefore set by the batch, not by the limit: one
 * `GET /order/checkout-forms/{id}` per open order per sweep. At this store's scale
 * (tens of orders total, a handful open at once) a sweep on every 20s drain tick is
 * single-digit requests a minute against a 9000/min ceiling - less than the drain's
 * own journal polling. The cap exists for the day that is not true, not for today.
 *
 * `unpaid` defaults to 0, meaning "every drain tick, no extra throttle". That is the
 * point: an unpaid order is one the buyer may be paying right now.
 */
export interface ReconcileCadence {
  /** Minimum gap between unpaid sweeps, ms. 0 = every drain tick. */
  unpaidIntervalMs: number;
  /** Minimum gap between open-order sweeps, ms. */
  openIntervalMs: number;
  /** Maximum rows re-read per sweep. */
  batchLimit: number;
  /**
   * How long a shipped Medusa fulfillment is left to the subscriber before the sweep
   * takes it over. See `shouldPushSent`.
   */
  sentGraceMs: number;
}

export const DEFAULT_RECONCILE_CADENCE: ReconcileCadence = {
  batchLimit: 50,
  openIntervalMs: 900_000,
  // Comfortably inside the open tier's own 15-minute gap, so the FIRST sweep that
  // sees a shipment the subscriber lost is already past the grace window rather than
  // deferring the repair by another whole interval.
  sentGraceMs: 600_000,
  unpaidIntervalMs: 0,
};

/** Read a non-negative integer env var, falling back rather than scheduling nonsense. */
const readInterval = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Resolve the cadence from the environment.
 *
 * Env vars rather than plugin options for the same reason the schedules are: these
 * are operational dials an incident responder reaches for, and they sit beside the
 * existing `ALLEGRO_*_CRON` / `ALLEGRO_ORDERS_SYNC_INTERVAL_MS` in the compose file.
 * Unlike the schedules they are read at RUN time, so a change takes effect on the
 * next tick rather than at the next boot.
 */
export const resolveReconcileCadence = (
  env: NodeJS.ProcessEnv = process.env,
): ReconcileCadence => ({
  batchLimit: Math.max(
    1,
    readInterval(env.ALLEGRO_ORDERS_RECONCILE_BATCH, DEFAULT_RECONCILE_CADENCE.batchLimit),
  ),
  openIntervalMs: readInterval(
    env.ALLEGRO_ORDERS_RECONCILE_OPEN_INTERVAL_MS,
    DEFAULT_RECONCILE_CADENCE.openIntervalMs,
  ),
  sentGraceMs: readInterval(
    env.ALLEGRO_ORDERS_RECONCILE_SENT_GRACE_MS,
    DEFAULT_RECONCILE_CADENCE.sentGraceMs,
  ),
  unpaidIntervalMs: readInterval(
    env.ALLEGRO_ORDERS_RECONCILE_UNPAID_INTERVAL_MS,
    DEFAULT_RECONCILE_CADENCE.unpaidIntervalMs,
  ),
});

/** When each tier was last swept, as carried on the sync state row. */
export interface ReconcileMarks {
  unpaidAt?: number;
  openAt?: number;
}

/** Read the marks back off the persisted `counts` blob, tolerating anything. */
export const readReconcileMarks = (counts: unknown): ReconcileMarks => {
  const blob = (counts as { reconcile?: unknown } | null | undefined)?.reconcile;
  if (!blob || typeof blob !== "object") {
    return {};
  }
  const { openAt, unpaidAt } = blob as { openAt?: unknown; unpaidAt?: unknown };
  return {
    ...(typeof openAt === "number" ? { openAt } : {}),
    ...(typeof unpaidAt === "number" ? { unpaidAt } : {}),
  };
};

/**
 * Which tiers are due at `now`.
 *
 * A missing mark means "never swept", and that is due unconditionally rather than
 * "due once the interval has elapsed since the epoch". The distinction is not
 * academic: the marks are persisted per provider row, so the first run after this
 * ships - and after any operator clears the row - has no mark at all, and that is
 * exactly the run that should look at everything.
 */
export const dueReconcileTiers = (
  now: number,
  marks: ReconcileMarks,
  cadence: ReconcileCadence,
): Set<ReconcileTier> => {
  const due = new Set<ReconcileTier>();
  if (marks.unpaidAt === undefined || now - marks.unpaidAt >= cadence.unpaidIntervalMs) {
    due.add("unpaid");
  }
  if (marks.openAt === undefined || now - marks.openAt >= cadence.openIntervalMs) {
    due.add("open");
  }
  return due;
};

/** Carry forward the marks a run did not refresh, so one tier's sweep does not reset the other. */
export const advanceReconcileMarks = (
  now: number,
  marks: ReconcileMarks,
  swept: ReadonlySet<ReconcileTier>,
): ReconcileMarks => ({
  ...marks,
  ...(swept.has("open") ? { openAt: now } : {}),
  ...(swept.has("unpaid") ? { unpaidAt: now } : {}),
});

/**
 * What Allegro says about the money on a checkout form.
 *
 * `finishedAt` is the only proof that money moved. `READY_FOR_PROCESSING` alone is
 * not: Allegro sets it for cash-on-delivery and in-person pickup too, where the
 * buyer has paid nobody yet.
 */
export interface AllegroPaymentFacts {
  type?: "ONLINE" | "CASH_ON_DELIVERY";
  amount?: number;
  currency?: string;
  finishedAt?: string;
}

export const readPaymentFacts = (form: AllegroCheckoutForm): AllegroPaymentFacts => ({
  ...(form.payment?.type ? { type: form.payment.type } : {}),
  ...(form.payment?.paidAmount?.currency
    ? { currency: form.payment.paidAmount.currency.trim().toLowerCase() }
    : {}),
  ...(form.payment?.finishedAt ? { finishedAt: form.payment.finishedAt } : {}),
  ...(() => {
    const amount = parseAmount(form.payment?.paidAmount?.amount);
    return amount === undefined ? {} : { amount };
  })(),
});

/** What the sweep decided to do about an order's payment. */
export type PaymentPlan =
  | { kind: "skip"; reason: string }
  | {
      kind: "register";
      /** Major units, as the payment module wants them. */
      amount: number;
      currencyCode: string;
      capturedAt: Date;
      /** Set when Allegro's figure and the order total disagree; carried into the warn. */
      shortfall?: string;
    };

const toMinor = (amount: number): number => Math.round(amount * 100);

/**
 * Decide whether to register the buyer's payment on the Medusa order.
 *
 * Four refusals, each protecting something specific:
 *
 * - **No `finishedAt`.** Nothing proves money moved. Registering a capture here
 *   would invent a payment, which is strictly worse than a missing one: an invoice
 *   would be issued for money nobody received.
 * - **Cash on delivery.** The buyer pays the courier, on delivery, later. Allegro
 *   still reports the form as `READY_FOR_PROCESSING`, so the status alone cannot be
 *   trusted - this is the case that makes `type` load-bearing rather than
 *   decorative.
 * - **Already covered.** Idempotency, and the reason a re-run is a no-op.
 * - **A collection already exists but does not cover the total.** A partially paid
 *   order is a human's decision - a partial refund, a price correction, a failed
 *   capture. Adding a second collection on top would make the money unreadable, and
 *   this loop's job is to notice, not to adjudicate.
 *
 * When Allegro's paid amount and the Medusa total disagree, the AMOUNT REGISTERED IS
 * ALLEGRO'S. That is the money that actually moved, and recording the larger Medusa
 * total instead would show a fully-paid order that is not - the same fabrication the
 * first refusal exists to prevent. The order stays visibly short, which is what a
 * total conflict should look like.
 */
export const planOrderPayment = (
  facts: AllegroPaymentFacts,
  state: OrderPaymentState | undefined,
  orderCurrency: string,
): PaymentPlan => {
  if (!facts.finishedAt) {
    return { kind: "skip", reason: "Allegro reports no finished payment on this order" };
  }
  if (facts.type === "CASH_ON_DELIVERY") {
    return {
      kind: "skip",
      reason: "the buyer pays on delivery, so no money has been received yet",
    };
  }
  if (!state) {
    return { kind: "skip", reason: "the Medusa order's payment state could not be read" };
  }
  if (isFullyPaid(state)) {
    return { kind: "skip", reason: "already paid in full" };
  }
  if (state.collections > 0) {
    return {
      kind: "skip",
      reason: `the order already carries ${state.collections} payment collection(s) covering ${
        state.capturedMinor / 100
      } of ${state.totalMinor / 100}; a human decides what to do about the difference`,
    };
  }
  if (facts.currency && facts.currency !== orderCurrency) {
    return {
      kind: "skip",
      reason: `Allegro reports the payment in ${facts.currency.toUpperCase()} but the order is in ${orderCurrency.toUpperCase()}, so the two are not comparable`,
    };
  }

  // Allegro's own figure when it sent one, the order total otherwise. A form can reach
  // `finishedAt` without `paidAmount` populated, and refusing the whole registration over a
  // missing echo of an amount we already know would leave a paid order unpaid.
  const amount = facts.amount ?? state.totalMinor / 100;
  const shortfall =
    toMinor(amount) === state.totalMinor
      ? undefined
      : `Allegro reports ${amount} paid against a Medusa total of ${
          state.totalMinor / 100
        }; the Allegro figure is what the buyer paid, so the order stays visibly short`;

  return {
    amount,
    capturedAt: new Date(facts.finishedAt),
    currencyCode: orderCurrency,
    kind: "register",
    ...(shortfall ? { shortfall } : {}),
  };
};

/**
 * What Medusa knows about the shipment behind one Allegro order.
 *
 * The fact the fulfillment write-back was missing. `shipment.created` is a
 * point-in-time event, but "this order has a fulfillment that has shipped" is
 * ordinary reconcilable state sitting on `fulfillment.shipped_at` - which is what
 * makes a sweep possible at all, and why the write-back no longer has to be
 * event-only.
 */
export interface ShipmentState {
  /** The newest `shipped_at` across the order's live (non-cancelled) fulfillments. */
  shippedAt?: Date;
}

/** Whether this sweep should push `SENT`, and why not when it should not. */
export type SentPushDecision = { push: true } | { push: false; reason: string };

/**
 * Decide whether the reconciliation sweep should tell Allegro an order has shipped.
 *
 * The condition is the one the audit named: a Medusa fulfillment has shipped, and
 * `allegro_order.derived_status` is not `sent`. The `derived` argument is the status
 * mapped from the checkout form THIS SWEEP JUST READ, not the column as it stood
 * before - the sweep re-applies the form first, so the column and this value agree,
 * and using the fresh reading means an order Allegro already moved to `SENT` between
 * ticks is recognised without a second database read.
 *
 * Four refusals, each protecting something:
 *
 * - **Nothing shipped.** The only positive evidence there is. A fulfillment that was
 *   created but never shipped is `READY_FOR_SHIPMENT` on Allegro, which is where the
 *   order already is.
 * - **Allegro already says `sent`.** This is the idempotency gate, and it is what
 *   makes a re-run of the sweep cost zero marketplace writes rather than one per
 *   tick per shipped order.
 * - **The ladder has moved past shipping, or off it.** `delivered`, `returned` and
 *   `cancelled` are terminal; pushing `SENT` onto one would either be rejected or
 *   walk a finished order backwards. An unmappable status (`undefined`) is refused
 *   for the same reason the status mapper returns it rather than guessing: Allegro
 *   adds fulfillment statuses over time, and a write built on a state this plugin
 *   does not model is a write it cannot reason about.
 * - **The shipment is younger than the grace window.** The subscriber gets first
 *   refusal on every shipment, and it is still the fast path. Without this the sweep
 *   would race it: Allegro's checkout-form read model lags its own writes by tens of
 *   seconds, so a form re-read moments after a successful subscriber push still
 *   reports `READY_FOR_SHIPMENT`, and the sweep would "repair" an order that was
 *   never broken. The window is what makes the sweep a retry path rather than a
 *   second writer.
 */
export const decideSentPush = (input: {
  derived: DerivedOrderStatus | undefined;
  shipment: ShipmentState | undefined;
  now: number;
  graceMs: number;
}): SentPushDecision => {
  const shippedAt = input.shipment?.shippedAt;
  if (!shippedAt) {
    return { push: false, reason: "no Medusa fulfillment for this order has shipped" };
  }
  if (input.derived === "sent") {
    return { push: false, reason: "Allegro already reports this order as sent" };
  }
  if (!input.derived) {
    return {
      push: false,
      reason:
        "Allegro reports a fulfillment status this plugin does not model, so SENT is not a safe write",
    };
  }
  if (TERMINAL_DERIVED_STATUSES.has(input.derived)) {
    return {
      push: false,
      reason: `the order has reached ${input.derived}, which is the end of the ladder`,
    };
  }
  const age = input.now - shippedAt.getTime();
  if (age < input.graceMs) {
    return {
      push: false,
      reason: `the shipment is ${Math.round(age / 1000)}s old and the write-back subscriber owns the first ${Math.round(
        input.graceMs / 1000,
      )}s`,
    };
  }
  return { push: true };
};
