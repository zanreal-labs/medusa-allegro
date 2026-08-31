import { StockPushQueue } from "../lib/stock-push-queue";

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
