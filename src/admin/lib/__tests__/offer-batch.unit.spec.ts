import { createOfferBatcher, MAX_SKUS_PER_REQUEST } from "../offer-batch";
import type { FlushScheduler, OfferFetcher } from "../offer-batch";
import type { OfferRow } from "../types";

const offer = (sku: string, overrides: Partial<OfferRow> = {}): OfferRow => ({
  id: `off_${sku}`,
  offer_id: "12345",
  sku,
  ...overrides,
});

/**
 * A scheduler the test drives by hand, so a batch's boundary is an explicit
 * event rather than a timer race. `flush()` is what the real one does at the
 * end of the tick, once React has run every visible cell's effect.
 */
function manualScheduler(): FlushScheduler & { flush: () => void } {
  let queued: (() => void) | null = null;
  const schedule = ((callback: () => void) => {
    queued = callback;
  }) as FlushScheduler & { flush: () => void };
  schedule.flush = () => {
    const run = queued;
    queued = null;
    run?.();
  };
  return schedule;
}

describe("createOfferBatcher", () => {
  it("turns a page of per-row lookups into ONE request", async () => {
    // The regression this exists to stop: `loadData` runs per row, and this
    // plugin now has two columns backed by the same row. Twenty rows across
    // two columns must not be forty requests.
    const calls: string[][] = [];
    const fetchOffers: OfferFetcher = async (skus) => {
      calls.push(skus);
      return skus.map((sku) => offer(sku));
    };
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(fetchOffers, schedule);

    const skus = Array.from({ length: 20 }, (_, index) => `SKU-${index}`);
    const pending = [
      ...skus.map((sku) => batcher.load(sku)),
      ...skus.map((sku) => batcher.load(sku)),
    ];
    schedule.flush();
    const resolved = await Promise.all(pending);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(20);
    expect(resolved).toHaveLength(40);
    expect(resolved.every((row) => row !== null)).toBe(true);
  });

  it("asks for a SKU once even when both columns want it", async () => {
    const calls: string[][] = [];
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(async (skus) => {
      calls.push(skus);
      return skus.map((sku) => offer(sku));
    }, schedule);

    const first = batcher.load("SKU-1");
    const second = batcher.load("SKU-1");
    schedule.flush();

    expect(calls[0]).toEqual(["SKU-1"]);
    expect((await first)?.id).toBe("off_SKU-1");
    expect((await second)?.id).toBe("off_SKU-1");
  });

  it("gives every waiter the row for its own SKU, not the first row back", async () => {
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(
      async () => [offer("SKU-B", { offer_id: "b" }), offer("SKU-A", { offer_id: "a" })],
      schedule,
    );

    const a = batcher.load("SKU-A");
    const b = batcher.load("SKU-B");
    schedule.flush();

    expect((await a)?.offer_id).toBe("a");
    expect((await b)?.offer_id).toBe("b");
  });

  it("resolves null - not an error - for a SKU with no offer", async () => {
    // Most of this catalogue is not on Allegro. "No offer" is a fact the cell
    // renders calmly; only a broken request is an error.
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(async () => [], schedule);

    const pending = batcher.load("SKU-1");
    schedule.flush();
    await expect(pending).resolves.toBeNull();
  });

  it("rejects every waiter in a failed batch, so no cell silently reads as unlisted", async () => {
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(async () => {
      throw new Error("boom");
    }, schedule);

    const first = batcher.load("SKU-1");
    const second = batcher.load("SKU-2");
    schedule.flush();

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });

  it("splits a batch larger than the route's SKU cap", async () => {
    const calls: string[][] = [];
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(async (skus) => {
      calls.push(skus);
      return skus.map((sku) => offer(sku));
    }, schedule);

    const total = MAX_SKUS_PER_REQUEST + 5;
    const pending = Array.from({ length: total }, (_, index) => batcher.load(`SKU-${index}`));
    schedule.flush();
    await Promise.all(pending);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(MAX_SKUS_PER_REQUEST);
    expect(calls[1]).toHaveLength(5);
  });

  it("starts a new batch after a flush instead of joining one already sent", async () => {
    const calls: string[][] = [];
    const schedule = manualScheduler();
    const batcher = createOfferBatcher(async (skus) => {
      calls.push(skus);
      return skus.map((sku) => offer(sku));
    }, schedule);

    const first = batcher.load("SKU-1");
    schedule.flush();
    await first;

    const second = batcher.load("SKU-2");
    schedule.flush();
    await second;

    expect(calls).toEqual([["SKU-1"], ["SKU-2"]]);
  });

  it("defaults to deferring the flush to the end of the tick", async () => {
    // Without an injected scheduler the real one has to actually batch: every
    // cell effect in one React flush must land in the same request.
    const calls: string[][] = [];
    const batcher = createOfferBatcher(async (skus) => {
      calls.push(skus);
      return skus.map((sku) => offer(sku));
    });

    const pending = [batcher.load("SKU-1"), batcher.load("SKU-2")];
    expect(calls).toHaveLength(0);
    await Promise.all(pending);

    expect(calls).toEqual([["SKU-1", "SKU-2"]]);
  });
});
