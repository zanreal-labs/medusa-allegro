import {
  STOCK_PUSH_DEBOUNCE_MS,
  STOCK_PUSH_MAX_SKUS,
  STOCK_PUSH_MAX_WAIT_MS,
  StockDirtyBuffer,
} from "../stock-dirty";

/**
 * The coalescing policy, against a fake clock.
 *
 * Everything the event path promises about NOT flooding Allegro is decided here, so
 * it is asserted here rather than through the queue that merely owns a timer.
 */
describe("StockDirtyBuffer", () => {
  it("collapses a burst naming the same SKU into one pending entry", () => {
    const buffer = new StockDirtyBuffer();
    // Three events for one variant - an `order.placed` plus a reservation per line is
    // exactly this shape - must cost one Allegro command, not three.
    expect(buffer.mark(["SKU-1"], 0)).toBe(1);
    expect(buffer.mark(["SKU-1"], 100)).toBe(0);
    expect(buffer.mark(["SKU-1"], 200)).toBe(0);
    expect(buffer.size).toBe(1);
    expect(buffer.drain()).toEqual(["SKU-1"]);
  });

  it("unions the SKUs of overlapping orders into one batch", () => {
    const buffer = new StockDirtyBuffer();
    buffer.mark(["SKU-1", "SKU-2"], 0);
    buffer.mark(["SKU-2", "SKU-3"], 500);
    // Sorted and distinct: one push covering all three, each named once.
    expect(buffer.drain()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
  });

  it("waits the debounce from the LAST mark, so a burst settles before pushing", () => {
    const buffer = new StockDirtyBuffer({ debounceMs: 1000, maxWaitMs: 10_000 });
    buffer.mark(["SKU-1"], 0);
    expect(buffer.waitMs(0)).toBe(1000);
    // A second event 400ms in pushes the flush out to 1400, not to 1000: the batch is
    // still growing, and pushing mid-burst is what produces two commands for one sale.
    buffer.mark(["SKU-2"], 400);
    expect(buffer.waitMs(400)).toBe(1000);
    expect(buffer.waitMs(900)).toBe(500);
  });

  it("does not let a repeat of an already-pending SKU postpone the batch", () => {
    const buffer = new StockDirtyBuffer({ debounceMs: 1000, maxWaitMs: 10_000 });
    buffer.mark(["SKU-1"], 0);
    // Nothing new landed, so the clock must not move - otherwise a stream of duplicate
    // events for one variant starves the batch it is duplicating.
    expect(buffer.mark(["SKU-1"], 900)).toBe(0);
    expect(buffer.waitMs(900)).toBe(100);
  });

  it("caps the wait at maxWaitMs from the FIRST mark, so a steady stream still flushes", () => {
    const buffer = new StockDirtyBuffer({ debounceMs: 1000, maxWaitMs: 3000 });
    buffer.mark(["SKU-1"], 0);
    // A new SKU every 900ms: a plain debounce would never fire. The ceiling makes the
    // batch due at first + 3000 regardless.
    buffer.mark(["SKU-2"], 900);
    buffer.mark(["SKU-3"], 1800);
    buffer.mark(["SKU-4"], 2700);
    expect(buffer.waitMs(2700)).toBe(300);
    expect(buffer.waitMs(3000)).toBe(0);
  });

  it("asks to flush immediately once the SKU cap is reached, and drops nothing", () => {
    const buffer = new StockDirtyBuffer({ debounceMs: 1000, maxSkus: 3 });
    buffer.mark(["SKU-1", "SKU-2"], 0);
    expect(buffer.waitMs(0)).toBe(1000);
    buffer.mark(["SKU-3"], 10);
    // A bulk movement is pushed now rather than held: every SKU still waiting is a
    // quantity that is wrong on the marketplace.
    expect(buffer.waitMs(10)).toBe(0);
    expect(buffer.drain()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
  });

  it("ignores blank SKUs rather than buffering them", () => {
    const buffer = new StockDirtyBuffer();
    // A variant with no SKU cannot be mapped to an offer, so buffering it would only
    // widen a push to nothing.
    expect(buffer.mark(["", "  ", "SKU-1"], 0)).toBe(1);
    expect(buffer.drain()).toEqual(["SKU-1"]);
  });

  it("reports no wait and no work when empty", () => {
    const buffer = new StockDirtyBuffer();
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.waitMs(0)).toBeNull();
    buffer.mark([], 0);
    expect(buffer.waitMs(0)).toBeNull();
  });

  it("resets its clock on drain, so the next batch gets a full debounce", () => {
    const buffer = new StockDirtyBuffer({ debounceMs: 1000, maxWaitMs: 3000 });
    buffer.mark(["SKU-1"], 0);
    buffer.drain();
    buffer.mark(["SKU-2"], 5000);
    // Measured from 5000, not from the drained batch's first mark - otherwise the
    // ceiling of a long-gone batch would force the next one out instantly.
    expect(buffer.waitMs(5000)).toBe(1000);
  });

  it("ships defaults that bound the window without being chatty", () => {
    // Asserted so a change to any of the three is a deliberate edit to this test, not
    // a silent shift in how hard the event path hits Allegro.
    expect(STOCK_PUSH_DEBOUNCE_MS).toBe(3000);
    expect(STOCK_PUSH_MAX_WAIT_MS).toBe(30_000);
    expect(STOCK_PUSH_MAX_SKUS).toBe(500);
  });
});
