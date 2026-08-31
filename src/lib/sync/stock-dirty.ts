/**
 * The coalescing buffer behind the event-driven quantity push.
 *
 * ## Why a buffer exists at all
 *
 * The 15-minute reconciliation is what makes the quantity on Allegro eventually
 * right; it is also a 15-minute window in which a sold-out item stays purchasable,
 * which is an oversell. The event path closes that window by pushing the moment
 * something moves - but "the moment something moves" is the wrong literal reading.
 * A single web sale of a three-line order emits an `order.placed` and a
 * `reservation-item.created` per line, and a burst of orders multiplies that. Pushing
 * per event would turn one sale into a handful of Allegro commands and a busy minute
 * into a write storm, against a 9000/min budget the order drain also spends.
 *
 * So events do not push. They mark SKUs dirty here, and a short debounce turns any
 * number of events naming any number of SKUs into ONE push carrying the distinct set.
 * Two sales of the same variant a second apart cost exactly one command, not two.
 *
 * ## Debounce, with a ceiling
 *
 * A plain debounce restarts its clock on every mark, so a steady trickle of orders
 * would postpone the push indefinitely - the exact case the window is meant to close.
 * The wait is therefore the debounce from the LAST mark, capped at `maxWaitMs` from
 * the FIRST: a quiet moment flushes fast, and a sustained burst still flushes on a
 * bounded schedule instead of never.
 *
 * `MAX_SKUS` is the third bound. Past it the buffer stops waiting and asks to flush
 * now - a set that large is a bulk inventory movement, and the cost of holding it is
 * a growing list of variants whose quantity is wrong on the marketplace.
 *
 * ## What is deliberately NOT here
 *
 * No I/O, no timers, no container. The buffer answers two questions - "what is
 * dirty" and "how long until it should be pushed" - so both are testable against a
 * fake clock without a scheduler, and the scheduler that owns the real timer
 * (`workflows/lib/stock-push-queue`) holds no policy of its own.
 *
 * ## Losing the buffer is bounded, and that is the design
 *
 * It is per-process and in memory, so a restart drops whatever had not flushed. That
 * is survivable precisely because the event path is ADDITIVE: the 15-minute
 * reconciliation still reads the whole catalogue and repairs anything the events
 * missed. A dropped mark costs at most the staleness the store already had before
 * this path existed, never more - which is why this is not a persisted queue with a
 * migration behind it.
 */

/** Quiet period after the last mark before a flush is due. */
export const STOCK_PUSH_DEBOUNCE_MS = 3_000;
/**
 * Longest a dirty SKU waits, measured from the FIRST mark of the current batch.
 *
 * The debounce's ceiling: without it a steady stream of orders restarts the quiet
 * period forever and the push never happens.
 */
export const STOCK_PUSH_MAX_WAIT_MS = 30_000;
/**
 * Distinct SKUs after which the buffer stops waiting and asks to flush immediately.
 *
 * Nothing is ever dropped - a dropped SKU is a quantity published nowhere until the
 * next reconciliation. The cap only shortens the wait.
 */
export const STOCK_PUSH_MAX_SKUS = 500;

export interface StockDirtyBufferOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  maxSkus?: number;
}

/**
 * A set of dirty SKUs plus the two timestamps the wait is computed from.
 *
 * Deliberately a class rather than a module-level set: the scheduler owns one
 * long-lived instance, and tests own their own, so a test can never be polluted by
 * whatever a previous one left behind.
 */
export class StockDirtyBuffer {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxSkus: number;
  private readonly dirty = new Set<string>();
  /** When the current batch was first marked; null while the buffer is empty. */
  private firstMarkedAt: number | null = null;
  /** When the current batch was last marked; null while the buffer is empty. */
  private lastMarkedAt: number | null = null;

  constructor(options: StockDirtyBufferOptions = {}) {
    this.debounceMs = options.debounceMs ?? STOCK_PUSH_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? STOCK_PUSH_MAX_WAIT_MS;
    this.maxSkus = options.maxSkus ?? STOCK_PUSH_MAX_SKUS;
  }

  /**
   * Mark SKUs dirty. Blank entries are dropped rather than buffered: a variant with
   * no SKU cannot be mapped to an offer, so it would only ever widen a push to
   * nothing.
   *
   * Returns the number of SKUs that were not already pending, which is what the
   * scheduler logs - "three events, one new SKU" is the coalescing working, and it is
   * worth being able to see.
   */
  mark(skus: readonly string[], now: number): number {
    let added = 0;
    for (const raw of skus) {
      const sku = raw?.trim();
      if (!sku || this.dirty.has(sku)) {
        continue;
      }
      this.dirty.add(sku);
      added += 1;
    }
    if (this.dirty.size === 0) {
      return 0;
    }
    // Only a mark that actually landed moves the clock. An event naming SKUs that are
    // all already pending must not push the flush further out, or a stream of
    // duplicates would starve the batch it is duplicating.
    if (added > 0) {
      this.firstMarkedAt ??= now;
      this.lastMarkedAt = now;
    }
    return added;
  }

  /** Distinct SKUs currently waiting. */
  get size(): number {
    return this.dirty.size;
  }

  isEmpty(): boolean {
    return this.dirty.size === 0;
  }

  /**
   * Milliseconds until this batch should be pushed, or null when nothing is pending.
   *
   * Zero means "now": either the quiet period has already elapsed, the ceiling has
   * been reached, or the batch is large enough that waiting costs more than pushing.
   */
  waitMs(now: number): number | null {
    if (this.dirty.size === 0) {
      return null;
    }
    if (this.dirty.size >= this.maxSkus) {
      return 0;
    }
    const since = this.lastMarkedAt ?? now;
    const first = this.firstMarkedAt ?? now;
    const due = Math.min(since + this.debounceMs, first + this.maxWaitMs);
    return Math.max(due - now, 0);
  }

  /**
   * Take everything pending and reset.
   *
   * Sorted, so a push is deterministic and a test can assert on it without caring
   * about the order events happened to arrive in.
   */
  drain(): string[] {
    const skus = [...this.dirty].sort((a, b) => a.localeCompare(b));
    this.dirty.clear();
    this.firstMarkedAt = null;
    this.lastMarkedAt = null;
    return skus;
  }
}
