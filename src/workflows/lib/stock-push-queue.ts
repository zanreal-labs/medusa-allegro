import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { raiseAllegroAlert } from "../../lib/admin-notification";
import { describeError } from "../../lib/allegro/errors";
import { StockDirtyBuffer } from "../../lib/sync/stock-dirty";
import type { StockDirtyBufferOptions } from "../../lib/sync/stock-dirty";
import { pushTargetedAllegroStock } from "../push-allegro-stock";

/**
 * The timer between "something moved" and "Allegro has been told".
 *
 * Subscribers hand SKUs to this queue instead of pushing, and the queue turns any
 * number of events into one push per debounce window. See `lib/sync/stock-dirty` for
 * why the window exists and how its ceiling is derived; this file owns only the parts
 * that cannot be pure - the real timer, the container, the push, and the alert.
 *
 * ## Single-flight, twice, for two different collisions
 *
 * The STOCK claim in `runUnderSyncClaim` already stops two PROCESSES pushing at once,
 * and that is the collision that matters for correctness. It does not stop one process
 * from starting a second push while its own is still in flight, and that one matters
 * for behaviour: the second would find the claim held, log a skip, and drop its SKUs
 * on the floor - a dirty SKU silently discarded, which is precisely the failure this
 * path exists to prevent.
 *
 * So the queue serialises itself. While a flush is running, marks accumulate; when it
 * finishes, anything that arrived meanwhile is scheduled as the next batch. Nothing is
 * dropped and nothing races.
 *
 * ## A flush never throws
 *
 * It is called from a timer, so there is no caller to catch it: an unhandled rejection
 * from a background timer takes the worker down, which would turn a failed stock push
 * into an outage of the order drain. Every failure is contained, logged, and raised as
 * an admin alert instead.
 */

/** How the queue reaches the outside world. Injected so tests need no container. */
export interface StockPushQueueDeps {
  /** Push these SKUs. Rejections are contained by the queue, never rethrown. */
  push: (skus: string[]) => Promise<void>;
  /** Reported when a push rejects. */
  onError?: (error: unknown, skus: string[]) => void;
  /** Reported when a batch is scheduled, for the "three events, one push" log line. */
  onSchedule?: (info: { added: number; pending: number; waitMs: number }) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  buffer?: StockDirtyBufferOptions;
}

/**
 * A debounced, coalescing queue of dirty SKUs.
 *
 * Exported as a class rather than a set of module-level functions so a test owns its
 * own instance with its own fake clock, and so the process-wide singleton below is one
 * explicit line rather than hidden module state.
 */
export class StockPushQueue {
  private readonly buffer: StockDirtyBuffer;
  private readonly deps: Required<
    Pick<StockPushQueueDeps, "push" | "now" | "setTimer" | "clearTimer">
  > &
    StockPushQueueDeps;
  private timer: unknown = null;
  private flushing = false;

  constructor(deps: StockPushQueueDeps) {
    this.buffer = new StockDirtyBuffer(deps.buffer);
    // The resolved defaults come AFTER the spread, not before it. Spreading last would
    // let a caller that passes `{ now: undefined }` - an explicitly present key, which
    // is easy to produce from an options object - overwrite a working default with
    // undefined, and the failure would be a `TypeError` from inside a timer.
    this.deps = {
      ...deps,
      clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle as never)),
      now: deps.now ?? (() => Date.now()),
      push: deps.push,
      setTimer:
        deps.setTimer ??
        ((fn, ms) => {
          const handle = setTimeout(fn, ms);
          // A pending stock push must not be the reason a worker refuses to exit.
          // The reconciliation covers whatever a shutdown drops.
          handle.unref?.();
          return handle;
        }),
    };
  }

  /** Mark SKUs dirty and (re)arm the timer. Never throws, never blocks. */
  add(skus: readonly string[]): void {
    const now = this.deps.now();
    const added = this.buffer.mark(skus, now);
    if (this.buffer.isEmpty()) {
      return;
    }
    const waitMs = this.buffer.waitMs(now) ?? 0;
    this.deps.onSchedule?.({ added, pending: this.buffer.size, waitMs });
    this.arm(waitMs);
  }

  /** SKUs waiting to be pushed. For tests and for the log line. */
  get pending(): number {
    return this.buffer.size;
  }

  /**
   * Disarm this queue: cancel the pending flush and drop what it was holding.
   *
   * Exists because discarding the module-level reference is NOT enough to stop a
   * queue. An armed `setTimeout` keeps its closure - and therefore the queue - alive,
   * so a discarded instance still fires, still resolves the live container, and still
   * pushes SKUs the replacement queue knows nothing about. In a test that is
   * cross-test pollution; anywhere else it is a write nobody asked for.
   *
   * Dropping the pending SKUs rather than handing them over is deliberate and is the
   * same bounded cost the in-memory buffer already accepts: the scheduled reconciliation
   * reads the whole catalogue and repairs them. Re-issuing them later would mean
   * pushing a quantity read before whatever caused the reset.
   *
   * A flush already in flight is left to finish - it holds the STOCK claim and is
   * mid-conversation with Allegro, and aborting it there would leave offers written
   * and unstamped. It re-arms into a buffer this call has emptied, so it stops after
   * itself.
   */
  cancel(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.buffer.drain();
  }

  /**
   * Re-arm the timer for `waitMs`.
   *
   * The existing timer is always cleared first: a later mark can only ever make the
   * batch due SOONER (the ceiling in `StockDirtyBuffer.waitMs` is measured from the
   * first mark, so it never recedes), and leaving a stale timer armed would fire a
   * second flush on an already-drained buffer.
   */
  private arm(waitMs: number): void {
    if (this.flushing) {
      // The running flush re-arms from its own completion. Arming now would schedule a
      // push that finds the claim held and drops its SKUs.
      return;
    }
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, waitMs);
  }

  /**
   * Push whatever is pending.
   *
   * Public so a shutdown hook or a test can force the batch out without waiting on a
   * timer. Awaiting it is safe: it resolves once the push has settled, however it
   * settled.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.isEmpty()) {
      return;
    }
    this.flushing = true;
    const skus = this.buffer.drain();
    try {
      await this.deps.push(skus);
    } catch (error) {
      // Contained deliberately: see the file comment. The SKUs are NOT put back - a
      // retry loop here would hammer a broken Allegro with the same batch, and the
      // scheduled reconciliation is the retry that already exists and is rate-aware.
      this.deps.onError?.(error, skus);
    } finally {
      this.flushing = false;
      // Anything that arrived while the push was in flight becomes the next batch.
      if (!this.buffer.isEmpty()) {
        this.arm(this.buffer.waitMs(this.deps.now()) ?? 0);
      }
    }
  }
}

/**
 * SKUs named in the alert before the list is elided.
 *
 * The list is the actionable part - an operator wants to know WHICH products are
 * advertising the wrong quantity - but a bulk supplier movement can dirty hundreds,
 * and an alert nobody can read is not an alert.
 */
export const ALERT_MAX_SKUS = 10;

/** The SKU list as it appears in the alert detail, elided past the cap. */
export const summarizeSkus = (
  skus: readonly string[],
  max: number = ALERT_MAX_SKUS,
): string => {
  const named = skus.slice(0, max).join(", ");
  const rest = skus.length - Math.min(skus.length, max);
  return rest > 0 ? `${named} and ${rest} more` : named;
};

/**
 * Raise the admin-feed alert for a targeted push that did not land.
 *
 * Through the SHARED `raiseAllegroAlert`, not a private builder. This path used to
 * have its own, written before the shared one existed, and the result was two ways
 * to raise an Allegro alert with two different trigger spellings - exactly the drift
 * this plugin argues against everywhere else. One emitter, one taxonomy.
 *
 * `resourceId` is the loop, not the SKU set, and that is the substantive change the
 * consolidation brings. The old builder keyed on the SKU list plus a 15-minute time
 * bucket, so an ongoing failure produced a NEW feed entry for every distinct set of
 * SKUs in every bucket - a fault affecting a rotating handful of products could fill
 * the feed while looking like many separate incidents. Keying on the loop gives one
 * persistent entry that updates, which is what the shared builder's idempotency key
 * is for and what the Slack mirror's throttle already collapses on. The affected
 * SKUs move into the detail line, where they stay visible without multiplying the
 * alert.
 *
 * Best-effort: `raiseAllegroAlert` never throws and reports failure by returning
 * false, which is logged here. An alert that cannot be recorded must not turn a
 * contained push failure into an unhandled rejection from a timer.
 */
const notifyStockPushFailed = async (
  container: MedusaContainer,
  logger: Logger,
  skus: string[],
  reason: string,
): Promise<void> => {
  const raised = await raiseAllegroAlert(container, {
    detail: `${skus.length} SKU(s): ${summarizeSkus(skus)}. Reason: ${reason}`,
    kind: "stock_push_failed",
    resourceId: "stock",
  });
  if (!raised) {
    logger.warn(
      `[allegro-stock] could not raise an admin notification for the failed quantity push of ${skus.length} SKU(s). The failure is still logged above, and the scheduled reconciliation will retry.`,
    );
  }
};

/**
 * The process-wide queue.
 *
 * Lazily built because it needs a container, and a subscriber is the first thing that
 * has one. Keyed on nothing: one worker process, one queue - a second instance would
 * defeat the coalescing it exists to provide.
 */
let queue: StockPushQueue | undefined;

/**
 * The container the NEXT flush will use.
 *
 * Deliberately a moving reference rather than one captured in the queue's closures.
 * The queue outlives any single event - that is the point of it - so closing over the
 * container of whichever event happened to build it would pin the process to that one
 * forever, and a push firing seconds later would run against a container its own event
 * has finished with. Re-pointing it per event costs nothing and means the flush always
 * uses a live one.
 */
let activeContainer: MedusaContainer | undefined;

/** The current container, or a refusal rather than a confusing `undefined.resolve`. */
const requireContainer = (): MedusaContainer => {
  if (!activeContainer) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "medusa-allegro: the stock push queue flushed with no container. Nothing can be pushed.",
    );
  }
  return activeContainer;
};

/**
 * Hand SKUs to the process-wide queue, building it on first use.
 *
 * Exported for the subscribers. Everything about the push - the claim, the kill
 * switch, the plan-safety refusal - lives in `pushTargetedAllegroStock`; what happens
 * here is only the batching and the reporting.
 */
export const enqueueStockPush = (
  container: MedusaContainer,
  skus: readonly string[],
): void => {
  activeContainer = container;
  queue ??= new StockPushQueue({
    onError: (error, failed) => {
      const active = requireContainer();
      const log = active.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
      const reason = describeError(error);
      log.error(
        `[allegro-stock] the immediate quantity push for ${failed.length} SKU(s) failed: ${reason}. They may be advertising a stale quantity on Allegro until the next scheduled reconciliation. SKUs: ${failed.join(", ")}`,
      );
      void notifyStockPushFailed(active, log, failed, reason);
    },
    onSchedule: ({ added, pending, waitMs }) => {
      // Debug rather than info: this fires per event, and a store doing normal volume
      // would otherwise write several lines per sale into the log the order drain
      // shares.
      //
      // Resolved from the active container like the other two, even though this one
      // fires synchronously from `add` and would have got the right logger anyway. A
      // single rule - "the callbacks use the current container" - is what stops the
      // next edit reintroducing the captured reference.
      requireContainer()
        .resolve<Logger>(ContainerRegistrationKeys.LOGGER)
        .debug(
          `[allegro-stock] ${added} new dirty SKU(s), ${pending} pending, pushing in ${waitMs}ms`,
        );
    },
    push: async (dirty) => {
      const active = requireContainer();
      const logger = active.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
      const result = await pushTargetedAllegroStock(active, dirty);
      if (result.skipped) {
        // A skip is not a failure and must not alert: a held claim means a
        // reconciliation is pushing these very SKUs right now, and a flipped kill
        // switch means an operator asked for no writes.
        logger.info(
          `[allegro-stock] immediate push of ${dirty.length} SKU(s) skipped: ${result.skipped}`,
        );
        return;
      }
      // The full skip ladder on the line, not just the write counters. Every one of
      // these buckets means "this offer's quantity was published nowhere", and after
      // the alert was narrowed to genuine failures the log is the ONLY place a skip
      // is visible - so it has to name each reason rather than leave an operator to
      // infer the gap from `synced` being smaller than they expected.
      logger.info(
        `[allegro-stock] immediate push: skus=${dirty.length} eligible=${result.eligible} ` +
          `mismatched=${result.mismatched} synced=${result.synced} alreadyInSync=${result.alreadyInSync} ` +
          `pending=${result.pending} failed=${result.failed} ` +
          `unlinked=${result.skippedUnlinked} unmatched=${result.skippedUnmatched} ` +
          `conflicted=${result.conflicted} noInventory=${result.skippedNoInventory} ` +
          `noListingStock=${result.skippedNoListingStock}`,
      );
      if (result.finding) {
        // Reported, never alerted. A finding is a run that did its job while leaving
        // something out on purpose, and the commonest one here - a variant no Allegro
        // offer claims - is a PERMANENT, deliberate state in this store, because
        // auctions are created by hand. Paging on it would fire on every stock
        // movement of every unlisted product until nobody reads the alerts at all.
        logger.info(`[allegro-stock] immediate push findings: ${result.finding}`);
      }
      if (result.error) {
        // Thrown so the queue's `onError` raises the alert. Reserved for a run that
        // genuinely FAILED: an Allegro API error, a command Allegro rejected, or a
        // plan refused over an ambiguous or unreadable quantity. What those have in
        // common is a MAPPED offer that may now be advertising stock the store does
        // not have - which is the oversell this whole path exists to prevent, and the
        // only condition worth waking somebody for.
        throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, result.error);
      }
    },
  });
  queue.add(skus);
};

/**
 * Reset the process-wide queue and its container. Tests only.
 *
 * The existing queue is CANCELLED rather than merely dereferenced. See
 * `StockPushQueue.cancel`: an armed timer outlives the reference that armed it, so
 * dropping the variable alone left a discarded queue to fire against whatever
 * container was live at the time.
 */
export const resetStockPushQueue = (): void => {
  queue?.cancel();
  activeContainer = undefined;
  queue = undefined;
};
