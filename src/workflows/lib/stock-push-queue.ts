import type {
  INotificationModuleService,
  Logger,
  MedusaContainer,
} from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";
import { StockDirtyBuffer } from "../../lib/sync/stock-dirty";
import type { StockDirtyBufferOptions } from "../../lib/sync/stock-dirty";
import { buildStockPushFailedNotification } from "../../lib/sync/stock-notify";
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
 * Raise the admin-feed alert for a targeted push that did not land.
 *
 * Swallows every failure. A host that has wired no notification provider, or a
 * transient fault in the module, must never turn a contained push failure into an
 * unhandled rejection from a timer.
 */
const notifyStockPushFailed = async (
  container: MedusaContainer,
  logger: Logger,
  skus: string[],
  reason: string,
): Promise<void> => {
  try {
    const notifications = container.resolve<INotificationModuleService>(
      Modules.NOTIFICATION,
    );
    await notifications.createNotifications(
      buildStockPushFailedNotification({ now: Date.now(), reason, skus }),
    );
  } catch (error) {
    logger.warn(
      `[allegro-stock] could not raise an admin notification for the failed quantity push of ${skus.length} SKU(s): ${describeError(error)}. The failure is still logged above, and the scheduled reconciliation will retry.`,
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
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  queue ??= new StockPushQueue({
    onError: (error, failed) => {
      const reason = describeError(error);
      logger.error(
        `[allegro-stock] the immediate quantity push for ${failed.length} SKU(s) failed: ${reason}. They may be advertising a stale quantity on Allegro until the next scheduled reconciliation. SKUs: ${failed.join(", ")}`,
      );
      void notifyStockPushFailed(container, logger, failed, reason);
    },
    onSchedule: ({ added, pending, waitMs }) => {
      // Debug rather than info: this fires per event, and a store doing normal volume
      // would otherwise write several lines per sale into the log the order drain
      // shares.
      logger.debug(
        `[allegro-stock] ${added} new dirty SKU(s), ${pending} pending, pushing in ${waitMs}ms`,
      );
    },
    push: async (dirty) => {
      const result = await pushTargetedAllegroStock(container, dirty);
      if (result.skipped) {
        // A skip is not a failure and must not alert: a held claim means a
        // reconciliation is pushing these very SKUs right now, and a flipped kill
        // switch means an operator asked for no writes.
        logger.info(
          `[allegro-stock] immediate push of ${dirty.length} SKU(s) skipped: ${result.skipped}`,
        );
        return;
      }
      logger.info(
        `[allegro-stock] immediate push: skus=${dirty.length} eligible=${result.eligible} ` +
          `mismatched=${result.mismatched} synced=${result.synced} alreadyInSync=${result.alreadyInSync} ` +
          `pending=${result.pending} failed=${result.failed}`,
      );
      if (result.error) {
        // Thrown so the queue's `onError` raises the alert: a push that reported
        // failures left a quantity wrong on the marketplace, which is the whole thing
        // this path exists to prevent, and it must not be a log line nobody reads.
        throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, result.error);
      }
    },
  });
  queue.add(skus);
};

/** Reset the process-wide queue. Tests only. */
export const resetStockPushQueue = (): void => {
  queue = undefined;
};
