import {
  enqueueStockPush,
  resetStockPushQueue,
  StockPushQueue,
  summarizeSkus,
} from "../lib/stock-push-queue";
import { pushTargetedAllegroStock } from "../push-allegro-stock";

jest.mock("../push-allegro-stock", () => ({
  pushTargetedAllegroStock: jest.fn(),
}));

const targetedPush = pushTargetedAllegroStock as jest.MockedFunction<
  typeof pushTargetedAllegroStock
>;

/**
 * The queue's own behaviour, with the timer and the clock injected.
 *
 * The buffer decides WHEN a batch is due (`lib/sync/stock-dirty`, tested there). What
 * is left here is the part that cannot be pure: that a burst produces one push, that
 * a push never runs concurrently with itself, that SKUs arriving mid-push are not
 * lost, and that a failure is reported rather than thrown into a timer.
 */

/** A controllable clock plus a single-slot timer, the way the queue uses them. */
const harness = () => {
  let now = 0;
  let scheduled: { fn: () => void; at: number } | null = null;
  return {
    /** Run the pending timer, advancing the clock to its due time. */
    async fire(): Promise<void> {
      const due = scheduled;
      if (!due) {
        throw new Error("nothing scheduled");
      }
      scheduled = null;
      now = Math.max(now, due.at);
      due.fn();
      // Let the flush's promise chain settle before the assertions look at it.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    get pendingTimer() {
      return scheduled;
    },
    deps: {
      clearTimer: () => {
        scheduled = null;
      },
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        scheduled = { at: now + ms, fn };
        return scheduled;
      },
    },
    advance(ms: number) {
      now += ms;
    },
  };
};

describe("StockPushQueue", () => {
  it("turns a burst of events into ONE push carrying each SKU once", async () => {
    const clock = harness();
    const pushes: string[][] = [];
    const queue = new StockPushQueue({
      ...clock.deps,
      buffer: { debounceMs: 1000, maxWaitMs: 10_000 },
      push: async (skus) => {
        pushes.push(skus);
      },
    });

    // A two-line order: `order.placed` names both lines, then a reservation event per
    // line names one each. Four events, three of them redundant.
    queue.add(["SKU-1", "SKU-2"]);
    clock.advance(50);
    queue.add(["SKU-1"]);
    clock.advance(50);
    queue.add(["SKU-2"]);
    expect(pushes).toHaveLength(0);

    await clock.fire();
    expect(pushes).toEqual([["SKU-1", "SKU-2"]]);
  });

  it("never runs two pushes at once, and carries mid-push marks into the next batch", async () => {
    const clock = harness();
    const started: string[][] = [];
    let release: (() => void) | undefined;
    const queue = new StockPushQueue({
      ...clock.deps,
      buffer: { debounceMs: 1000, maxWaitMs: 10_000 },
      push: async (skus) => {
        started.push(skus);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    queue.add(["SKU-1"]);
    await clock.fire();
    expect(started).toEqual([["SKU-1"]]);

    // An order lands WHILE the first push is in flight. Arming a second push now would
    // find the STOCK claim held, log a skip, and drop SKU-2 on the floor.
    queue.add(["SKU-2"]);
    expect(started).toHaveLength(1);
    expect(clock.pendingTimer).toBeNull();

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Re-armed from the completion instead, so SKU-2 becomes the next batch.
    expect(clock.pendingTimer).not.toBeNull();
    await clock.fire();
    expect(started).toEqual([["SKU-1"], ["SKU-2"]]);
  });

  it("reports a failed push instead of throwing out of the timer", async () => {
    const clock = harness();
    const failures: { skus: string[]; message: string }[] = [];
    const queue = new StockPushQueue({
      ...clock.deps,
      buffer: { debounceMs: 1000 },
      onError: (error, skus) => {
        failures.push({ message: (error as Error).message, skus });
      },
      push: () => Promise.reject(new Error("Allegro said no")),
    });

    queue.add(["SKU-1"]);
    // An unhandled rejection from a background timer would take the worker down, and
    // with it the order drain - a failed stock push must never become an outage.
    await expect(clock.fire()).resolves.toBeUndefined();
    expect(failures).toEqual([{ message: "Allegro said no", skus: ["SKU-1"] }]);
  });

  it("does not re-queue a failed batch, leaving the retry to the reconciliation", async () => {
    const clock = harness();
    let calls = 0;
    const queue = new StockPushQueue({
      ...clock.deps,
      buffer: { debounceMs: 1000 },
      onError: () => undefined,
      push: () => {
        calls += 1;
        return Promise.reject(new Error("nope"));
      },
    });

    queue.add(["SKU-1"]);
    await clock.fire();
    // Retrying here would hammer a broken Allegro with the same batch on a tight loop.
    // The 15-minute sweep is the retry, and it is rate-aware.
    expect(calls).toBe(1);
    expect(clock.pendingTimer).toBeNull();
    expect(queue.pending).toBe(0);
  });

  it("reports the coalescing on each schedule, so a burst is visible in the log", async () => {
    const clock = harness();
    const scheduled: { added: number; pending: number }[] = [];
    const queue = new StockPushQueue({
      ...clock.deps,
      buffer: { debounceMs: 1000 },
      onSchedule: ({ added, pending }) => {
        scheduled.push({ added, pending });
      },
      push: async () => undefined,
    });

    queue.add(["SKU-1", "SKU-2"]);
    queue.add(["SKU-1"]);
    expect(scheduled).toEqual([
      { added: 2, pending: 2 },
      // "One more event, nothing new" is the coalescing working, and it is worth being
      // able to see that rather than inferring it from a missing push.
      { added: 0, pending: 2 },
    ]);
    await clock.fire();
  });

  it("falls back to a real clock and timer when none are injected", async () => {
    const pushes: string[][] = [];
    const queue = new StockPushQueue({
      buffer: { debounceMs: 1 },
      push: async (skus) => {
        pushes.push(skus);
      },
    });

    queue.add(["SKU-1"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pushes).toEqual([["SKU-1"]]);
  });

  it("survives an options object carrying explicit undefined overrides", async () => {
    const pushes: string[][] = [];
    const queue = new StockPushQueue({
      buffer: { debounceMs: 1 },
      // An explicitly PRESENT undefined, which is easy to produce from an options
      // object. Spreading the caller's deps over the resolved defaults would replace a
      // working clock with undefined, and the failure would surface as a TypeError from
      // inside a timer - in production only, since every test injects all three.
      clearTimer: undefined,
      now: undefined,
      push: async (skus) => {
        pushes.push(skus);
      },
      setTimer: undefined,
    });

    queue.add(["SKU-2"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pushes).toEqual([["SKU-2"]]);
  });

  it("does nothing at all when handed no SKUs", () => {
    const clock = harness();
    const queue = new StockPushQueue({
      ...clock.deps,
      push: async () => undefined,
    });
    queue.add([]);
    expect(clock.pendingTimer).toBeNull();
    expect(queue.pending).toBe(0);
  });
});

/** A container exposing only the logger the queue's callbacks resolve. */
const fakeContainer = (id: string) => {
  const logs: string[] = [];
  const record = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };
  return {
    id,
    logs,
    resolve: () => ({
      debug: record("debug"),
      error: record("error"),
      info: record("info"),
      warn: record("warn"),
    }),
  };
};

/** A push result carrying only the counters these assertions care about. */
const pushResult = (over: Record<string, unknown>) => ({
  alreadyInSync: 0,
  ambiguous: 0,
  commands: 0,
  complete: false,
  conflicted: 0,
  eligible: 0,
  failed: 0,
  mismatched: 0,
  pending: 0,
  skippedInactive: 0,
  skippedNoInventory: 0,
  skippedNoListingStock: 0,
  skippedUnlinked: 0,
  skippedUnmatched: 0,
  synced: 0,
  unresolved: 0,
  ...over,
})

describe("enqueueStockPush", () => {
  beforeEach(() => {
    resetStockPushQueue();
    targetedPush.mockReset();
    targetedPush.mockResolvedValue({ skipped: "test" } as never);
    // The real debounce, driven by fake timers rather than by waiting three seconds.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetStockPushQueue();
  });

  it("raises NO alert when the run only had findings", async () => {
    const container = fakeContainer("only-findings");
    targetedPush.mockResolvedValue(
      pushResult({
        finding: "1 eligible variant(s) are claimed by no mapped Allegro offer, so their quantity is published nowhere",
        skippedUnlinked: 1,
        synced: 1,
      }) as never,
    );

    enqueueStockPush(container as never, ["SKU-1", "SKU-2"]);
    await jest.advanceTimersByTimeAsync(5000);

    // The condition that paged the owner CRITICAL on the first live supplier change.
    // A variant with no Allegro auction is normal and permanent here - auctions are
    // created by hand - so alerting on it fires on every stock movement of every
    // unlisted product until nobody reads the alerts at all.
    //
    // Asserted against the log the alert path actually writes, NOT against a local
    // array nothing populates: the first version of this test collected into an
    // `errors` list that no code appended to, so it would have passed just as
    // happily with the alert still firing. A regression test that cannot fail is the
    // same defect it is meant to catch.
    const log = container.logs.join("\n");
    // The alert path's own line, matched precisely - the healthy info line carries
    // `failed=0`, so a looser match would collide with it and pass for the wrong
    // reason.
    expect(log).not.toContain("the immediate quantity push for");
    // And the finding is still REPORTED - narrowing the alert must not make a skip
    // invisible, because the log is now the only place it shows up.
    expect(log).toContain("claimed by no mapped Allegro offer");
  });

  it("still alerts when the run genuinely failed", async () => {
    const container = fakeContainer("real-failure");
    targetedPush.mockResolvedValue(
      pushResult({
        error: "2 offer quantity write(s) were not confirmed by Allegro",
        failed: 2,
      }) as never,
    );

    enqueueStockPush(container as never, ["SKU-1"]);
    await jest.advanceTimersByTimeAsync(5000);

    // A MAPPED offer that may now be advertising stock the store does not have. This
    // is the one worth waking somebody for, and narrowing the alert must not have
    // silenced it.
    expect(container.logs.join("\n")).toContain(
      "the immediate quantity push for 1 SKU(s) failed",
    );
  });

  it("pushes with the container of the LATEST event, not the one that built the queue", async () => {
    const first = fakeContainer("first");
    const second = fakeContainer("second");

    enqueueStockPush(first as never, ["SKU-1"]);
    // A second event, seconds later, with its own container. The queue outlives both -
    // that is the point of it - so a container captured in its closures would pin the
    // process to `first` forever and flush against one its event has finished with.
    enqueueStockPush(second as never, ["SKU-2"]);

    await jest.advanceTimersByTimeAsync(5000);

    expect(targetedPush).toHaveBeenCalledTimes(1);
    expect(targetedPush.mock.calls[0]?.[0]).toBe(second);
    // Both events' SKUs, coalesced into the one push.
    expect(targetedPush.mock.calls[0]?.[1]).toEqual(["SKU-1", "SKU-2"]);
  });
});

/**
 * Idempotency: a re-delivered event and a restarted worker.
 *
 * Both are ordinary in this stack rather than hypothetical. The event bus may deliver
 * `marken.stock.changed` more than once, the supplier poll runs every minute and can
 * name the same SKU on consecutive ticks, and every deploy restarts the worker that
 * holds the buffer. None of the three may produce a second WRITE.
 *
 * The property that makes that true is not a dedupe table, and deliberately so. The
 * event is a HINT about what to re-read, never a quantity: `pushTargetedAllegroStock`
 * reads Medusa's available quantity and Allegro's live offer for itself and plans from
 * the difference. So a redundant delivery costs a read and plans nothing - `mismatched`
 * is zero, `buildStockCommandChunks` produces no chunk, and no command is submitted.
 * The planner half of that is proven in `lib/sync/__tests__/stock-plan.unit.spec.ts`
 * ("a second push over an already-synced catalogue writes nothing"); what is proven
 * here is the queue half, and that the redundant push is not reported as a failure.
 */
describe("the stock push is idempotent under redelivery and restart", () => {
  beforeEach(() => {
    resetStockPushQueue();
    targetedPush.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetStockPushQueue();
  });

  it("collapses a redelivered event into the batch it duplicates", async () => {
    const container = fakeContainer("redelivered-in-window");
    targetedPush.mockResolvedValue({ skipped: "test" } as never);

    // The same announcement, delivered twice inside the debounce window - a retrying
    // event bus, or the supplier naming the same SKU on two consecutive minutes.
    enqueueStockPush(container as never, ["SKU-1", "SKU-2"]);
    enqueueStockPush(container as never, ["SKU-1", "SKU-2"]);

    await jest.advanceTimersByTimeAsync(5000);

    // One push, each SKU once. The buffer is a Set, so the duplicate adds nothing -
    // and it does not restart the debounce either, or a redelivery storm would starve
    // the very batch it duplicates (see `StockDirtyBuffer.mark`).
    expect(targetedPush).toHaveBeenCalledTimes(1);
    expect(targetedPush.mock.calls[0]?.[1]).toEqual(["SKU-1", "SKU-2"]);
  });

  it("writes no command when a redelivery arrives after the first push landed", async () => {
    const container = fakeContainer("redelivered-after-flush");

    // The first push does real work: one offer was behind, and Allegro confirmed it.
    targetedPush.mockResolvedValueOnce(
      pushResult({ eligible: 1, mismatched: 1, commands: 1, complete: true, synced: 1 }) as never,
    );
    // The second sees the world it just created. This is the mock standing in for the
    // planner's actual answer, which `stock-plan.unit.spec.ts` proves: an offer already
    // carrying the desired quantity is `alreadyInSync`, contributes no change, and so
    // produces no chunk and no command.
    targetedPush.mockResolvedValueOnce(
      pushResult({ eligible: 1, alreadyInSync: 1, commands: 0, complete: true }) as never,
    );

    enqueueStockPush(container as never, ["SKU-1"]);
    await jest.advanceTimersByTimeAsync(5000);
    enqueueStockPush(container as never, ["SKU-1"]);
    await jest.advanceTimersByTimeAsync(5000);

    expect(targetedPush).toHaveBeenCalledTimes(2);
    const [, second] = targetedPush.mock.results.map((r) => r.value);
    expect((await second).commands).toBe(0);

    // And the no-op is not reported as trouble. A redundant push is the SYSTEM WORKING
    // - it is what makes redelivery safe - so alerting on it would page somebody every
    // time the supplier re-reported a SKU it had already moved.
    const log = container.logs.join("\n");
    expect(log).not.toContain("the immediate quantity push for");
    expect(log).toContain("alreadyInSync=1");
  });

  it("does not replay a batch that was still buffered when the worker restarted", async () => {
    const before = fakeContainer("before-restart");
    enqueueStockPush(before as never, ["SKU-1"]);

    // The worker dies with SKU-1 still in the debounce window. The buffer is per-process
    // and in memory by design, so it goes with it - `resetStockPushQueue` is exactly
    // that boundary.
    //
    // This assertion found a real defect the first time it ran: the reset only dropped
    // the module reference, and the discarded queue's armed timer fired anyway and
    // pushed SKU-1 into the new process's world. `StockPushQueue.cancel` now disarms
    // it, which is what a dead process does for free and what this test models.
    resetStockPushQueue();
    targetedPush.mockResolvedValue({ skipped: "test" } as never);

    const after = fakeContainer("after-restart");
    enqueueStockPush(after as never, ["SKU-2"]);
    await jest.advanceTimersByTimeAsync(5000);

    // The new process pushes only what IT was told. SKU-1 is neither pushed twice nor
    // silently carried across - it is simply left to the */15 reconciliation, which is
    // the bounded cost the in-memory buffer was chosen for. Anything else would mean a
    // restart could re-issue a write whose quantity is now stale.
    expect(targetedPush).toHaveBeenCalledTimes(1);
    expect(targetedPush.mock.calls[0]?.[1]).toEqual(["SKU-2"]);
  });
});

describe("summarizeSkus", () => {
  it("elides a bulk movement rather than printing an unreadable list", () => {
    // A supplier-wide restock can dirty hundreds; an alert nobody can read is not an
    // alert. The count of the remainder is kept, because "and 340 more" is itself the
    // signal that this was not a single sale.
    expect(summarizeSkus(["A", "B", "C"], 2)).toBe("A, B and 1 more");
    expect(summarizeSkus(["A", "B"], 2)).toBe("A, B");
    expect(summarizeSkus([], 2)).toBe("");
  });
});
