import type { AllegroOrderEvent } from "../../allegro/types";
import { emptyFailureState, QUARANTINE_AFTER_FAILURES } from "../failure-state";
import type { FailureState } from "../failure-state";
import {
  advanceEventCursor,
  deriveRefreshCandidates,
  describeUnusableEvents,
  drainOrderEvents,
  emptyOrdersSyncSummary,
  EVENT_PAGE_LIMIT,
  MAX_EVENT_PAGES,
  MAX_EVENT_REFRESHES,
  PRIORITY_REFRESHES,
  scheduleRefreshes,
  STATUS_EVENT_TYPES,
  summarizeOrdersSync,
} from "../order-events";
import type { OrderEventDrainDeps } from "../order-events";

/**
 * A `since` inside both TTL windows, computed relative to now.
 *
 * A hard-coded timestamp would silently start failing these tests once wall-clock
 * time passed the 30-day quarantine TTL: `pruneEntries` would drop the fixture
 * and the assertion would read as a logic regression rather than a stale date.
 */
const RECENT = new Date(Date.now() - 60_000).toISOString();

const event = (
  id: string,
  formId?: string,
  type: AllegroOrderEvent["type"] = "BOUGHT",
): AllegroOrderEvent => ({
  id,
  ...(formId ? { order: { checkoutForm: { id: formId } } } : {}),
  type,
});

/** A deps object whose `applyForm` succeeds unless the form id is in `broken`. */
const deps = (
  pages: AllegroOrderEvent[][],
  options: { broken?: Set<string>; latest?: string } = {},
): OrderEventDrainDeps & { applied: string[]; logs: string[] } => {
  const applied: string[] = [];
  const logs: string[] = [];
  let call = 0;
  return {
    applied,
    applyForm: (formId) => {
      applied.push(formId);
      if (options.broken?.has(formId)) {
        return Promise.reject(new Error(`cannot apply ${formId}`));
      }
      return Promise.resolve(true);
    },
    latestEventId: () => Promise.resolve(options.latest),
    listEvents: () => {
      const page = pages[call] ?? [];
      call += 1;
      return Promise.resolve(page);
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    logs,
  };
};

describe("STATUS_EVENT_TYPES", () => {
  it("covers every event that can change a status", () => {
    expect([...STATUS_EVENT_TYPES].toSorted()).toEqual([
      "AUTO_CANCELLED",
      "BOUGHT",
      "BUYER_CANCELLED",
      "FULFILLMENT_STATUS_CHANGED",
      "READY_FOR_PROCESSING",
    ]);
  });

  it("excludes FILLED_IN", () => {
    // It changes no status, it can fire repeatedly for one order, and the buyer's
    // final address arrives with READY_FOR_PROCESSING anyway. Including it would
    // let a buyer who edits their address five times burn the refresh cap.
    expect(STATUS_EVENT_TYPES.has("FILLED_IN")).toBe(false);
  });
});

describe("deriveRefreshCandidates", () => {
  it("keeps one entry per form, in first-mention order", () => {
    const candidates = deriveRefreshCandidates([
      event("e1", "form-a"),
      event("e2", "form-b"),
      event("e3", "form-a", "FULFILLMENT_STATUS_CHANGED"),
    ]);
    expect(candidates).toEqual(["form-a", "form-b"]);
  });

  it("ignores events with no checkout-form id", () => {
    expect(deriveRefreshCandidates([event("e1"), event("e2", "form-a")])).toEqual(["form-a"]);
  });

  it("ignores event types that cannot change a status", () => {
    expect(
      deriveRefreshCandidates([event("e1", "form-a", "FILLED_IN"), event("e2", "form-b")]),
    ).toEqual(["form-b"]);
  });

  it("ignores an event with no type at all", () => {
    expect(deriveRefreshCandidates([{ id: "e1", order: { checkoutForm: { id: "f" } } }])).toEqual(
      [],
    );
  });
});

describe("scheduleRefreshes", () => {
  it("schedules everything under the cap and defers nothing", () => {
    const candidates = ["a", "b", "c"];
    const result = scheduleRefreshes(candidates, 10, 3);
    expect(result.scheduled).toEqual(candidates);
    expect(result.deferred.size).toBe(0);
  });

  it("splits the budget between the newest and the oldest, deferring the middle", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => `f${index}`);
    const result = scheduleRefreshes(candidates, 4, 2);
    // Newest first, so a new order does not wait behind the backlog it happens to
    // be queued behind.
    expect(result.scheduled).toEqual(["f8", "f9", "f0", "f1"]);
    expect([...result.deferred]).toEqual(["f2", "f3", "f4", "f5", "f6", "f7"]);
  });

  it("always schedules the oldest candidate, which is what lets the cursor move", () => {
    // Pure newest-first deadlocks: deferring the oldest blocks the cursor at the
    // very first event, so the same page replays forever and the backlog never
    // drains. The oldest candidate being scheduled is the invariant that prevents
    // it.
    const candidates = Array.from({ length: 500 }, (_, index) => `f${index}`);
    const result = scheduleRefreshes(candidates);
    expect(result.scheduled).toContain("f0");
    expect(result.deferred.has("f0")).toBe(false);
  });

  it("spends the whole budget when it splits", () => {
    const candidates = Array.from({ length: 500 }, (_, index) => `f${index}`);
    const result = scheduleRefreshes(candidates);
    expect(result.scheduled).toHaveLength(MAX_EVENT_REFRESHES);
    expect(result.deferred.size).toBe(500 - MAX_EVENT_REFRESHES);
  });

  it("reserves the newest slice for the newest candidates", () => {
    const candidates = Array.from({ length: 500 }, (_, index) => `f${index}`);
    const result = scheduleRefreshes(candidates);
    expect(result.scheduled.slice(0, PRIORITY_REFRESHES)).toEqual(
      candidates.slice(-PRIORITY_REFRESHES),
    );
  });
});

describe("advanceEventCursor", () => {
  it("advances over the whole batch when nothing is blocked", () => {
    const events = [event("e1", "a"), event("e2", "b")];
    expect(advanceEventCursor(events, new Set(), "e0")).toBe("e2");
  });

  it("stops at the first event belonging to a blocked form", () => {
    const events = [event("e1", "a"), event("e2", "blocked"), event("e3", "c")];
    expect(advanceEventCursor(events, new Set(["blocked"]), "e0")).toBe("e1");
  });

  it("does not advance at all when the very first event is blocked", () => {
    const events = [event("e1", "blocked"), event("e2", "b")];
    expect(advanceEventCursor(events, new Set(["blocked"]), "e0")).toBe("e0");
  });

  it("advances past an event with no form id", () => {
    // An event nothing can be done with must not hold the cursor forever.
    const events = [event("e1"), event("e2", "a")];
    expect(advanceEventCursor(events, new Set(["a"]), "e0")).toBe("e1");
  });

  it("holds the cursor unchanged on an empty batch", () => {
    expect(advanceEventCursor([], new Set(), "e0")).toBe("e0");
  });

  it("stops at the FIRST blocked form even when a later one also succeeded", () => {
    // The leading-run rule: everything after the block replays, including work
    // that already landed. That is safe because the upsert is idempotent, and it
    // is what makes the cursor's meaning simple.
    const events = [event("e1", "ok"), event("e2", "blocked"), event("e3", "ok")];
    expect(advanceEventCursor(events, new Set(["blocked"]), "e0")).toBe("e1");
  });
});

describe("describeUnusableEvents", () => {
  it("reports the type histogram and the missing-form-id count", () => {
    const message = describeUnusableEvents([
      event("e1", "a", "FILLED_IN"),
      event("e2", "b", "FILLED_IN"),
      event("e3", undefined, "BOUGHT"),
    ]);
    expect(message).toContain("returned 3 event(s) but derived 0 order(s)");
    expect(message).toContain("FILLED_IN x2");
    expect(message).toContain("BOUGHT x1");
    expect(message).toContain("1 without a checkout-form id");
  });

  it("labels an event with no type", () => {
    expect(describeUnusableEvents([{ id: "e1" }])).toContain("(no type) x1");
  });
});

describe("drainOrderEvents", () => {
  it("bootstraps from the newest event id and consumes nothing", async () => {
    // Replaying the 60 days Allegro retains would be thousands of calls, so a
    // fresh database starts tracking from "now" and importing history stays an
    // operator action.
    const dependencies = deps([[event("e1", "a")]], { latest: "e-newest" });
    const result = await drainOrderEvents(null, dependencies);
    expect(result).toMatchObject({
      bootstrapped: true,
      cursor: "e-newest",
      eventsRead: 0,
      refreshed: 0,
    });
    expect(dependencies.applied).toEqual([]);
  });

  it("bootstraps to null when the account has no events at all", async () => {
    const result = await drainOrderEvents(null, deps([]));
    expect(result).toMatchObject({ bootstrapped: true, cursor: null });
  });

  it("refreshes every named order and advances the cursor", async () => {
    const dependencies = deps([[event("e1", "form-a"), event("e2", "form-b")]]);
    const result = await drainOrderEvents("e0", dependencies);
    expect(dependencies.applied).toEqual(["form-a", "form-b"]);
    expect(result).toMatchObject({
      cursor: "e2",
      eventsRead: 2,
      failed: 0,
      refreshed: 2,
      statusChanged: 2,
      systemicFailure: false,
      truncated: false,
    });
  });

  it("counts a refresh that changed nothing separately from one that moved a status", async () => {
    const dependencies = deps([[event("e1", "form-a")]]);
    dependencies.applyForm = () => Promise.resolve(false);
    const result = await drainOrderEvents("e0", dependencies);
    expect(result).toMatchObject({ refreshed: 1, statusChanged: 0 });
  });

  it("stops paging when a page comes back short", async () => {
    const dependencies = deps([[event("e1", "a")], [event("e2", "b")]]);
    const result = await drainOrderEvents("e0", dependencies);
    expect(result.eventsRead).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("reports truncated when every page was full up to the page cap", async () => {
    const fullPage = (offset: number): AllegroOrderEvent[] =>
      Array.from({ length: EVENT_PAGE_LIMIT }, (_, index) =>
        event(`e${offset + index}`, `form-${offset + index}`),
      );
    const pages = Array.from({ length: MAX_EVENT_PAGES }, (_, page) =>
      fullPage(page * EVENT_PAGE_LIMIT),
    );
    const result = await drainOrderEvents("e0", deps(pages));
    expect(result.eventsRead).toBe(EVENT_PAGE_LIMIT * MAX_EVENT_PAGES);
    expect(result.truncated).toBe(true);
  });

  it("holds the cursor at a failed order and reports the failure", async () => {
    const dependencies = deps([[event("e1", "ok"), event("e2", "bad"), event("e3", "later")]], {
      broken: new Set(["bad"]),
    });
    const result = await drainOrderEvents("e0", dependencies);
    expect(result.cursor).toBe("e1");
    expect(result.failed).toBe(1);
    expect(result.failures.streaks.bad).toMatchObject({ count: 1 });
    expect(result.systemicFailure).toBe(false);
  });

  it("lets the cursor past a form that has now reached the quarantine threshold", async () => {
    const previous: FailureState = {
      quarantined: {},
      streaks: {
        bad: {
          count: QUARANTINE_AFTER_FAILURES - 1,
          error: "old",
          since: RECENT,
        },
      },
    };
    const dependencies = deps([[event("e1", "ok"), event("e2", "bad"), event("e3", "later")]], {
      broken: new Set(["bad"]),
    });
    const result = await drainOrderEvents("e0", dependencies, previous);
    expect(result.quarantined).toEqual(["bad"]);
    // The escape: without it one permanently broken order pins the cursor forever
    // and no order - including a brand-new one - ever imports again.
    expect(result.cursor).toBe("e3");
    expect(dependencies.logs.some((line) => line.includes("quarantined after"))).toBe(true);
  });

  it("holds the cursor and quarantines nothing on a systemic tick", async () => {
    const previous: FailureState = {
      quarantined: {},
      streaks: {
        a: { count: QUARANTINE_AFTER_FAILURES - 1, error: "o", since: RECENT },
        b: { count: QUARANTINE_AFTER_FAILURES - 1, error: "o", since: RECENT },
      },
    };
    const dependencies = deps([[event("e1", "a"), event("e2", "b")]], {
      broken: new Set(["a", "b"]),
    });
    const result = await drainOrderEvents("e0", dependencies, previous);
    // Both were one failure from quarantine. Treating an outage as evidence about
    // individual orders would have skipped both at once.
    expect(result.systemicFailure).toBe(true);
    expect(result.quarantined).toEqual([]);
    expect(result.cursor).toBe("e0");
    expect(result.failures).toBe(previous);
    expect(dependencies.logs.some((line) => line.includes("ALLEGRO_UNREACHABLE"))).toBe(true);
  });

  it("does not let a quarantine escape apply on a systemic tick", async () => {
    // Belt and braces on the case above: even a form already at the threshold must
    // not unblock the cursor while the pipeline itself is what is broken.
    const previous: FailureState = {
      quarantined: { a: { error: "standing", since: RECENT } },
      streaks: {},
    };
    const dependencies = deps([[event("e1", "a"), event("e2", "b")]], {
      broken: new Set(["a", "b"]),
    });
    const result = await drainOrderEvents("e0", dependencies, previous);
    expect(result.systemicFailure).toBe(true);
    expect(result.cursor).toBe("e0");
  });

  it("blocks the cursor at a deferred order and reports truncation", async () => {
    const events = Array.from({ length: MAX_EVENT_REFRESHES + 5 }, (_, index) =>
      event(`e${index}`, `form-${index}`),
    );
    const result = await drainOrderEvents("e0", deps([events]));
    expect(result.truncated).toBe(true);
    // The first deferred candidate is at index (cap - priority), so the cursor
    // stops just before it.
    const firstDeferredIndex = MAX_EVENT_REFRESHES - PRIORITY_REFRESHES;
    expect(result.cursor).toBe(`e${firstDeferredIndex - 1}`);
  });

  it("clears a form's streak once it succeeds again", async () => {
    const previous: FailureState = {
      quarantined: {},
      streaks: { a: { count: 3, error: "old", since: RECENT } },
    };
    const result = await drainOrderEvents("e0", deps([[event("e1", "a")]]), previous);
    expect(result.failures.streaks.a).toBeUndefined();
  });

  it("warns when a batch produced no candidates at all", async () => {
    const dependencies = deps([[event("e1", "a", "FILLED_IN")]]);
    const result = await drainOrderEvents("e0", dependencies);
    expect(result.cursor).toBe("e1");
    expect(dependencies.logs.some((line) => line.includes("derived 0 order(s)"))).toBe(true);
  });

  it("does not warn on a genuinely empty journal", async () => {
    const dependencies = deps([[]]);
    await drainOrderEvents("e0", dependencies);
    expect(dependencies.logs).toEqual([]);
  });

  it("carries a standing quarantine through a clean run", async () => {
    const previous: FailureState = {
      quarantined: { old: { error: "still broken", since: RECENT } },
      streaks: {},
    };
    const result = await drainOrderEvents("e0", deps([[event("e1", "a")]]), previous);
    expect(result.quarantined).toEqual(["old"]);
  });
});

describe("summarizeOrdersSync", () => {
  it("reports a skip verbatim", () => {
    expect(summarizeOrdersSync({ ...emptyOrdersSyncSummary(), skipped: "kill switch" })).toBe(
      "Skipped: kill switch",
    );
  });

  it("always shows the event count, including zero", () => {
    // `events: 0` is what tells an operator the journal was simply quiet, rather
    // than leaving them to guess between that and a parse failure.
    expect(summarizeOrdersSync(emptyOrdersSyncSummary())).toBe(
      "Synced: 0 refreshed, 0 changed - events: 0",
    );
  });

  it("names quarantined orders rather than counting them", () => {
    const line = summarizeOrdersSync({
      ...emptyOrdersSyncSummary(),
      quarantined: ["form-1"],
    });
    expect(line).toContain("QUARANTINED (needs manual repair): form-1");
  });

  it("distinguishes an outage from a per-order failure", () => {
    const line = summarizeOrdersSync({
      ...emptyOrdersSyncSummary(),
      failed: 3,
      systemicFailure: true,
    });
    expect(line).toContain("3 failed");
    expect(line).toContain("ALLEGRO_UNREACHABLE: retrying, nothing skipped");
  });

  it("says when the cursor was only bootstrapped", () => {
    expect(summarizeOrdersSync({ ...emptyOrdersSyncSummary(), bootstrapped: true })).toContain(
      "cursor bootstrapped",
    );
  });
});
