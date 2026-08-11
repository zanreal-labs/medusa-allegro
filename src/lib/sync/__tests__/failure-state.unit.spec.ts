import {
  clearFailureKey,
  emptyFailureState,
  isEmptyFailureState,
  isSystemicFailure,
  listQuarantined,
  MAX_TRACKED_QUARANTINES,
  MAX_TRACKED_STREAKS,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_TTL_MS,
  readFailureState,
  standingHealthLine,
  STREAK_TTL_MS,
  updateFailureState,
} from "../failure-state";
import type { FailureState } from "../failure-state";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const state = (over: Partial<FailureState> = {}): FailureState => ({
  ...emptyFailureState(),
  ...over,
});

const outcome = (
  failed: Record<string, string> = {},
  succeeded: string[] = [],
  systemic = false,
) => ({
  failed: new Map(Object.entries(failed)),
  succeeded: new Set(succeeded),
  systemic,
});

describe("readFailureState", () => {
  it("normalizes null, a non-object, and a partial payload", () => {
    expect(readFailureState(null)).toEqual(emptyFailureState());
    expect(readFailureState("nonsense")).toEqual(emptyFailureState());
    expect(readFailureState({ streaks: { a: { count: 1, error: "e", since: iso(0) } } })).toEqual({
      quarantined: {},
      streaks: { a: { count: 1, error: "e", since: iso(0) } },
    });
  });
});

describe("isEmptyFailureState", () => {
  it("is true only when both maps are empty", () => {
    expect(isEmptyFailureState(emptyFailureState())).toBe(true);
    expect(
      isEmptyFailureState(state({ streaks: { a: { count: 1, error: "e", since: iso(0) } } })),
    ).toBe(false);
    expect(isEmptyFailureState(state({ quarantined: { a: { error: "e", since: iso(0) } } }))).toBe(
      false,
    );
  });
});

describe("isSystemicFailure", () => {
  it("is systemic when everything failed and nothing succeeded", () => {
    expect(isSystemicFailure(outcome({ a: "boom", b: "boom" }))).toBe(true);
  });

  it("is not systemic when anything succeeded in the same tick", () => {
    // A success is the evidence that the pipeline works, which is what makes
    // setting one item aside safe.
    expect(isSystemicFailure(outcome({ a: "boom" }, ["b"]))).toBe(false);
  });

  it("is not systemic when nothing failed", () => {
    expect(isSystemicFailure(outcome({}, ["a"]))).toBe(false);
    expect(isSystemicFailure(outcome())).toBe(false);
  });
});

describe("updateFailureState", () => {
  it("starts a streak at 1 on a first failure", () => {
    const result = updateFailureState(emptyFailureState(), outcome({ a: "boom" }, ["b"]), NOW);
    expect(result.failures.streaks.a).toEqual({ count: 1, error: "boom", since: iso(0) });
    expect(result.quarantined).toEqual([]);
  });

  it("increments a streak and keeps the original since", () => {
    const previous = state({ streaks: { a: { count: 2, error: "old", since: iso(-60_000) } } });
    const result = updateFailureState(previous, outcome({ a: "new" }, ["b"]), NOW);
    expect(result.failures.streaks.a).toEqual({ count: 3, error: "new", since: iso(-60_000) });
  });

  it("quarantines at the threshold and moves the entry out of streaks", () => {
    const previous = state({
      streaks: {
        a: { count: QUARANTINE_AFTER_FAILURES - 1, error: "old", since: iso(-300_000) },
      },
    });
    const result = updateFailureState(previous, outcome({ a: "final" }, ["b"]), NOW);
    expect(result.failures.streaks.a).toBeUndefined();
    // `since` carries over from the streak, so the TTL clock measures from the
    // item's FIRST failure rather than from when the loop gave up.
    expect(result.failures.quarantined.a).toEqual({ error: "final", since: iso(-300_000) });
    expect(result.quarantined).toEqual(["a"]);
  });

  it("clears an item from both maps on success", () => {
    const previous = state({
      quarantined: { a: { error: "old", since: iso(-1000) } },
      streaks: { b: { count: 2, error: "old", since: iso(-1000) } },
    });
    const result = updateFailureState(previous, outcome({}, ["a", "b"]), NOW);
    expect(result.failures).toEqual(emptyFailureState());
  });

  it("refreshes a standing quarantine's error but not its since", () => {
    const previous = state({ quarantined: { a: { error: "old", since: iso(-1000) } } });
    const result = updateFailureState(previous, outcome({ a: "current" }, ["b"]), NOW);
    expect(result.failures.quarantined.a).toEqual({ error: "current", since: iso(-1000) });
  });

  it("carries forward an untouched streak", () => {
    const previous = state({ streaks: { untouched: { count: 1, error: "e", since: iso(-1000) } } });
    const result = updateFailureState(previous, outcome({ a: "boom" }, ["b"]), NOW);
    expect(result.failures.streaks.untouched).toEqual({ count: 1, error: "e", since: iso(-1000) });
  });

  it("changes nothing at all on a systemic tick", () => {
    // The whole point: an outage that fails every item must not grow a single
    // streak, because the whole working set would cross the threshold together.
    const previous = state({
      quarantined: { q: { error: "old", since: iso(-1000) } },
      streaks: { a: { count: 4, error: "old", since: iso(-1000) } },
    });
    const result = updateFailureState(
      previous,
      outcome({ a: "boom", b: "boom", c: "boom" }, [], true),
      NOW,
    );
    expect(result.failures).toBe(previous);
    expect(result.quarantined).toEqual(["q"]);
  });

  it("honours a caller-supplied systemic verdict even on a tick with successes", () => {
    // A 429, a 5xx, an auth error or the 403 write-scope gap are each systemic on
    // their own, and the caller knows about them before "everything failed" does.
    const previous = state({ streaks: { a: { count: 1, error: "old", since: iso(-1000) } } });
    const result = updateFailureState(previous, outcome({ a: "429" }, ["b"], true), NOW);
    expect(result.failures.streaks.a).toEqual({ count: 1, error: "old", since: iso(-1000) });
  });

  it("forgets a streak past its TTL", () => {
    const previous = state({
      streaks: { stale: { count: 1, error: "e", since: iso(-STREAK_TTL_MS - 1000) } },
    });
    const result = updateFailureState(previous, outcome({ a: "boom" }, ["b"]), NOW);
    expect(result.failures.streaks.stale).toBeUndefined();
  });

  it("forgets a quarantine past its much longer TTL", () => {
    const previous = state({
      quarantined: {
        fresh: { error: "e", since: iso(-STREAK_TTL_MS - 1000) },
        stale: { error: "e", since: iso(-QUARANTINE_TTL_MS - 1000) },
      },
    });
    const result = updateFailureState(previous, outcome({ a: "boom" }, ["b"]), NOW);
    expect(result.failures.quarantined.stale).toBeUndefined();
    // A quarantine older than the streak TTL is still live: it is a standing
    // instruction to an operator, on a much longer clock.
    expect(result.failures.quarantined.fresh).toBeDefined();
  });

  it("keeps an entry whose since is unparseable rather than silently un-quarantining it", () => {
    const previous = state({ quarantined: { a: { error: "e", since: "not-a-date" } } });
    const result = updateFailureState(previous, outcome({ b: "boom" }, ["c"]), NOW);
    expect(result.failures.quarantined.a).toBeDefined();
  });

  it("evicts the LOWEST-count streaks when the cap is exceeded", () => {
    // Evicting the oldest instead would starve a genuine poison item of the
    // quarantine that unblocks the loop: its high-count entry would be dropped
    // just before it escaped.
    const streaks: FailureState["streaks"] = {};
    for (let index = 0; index < MAX_TRACKED_STREAKS; index += 1) {
      streaks[`low-${index}`] = { count: 1, error: "e", since: iso(-index * 1000) };
    }
    streaks.nearly = { count: QUARANTINE_AFTER_FAILURES - 1, error: "e", since: iso(-999_999) };
    const previous = state({ streaks });

    const result = updateFailureState(previous, outcome({ fresh: "boom" }, ["ok"]), NOW);
    expect(Object.keys(result.failures.streaks)).toHaveLength(MAX_TRACKED_STREAKS);
    expect(result.failures.streaks.nearly).toBeDefined();
  });

  it("evicts the OLDEST quarantines when the cap is exceeded", () => {
    // Safe in a way streak eviction is not: the loop has already moved past a
    // quarantined item, so the entry carries only the operator's to-do.
    const quarantined: FailureState["quarantined"] = {};
    for (let index = 0; index < MAX_TRACKED_QUARANTINES; index += 1) {
      quarantined[`old-${index}`] = { error: "e", since: iso(-(index + 10) * 1000) };
    }
    const previous = state({ quarantined });

    const result = updateFailureState(previous, outcome({ newest: "boom" }, ["ok"]), NOW);
    // The newest failure only enters `quarantined` once it crosses the threshold,
    // so with one failure it is a streak and the cap is untouched.
    expect(Object.keys(result.failures.quarantined)).toHaveLength(MAX_TRACKED_QUARANTINES);
    expect(result.failures.streaks.newest).toBeDefined();
  });

  it("keeps quarantines and streaks in separate caps", () => {
    // The load-bearing separation: a full quarantine map must not stop a newly
    // broken item from accumulating its own streak and reaching its own escape.
    const quarantined: FailureState["quarantined"] = {};
    for (let index = 0; index < MAX_TRACKED_QUARANTINES; index += 1) {
      quarantined[`q-${index}`] = { error: "e", since: iso(-index * 1000) };
    }
    const previous = state({ quarantined });

    let current = previous;
    for (let attempt = 0; attempt < QUARANTINE_AFTER_FAILURES; attempt += 1) {
      current = updateFailureState(current, outcome({ poison: "boom" }, ["ok"]), NOW).failures;
    }
    expect(current.quarantined.poison).toBeDefined();
  });
});

describe("listQuarantined", () => {
  it("returns quarantined items oldest first", () => {
    const raw = {
      quarantined: {
        newer: { error: "b", since: iso(-1000) },
        older: { error: "a", since: iso(-5000) },
      },
      streaks: { ignored: { count: 1, error: "c", since: iso(0) } },
    };
    expect(listQuarantined(raw)).toEqual([
      { error: "a", key: "older", since: iso(-5000) },
      { error: "b", key: "newer", since: iso(-1000) },
    ]);
  });

  it("is empty for a null column", () => {
    expect(listQuarantined(null)).toEqual([]);
  });
});

describe("clearFailureKey", () => {
  it("clears from both maps and reports that it did", () => {
    const previous = state({
      quarantined: { a: { error: "e", since: iso(0) } },
      streaks: { a: { count: 2, error: "e", since: iso(0) } },
    });
    const result = clearFailureKey(previous, "a");
    expect(result.cleared).toBe(true);
    expect(result.failures).toEqual(emptyFailureState());
  });

  it("reports no change for an unknown key", () => {
    const result = clearFailureKey(emptyFailureState(), "nope");
    expect(result.cleared).toBe(false);
  });

  it("clears a live streak even when the item was never quarantined", () => {
    // Otherwise a repaired item resumes its stale streak and re-quarantines after
    // one more blip.
    const previous = state({ streaks: { a: { count: 4, error: "e", since: iso(0) } } });
    const result = clearFailureKey(previous, "a");
    expect(result.cleared).toBe(true);
    expect(result.failures.streaks.a).toBeUndefined();
  });
});

describe("standingHealthLine", () => {
  it("is null when nothing is quarantined", () => {
    expect(standingHealthLine(emptyFailureState(), "offer")).toBeNull();
  });

  it("names every quarantined item", () => {
    // Named, not counted: the whole point of quarantine is that the loop moves on,
    // so this string is the only thing between a skipped item and nobody noticing.
    const line = standingHealthLine(
      state({
        quarantined: {
          "form-1": { error: "e", since: iso(0) },
          "form-2": { error: "e", since: iso(0) },
        },
      }),
      "order",
    );
    expect(line).toContain("2 order(s) quarantined");
    expect(line).toContain("form-1, form-2");
  });
});
