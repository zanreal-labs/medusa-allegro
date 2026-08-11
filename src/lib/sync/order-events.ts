import type { AllegroOrderEvent } from "../allegro/types";
import {
  emptyFailureState,
  isSystemicFailure,
  QUARANTINE_AFTER_FAILURES,
  updateFailureState,
} from "./failure-state";
import type { FailureState } from "./failure-state";

/**
 * The Allegro order event journal drain, as pure orchestration.
 *
 * `GET /order/events` is the authoritative feed for everything an order can do:
 * `BOUGHT` on creation, `READY_FOR_PROCESSING` when payment finalizes,
 * `FULFILLMENT_STATUS_CHANGED` when the seller moves it, `BUYER_CANCELLED` /
 * `AUTO_CANCELLED` when it dies. Each tick reads from the stored cursor, collects
 * the distinct checkout forms named by status-relevant events, and force-refreshes
 * exactly those. An idle minute costs one journal request and writes nothing.
 *
 * Everything here is I/O-free: the caller injects `listEvents`, `latestEventId`
 * and `applyForm`. That is deliberate, because the parts worth getting right are
 * all decisions rather than requests.
 *
 * ## Why polling a checkout-form list is not enough
 *
 * Allegro does not reliably bump a checkout form's `updatedAt` when only
 * `PUT /order/checkout-forms/{id}/fulfillment` changed, so a fulfillment move
 * never re-enters an `updatedAt.gte` window. A window-bounded sweep therefore
 * cannot see the single most common status change there is. The journal can, which
 * is why it is the only scheduled input, and why
 * `importAllegroOrdersWindowWorkflow` exists as an explicit operator path rather
 * than a second schedule.
 *
 * ## Cursor discipline
 *
 * Events are consumed in order and the cursor advances only over the LEADING RUN
 * of events whose order landed. The first event belonging to a failed or deferred
 * order stops the advance, so it and everything after it replay next tick. Applying
 * an order twice is harmless - the upsert is idempotent - and no status change can
 * be lost to a transient failure.
 *
 * ## The three failure modes a single-input sync must answer for
 *
 * - **One bad order must not wedge the tick.** "The cursor never passes an order
 *   that did not land" is what makes a transient failure replay; applied without
 *   limit it turns one permanently unapplyable order into a hard stop for
 *   everything. So consecutive failures are counted per form, and after
 *   `QUARANTINE_AFTER_FAILURES` the cursor is allowed past it. Visible, never
 *   silent: the form is named in `last_error` and in the admin, and the per-form
 *   repair action is the remedy.
 * - **An outage must not be mistaken for a hundred bad orders.** See
 *   `isSystemicFailure` in `./failure-state`. A tick where every attempt failed and
 *   none succeeded quarantines nothing and holds the cursor.
 * - **A backlog must not starve new orders.** The per-run cap has to be spent
 *   oldest-first for the cursor to advance at all, but that would make a new order
 *   wait behind the entire backlog - and an unapplied `BOUGHT` event is an order
 *   nobody has been told about. So `PRIORITY_REFRESHES` of the budget is reserved
 *   for the newest candidates while the rest drains from the oldest end.
 *
 * What remains, and is accepted: an order the journal never names cannot be
 * imported by any schedule. The import-window workflow is the operator path for
 * that, and it is why `listCheckoutForms` stays in the SDK.
 */

/** Events per `GET /order/events` call (Allegro allows 1-1000). */
export const EVENT_PAGE_LIMIT = 100;
/** Journal pages per run; the rest is carried by the cursor to the next tick. */
export const MAX_EVENT_PAGES = 5;
/**
 * Orders refreshed per run. Each costs a `getCheckoutForm` plus an order upsert,
 * so this is what keeps a run bounded; the remainder replays from the cursor.
 */
export const MAX_EVENT_REFRESHES = 100;
/**
 * Slice of `MAX_EVENT_REFRESHES` reserved for the NEWEST candidates when the cap
 * is hit.
 *
 * Candidates are ordered oldest-event-first, because that is what lets the cursor
 * advance: it may only pass events whose order landed, so draining from the oldest
 * end is the only order in which the backlog shrinks. Spending the whole cap that
 * way would starve the newest orders for as long as a backlog lasts, and those are
 * the latency-critical ones.
 *
 * Reserving a slice for the newest end gets both: the oldest
 * `MAX_EVENT_REFRESHES - PRIORITY_REFRESHES` still drain the backlog forward one
 * tick at a time, while the newest `PRIORITY_REFRESHES` are applied immediately,
 * out of cursor order. Applying an order early is always safe - the refresh reads
 * its current state and the upsert is idempotent - it simply does not let the
 * cursor jump over the candidates still in between.
 *
 * Pure newest-first was rejected because it DEADLOCKS: deferring the oldest
 * candidates blocks the cursor at the very first event, so the cursor never moves,
 * the same page replays forever, and the backlog never drains.
 */
export const PRIORITY_REFRESHES = 20;

/**
 * Journal event types that can change an order's status, or introduce one.
 *
 * `FILLED_IN` is deliberately absent: it only reports the buyer (re)submitting the
 * delivery form, it can fire repeatedly for one order, and it changes no status.
 * The buyer's final address data arrives with `READY_FOR_PROCESSING`, which IS in
 * this set, so nothing is lost by ignoring it - and a buyer who edits their address
 * five times cannot burn the per-run refresh cap.
 */
export const STATUS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "AUTO_CANCELLED",
  "BOUGHT",
  "BUYER_CANCELLED",
  "FULFILLMENT_STATUS_CHANGED",
  "READY_FOR_PROCESSING",
]);

/** IO the drain needs, injected so the orchestration stays testable. */
export interface OrderEventDrainDeps {
  /** One journal page after `from` (exclusive); omit `from` to start at the oldest. */
  listEvents: (from: string | undefined, limit: number) => Promise<AllegroOrderEvent[]>;
  /** Newest event id, used only to bootstrap an empty cursor. */
  latestEventId: () => Promise<string | undefined>;
  /**
   * Force-apply one checkout form. Resolves to whether the order's derived status
   * moved; MUST throw when the order did not land, because that throw is the only
   * thing that holds the cursor.
   */
  applyForm: (formId: string) => Promise<boolean>;
  /** Optional structured logging hook. */
  log?: (level: "warn" | "error", message: string) => void;
  /**
   * Re-assert the caller's single-flight claim, returning false once it has been lost.
   *
   * Called before each form. A drain refreshes up to `MAX_EVENT_REFRESHES` forms
   * sequentially, each a `getCheckoutForm` plus a multi-step order write, which on a slow
   * Allegro comfortably exceeds the claim's staleness window - so without it the run is
   * taken over mid-drain and two passes interleave writes on the same order.
   *
   * A false answer stops the drain where it stands. The forms it never attempted are
   * treated exactly like deferred ones: they hold the cursor, so they replay next tick.
   */
  heartbeat?: () => Promise<boolean>;
  /**
   * Whether a thrown error is a PIPELINE condition rather than a bad order.
   *
   * Without this the drain could only infer systemic from "every attempt failed and none
   * succeeded", so a rate-limit storm or an outage that happened to land after one success
   * was read as a set of bad orders - and each one's quarantine streak grew toward being
   * skipped for good. The price loop already had the stronger signal (a 429, a 5xx, an auth
   * error or a transport failure is systemic on its own, even on a tick with successes);
   * this gives the drain the same one.
   */
  isSystemicError?: (error: unknown) => boolean;
}

export interface OrderEventDrainResult {
  /**
   * Cursor to persist. Never advances past an order that did not land, except one
   * that has failed `QUARANTINE_AFTER_FAILURES` times in a row.
   */
  cursor: string | null;
  eventsRead: number;
  refreshed: number;
  /** Refreshed orders whose derived status actually moved. */
  statusChanged: number;
  failed: number;
  /** Failure state to persist, with recovered forms removed. */
  failures: FailureState;
  /** Forms currently quarantined, standing ones included. */
  quarantined: string[];
  /** Every attempt failed and none succeeded, so it is read as an outage. */
  systemicFailure: boolean;
  /** A per-run cap was hit; the remainder replays from the cursor. */
  truncated: boolean;
  /** This run only established the starting cursor and consumed nothing. */
  bootstrapped: boolean;
}

/**
 * Read up to `MAX_EVENT_PAGES` journal pages from `cursor`. `truncated` is set only
 * when the last page was still full, i.e. the journal has more to give.
 */
const readEventPages = async (
  cursor: string,
  deps: OrderEventDrainDeps,
): Promise<{ events: AllegroOrderEvent[]; truncated: boolean }> => {
  const events: AllegroOrderEvent[] = [];
  let from = cursor;
  let truncated = false;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    // Cursor pagination: each page's `from` is the previous page's last event id,
    // so the awaits are necessarily sequential.
    const batch = await deps.listEvents(from, EVENT_PAGE_LIMIT);
    events.push(...batch);
    const last = batch.at(-1)?.id;
    if (batch.length < EVENT_PAGE_LIMIT || !last) {
      break;
    }
    from = last;
    if (page === MAX_EVENT_PAGES - 1) {
      truncated = true;
    }
  }
  return { events, truncated };
};

/**
 * Distinct, order-preserving list of the orders a batch of events qualifies for a
 * refresh: one entry per checkout form named by a status-relevant event, in the
 * order the journal first mentioned it.
 */
export const deriveRefreshCandidates = (events: readonly AllegroOrderEvent[]): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const formId = event.order?.checkoutForm?.id;
    if (!(formId && STATUS_EVENT_TYPES.has(event.type ?? ""))) {
      continue;
    }
    if (seen.has(formId)) {
      continue;
    }
    seen.add(formId);
    candidates.push(formId);
  }
  return candidates;
};

/** How one run splits its candidates when the refresh cap is hit. */
export interface RefreshSchedule {
  /** Forms to refresh, newest-priority first so latency-critical orders land. */
  scheduled: string[];
  /** Forms not attempted at all this run; they hold the cursor where they are. */
  deferred: Set<string>;
}

/**
 * Split candidates into what this run refreshes and what it leaves for the next
 * tick.
 *
 * Under the cap everything is scheduled and the order is irrelevant. Over it,
 * `PRIORITY_REFRESHES` of the budget goes to the newest candidates and the rest to
 * the oldest, leaving the middle band deferred. See `PRIORITY_REFRESHES` for why
 * both ends are needed and why pure newest-first deadlocks.
 */
export const scheduleRefreshes = (
  candidates: readonly string[],
  cap: number = MAX_EVENT_REFRESHES,
  priority: number = PRIORITY_REFRESHES,
): RefreshSchedule => {
  if (candidates.length <= cap) {
    return { deferred: new Set(), scheduled: [...candidates] };
  }
  const drainCount = cap - priority;
  const oldest = candidates.slice(0, drainCount);
  const newest = candidates.slice(candidates.length - priority);
  return {
    deferred: new Set(candidates.slice(drainCount, candidates.length - priority)),
    // Newest first: on a tick that cannot do everything, a new order must not wait
    // behind the backlog it happens to be queued behind.
    scheduled: [...newest, ...oldest],
  };
};

/**
 * Advance over the leading run of events whose order landed. The first event
 * belonging to a blocked order stops the advance, so it and everything after it
 * replay on the next tick.
 *
 * `blocked` is deliberately narrower than "everything that did not land": a form
 * past the quarantine threshold is excluded, so the cursor may pass it. Without
 * that escape one permanently broken order stops the only import path forever.
 */
export const advanceEventCursor = (
  events: readonly AllegroOrderEvent[],
  blocked: ReadonlySet<string>,
  cursor: string,
): string => {
  let nextCursor = cursor;
  for (const event of events) {
    const formId = event.order?.checkoutForm?.id;
    if (formId && blocked.has(formId)) {
      break;
    }
    nextCursor = event.id;
  }
  return nextCursor;
};

/**
 * The event-type histogram for a batch that produced no candidates.
 *
 * The drain used to fail silent-safe: if Allegro's live payload ever stopped
 * matching `AllegroOrderEvent` - a renamed type, a moved
 * `order.checkoutForm.id` - every event would be filtered out, zero orders would
 * refresh, and the cursor would still advance past them. Nothing distinguished
 * that from a genuinely quiet journal.
 *
 * The histogram makes the two cases tell themselves apart at a glance:
 * recognised-but-ignored types (`FILLED_IN`) mean the journal is working as
 * designed, while unrecognised types or a run of events with no checkout-form id
 * mean the shape has drifted. Exported because it is worth asserting on.
 */
export const describeUnusableEvents = (events: readonly AllegroOrderEvent[]): string => {
  const histogram = new Map<string, number>();
  let missingFormId = 0;
  for (const event of events) {
    const key = event.type ?? "(no type)";
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    if (!event.order?.checkoutForm?.id) {
      missingFormId += 1;
    }
  }
  const types = [...histogram]
    .map(([type, count]) => `${type} x${count}`)
    .toSorted((a, b) => a.localeCompare(b))
    .join(", ");
  return `event journal returned ${events.length} event(s) but derived 0 order(s) to refresh (types: ${types}; ${missingFormId} without a checkout-form id). If this repeats while orders are visibly changing, the event payload no longer matches AllegroOrderEvent.`;
};

/**
 * Refresh each scheduled form, recording which succeeded and which threw. The
 * failure message is kept per form because it is what the failure state stores and
 * what `last_error` shows for a quarantined order.
 */
const applyEventRefreshes = async (
  formIds: readonly string[],
  deps: OrderEventDrainDeps,
): Promise<{
  refreshed: number;
  statusChanged: number;
  failed: Map<string, string>;
  succeeded: Set<string>;
  /** Forms never attempted because the claim was lost part-way through. */
  abandoned: Set<string>;
  /** A failure was recognised as a pipeline condition, not a bad order. */
  systemicSignal: boolean;
}> => {
  const failed = new Map<string, string>();
  const succeeded = new Set<string>();
  const abandoned = new Set<string>();
  let refreshed = 0;
  let statusChanged = 0;
  let systemicSignal = false;
  for (const [index, formId] of formIds.entries()) {
    // The claim is re-asserted before each form, not once for the whole drain. If it has
    // been taken over, stopping HERE is what keeps this pass from interleaving order writes
    // with the pass that replaced it.
    if (deps.heartbeat && !(await deps.heartbeat())) {
      for (const remaining of formIds.slice(index)) {
        abandoned.add(remaining);
      }
      deps.log?.(
        "error",
        `sync claim lost after ${refreshed} refresh(es); abandoning ${abandoned.size} form(s) without attempting them. They hold the event cursor and replay on the next tick.`,
      );
      break;
    }
    // Sequential on purpose: it keeps Allegro and database load flat, and the cap
    // is what bounds the run.
    try {
      if (await deps.applyForm(formId)) {
        statusChanged += 1;
      }
      refreshed += 1;
      succeeded.add(formId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(formId, message);
      if (deps.isSystemicError?.(error)) {
        systemicSignal = true;
      }
      deps.log?.("error", `event-driven refresh failed for checkout form ${formId}: ${message}`);
    }
  }
  return { abandoned, failed, refreshed, statusChanged, succeeded, systemicSignal };
};

/**
 * Drain the journal and re-apply every order it reports as changed. This is the
 * whole orders sync.
 *
 * Bootstrap: with no cursor the newest event id is recorded and NOTHING is
 * consumed. Replaying the 60 days Allegro retains would be thousands of
 * `getCheckoutForm` calls, so a fresh database starts tracking from "now" forward
 * and importing history stays an operator action rather than something a
 * per-minute schedule keeps re-attempting forever.
 */
export const drainOrderEvents = async (
  cursor: string | null,
  deps: OrderEventDrainDeps,
  previousFailures: FailureState = emptyFailureState(),
): Promise<OrderEventDrainResult> => {
  if (!cursor) {
    const latest = await deps.latestEventId();
    return {
      bootstrapped: true,
      cursor: latest ?? null,
      eventsRead: 0,
      failed: 0,
      failures: previousFailures,
      quarantined: Object.keys(previousFailures.quarantined),
      refreshed: 0,
      statusChanged: 0,
      systemicFailure: false,
      truncated: false,
    };
  }

  const { events, truncated: pagesTruncated } = await readEventPages(cursor, deps);
  let truncated = pagesTruncated;

  const candidates = deriveRefreshCandidates(events);
  if (events.length > 0 && candidates.length === 0) {
    deps.log?.("warn", describeUnusableEvents(events));
  }

  const { deferred, scheduled } = scheduleRefreshes(candidates);
  if (deferred.size > 0) {
    truncated = true;
    deps.log?.(
      "warn",
      `event refresh cap (${MAX_EVENT_REFRESHES}) hit; ${deferred.size} order(s) replay next run`,
    );
  }

  const { abandoned, failed, refreshed, statusChanged, succeeded, systemicSignal } =
    await applyEventRefreshes(scheduled, deps);
  if (abandoned.size > 0) {
    // Same treatment as a deferred form: never attempted, so it must block the cursor and
    // replay rather than being counted as a failure against its own quarantine streak.
    truncated = true;
    for (const formId of abandoned) {
      deferred.add(formId);
    }
  }

  // Either the all-failed inference OR a recognised pipeline error. The second is what
  // stops a rate-limit storm that happened to land after one success from growing every
  // other order's quarantine streak.
  const systemic = systemicSignal || isSystemicFailure({ failed, succeeded });
  const { failures, quarantined } = updateFailureState(previousFailures, {
    failed,
    succeeded,
    systemic,
  });

  // A quarantined form is excluded from `blocked` on purpose: that is the escape
  // that lets the cursor move past an order this sync cannot apply. On a systemic
  // tick nothing is excluded - the pipeline is what is broken, so every failure
  // holds its place and replays once it recovers.
  const quarantinedSet = systemic ? new Set<string>() : new Set(quarantined);
  const blocked = new Set(
    [...failed.keys(), ...deferred].filter((formId) => !quarantinedSet.has(formId)),
  );

  if (systemic) {
    deps.log?.(
      "error",
      `ALLEGRO_UNREACHABLE: all ${failed.size} refresh attempt(s) failed this run and none succeeded; treating it as an outage, so no order is quarantined and the event cursor holds at ${cursor}. First error: ${[...failed.values()][0] ?? "unknown"}`,
    );
  }
  for (const formId of quarantinedSet) {
    // Only the forms this run gave up on; a standing quarantine is already on the
    // state row and does not need re-logging every minute.
    if (failed.has(formId) && !previousFailures.quarantined[formId]) {
      deps.log?.(
        "error",
        `checkout form ${formId} quarantined after ${QUARANTINE_AFTER_FAILURES} consecutive failures; the event cursor will advance past it. Repair it from the Allegro orders admin. Last error: ${failures.quarantined[formId]?.error ?? "unknown"}`,
      );
    }
  }

  return {
    bootstrapped: false,
    cursor: advanceEventCursor(events, blocked, cursor),
    eventsRead: events.length,
    failed: failed.size,
    failures,
    quarantined,
    refreshed,
    statusChanged,
    systemicFailure: systemic,
    truncated,
  };
};

/** The counters the admin reads for the orders provider. */
export interface OrdersSyncSummary {
  /** Set when the run did nothing (kill switch, not connected, claim held). */
  skipped?: string;
  disabled: boolean;
  connected: boolean;
  eventsRead: number;
  refreshed: number;
  /**
   * Refreshed orders whose derived status actually moved.
   *
   * Reported separately from `refreshed` because a forced refresh always writes,
   * so "rows written" says nothing about whether any status changed - which is the
   * only question anyone asks of this sync.
   */
  statusChanged: number;
  failed: number;
  quarantined: string[];
  systemicFailure: boolean;
  truncated: boolean;
  bootstrapped: boolean;
  error?: string;
}

export const emptyOrdersSyncSummary = (): OrdersSyncSummary => ({
  bootstrapped: false,
  connected: true,
  disabled: false,
  eventsRead: 0,
  failed: 0,
  quarantined: [],
  refreshed: 0,
  statusChanged: 0,
  systemicFailure: false,
  truncated: false,
});

/**
 * The one line of sync feedback an operator actually reads.
 *
 * Every counter that can distinguish "the journal was quiet", "the journal
 * returned events it could not parse" and "an order was skipped" is on screen,
 * including the zeroes: reporting only order counts made all three render as the
 * same reassuring "0 refreshed, 1 unchanged".
 */
export const summarizeOrdersSync = (summary: OrdersSyncSummary): string => {
  if (summary.skipped) {
    return `Skipped: ${summary.skipped}`;
  }
  const orders = [
    `${summary.refreshed} refreshed`,
    `${summary.statusChanged} changed`,
    ...(summary.failed > 0 ? [`${summary.failed} failed`] : []),
  ];
  const parts = [
    `Synced: ${orders.join(", ")}`,
    // Always shown: `events: 0` is what tells an operator the journal was simply
    // quiet, rather than leaving them to guess.
    `events: ${summary.eventsRead}`,
    ...(summary.bootstrapped ? ["cursor bootstrapped; earlier events are not replayed"] : []),
    // A quarantined order was skipped so the sync could keep going. That is the
    // right trade, but only while it stays visible, so it is spelled out rather
    // than folded into a count.
    ...(summary.quarantined.length > 0
      ? [`QUARANTINED (needs manual repair): ${summary.quarantined.join(", ")}`]
      : []),
    // The opposite diagnosis to a quarantine, and the operator's next move is
    // different: nothing was skipped, the sync is waiting on Allegro.
    ...(summary.systemicFailure ? ["ALLEGRO_UNREACHABLE: retrying, nothing skipped"] : []),
    ...(summary.truncated ? ["truncated: more replays next tick"] : []),
  ];
  return parts.join(" - ");
};
