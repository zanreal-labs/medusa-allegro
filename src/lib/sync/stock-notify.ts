/**
 * The admin-feed alert a failed targeted stock push raises.
 *
 * ## Why this path alerts when the scheduled loops do not
 *
 * The scheduled loops record their outcome on an `allegro_sync_state` row an operator
 * can open, and that is proportionate: a run happens every 15 minutes, the next one
 * re-derives the same difference, and a persistent fault shows up as a red row that
 * stays red.
 *
 * The event-driven push has neither property. It fires once, in response to a sale,
 * and its entire purpose is to close the window in which an item that just sold out
 * is still purchasable on Allegro. A failure there silently REOPENS that window - the
 * quantity stays wrong until the next reconciliation, which is exactly the staleness
 * this path exists to remove - and nothing about it looks broken from the outside.
 * So it is announced, not filed.
 *
 * This module is the pure half: it builds the payload and decides nothing about I/O.
 * The caller resolves the Notification module and sends it, tolerating a host with no
 * provider wired - a missing alert must never fail a push.
 *
 * The `feed` channel with the `admin-ui` template is Medusa's built-in mechanism for
 * in-app admin notifications, served by the Local Notification provider registered by
 * default. Verified against @medusajs 2.18, and the same pair the sibling invoicing
 * plugin uses, so both land in one feed.
 */

/** Medusa's built-in in-app admin notification channel. */
export const ADMIN_FEED_CHANNEL = "feed";
/** The template the default Local provider renders for the admin feed. */
export const ADMIN_FEED_TEMPLATE = "admin-ui";
/** Trigger identifier stamped on the notification, for anyone filtering the feed. */
export const STOCK_PUSH_FAILED_TRIGGER = "allegro.stock_push.failed";

/**
 * How coarsely repeated failures are folded together.
 *
 * Medusa dedupes permanently on `idempotency_key`, so a key built from the SKUs alone
 * would alert once and then go quiet for as long as the fault lasted - which for an
 * alert whose whole point is an open oversell window is the wrong failure mode. A
 * time bucket keeps it re-alerting while broken, at most once per bucket per affected
 * set, so a wedged push is impossible to miss and a burst of them is still one line.
 */
export const STOCK_PUSH_NOTIFY_BUCKET_MS = 900_000;

/**
 * SKUs named in the description before it is elided.
 *
 * The list is the actionable part - an operator wants to know WHICH products are
 * advertising the wrong quantity - but a bulk movement can dirty hundreds, and a
 * notification nobody can read is not an alert.
 */
export const STOCK_PUSH_NOTIFY_MAX_SKUS = 10;

/**
 * Shape accepted by `INotificationModuleService.createNotifications`. Declared
 * structurally rather than imported so this pure module pulls in no framework type
 * surface, and so the builder's output is asserted against a fixed contract in tests.
 */
export interface AdminFeedNotification {
  to: string;
  channel: string;
  template: string;
  data: { title: string; description: string };
  trigger_type: string;
  idempotency_key: string;
}

/** The SKU list as it appears in the description, elided past the cap. */
export const summarizeSkus = (
  skus: readonly string[],
  max: number = STOCK_PUSH_NOTIFY_MAX_SKUS,
): string => {
  const named = skus.slice(0, max).join(", ");
  const rest = skus.length - Math.min(skus.length, max);
  return rest > 0 ? `${named} and ${rest} more` : named;
};

/**
 * Build the admin-feed notification for a targeted push that did not land.
 *
 * The description says what is actually wrong - these SKUs may be advertising a
 * quantity they no longer have - rather than naming an internal loop, because the
 * operator's decision is about the listings, not about this plugin. It also states the
 * fallback explicitly: the reconciliation will retry, so the alert is "check this"
 * rather than "act within seconds", and an operator who knows that will not panic-edit
 * quantities by hand while a sweep is about to fix them.
 *
 * `bucketMs` and `now` are parameters rather than reads of the clock so the key is
 * deterministic in tests.
 */
export const buildStockPushFailedNotification = (input: {
  skus: readonly string[];
  reason: string;
  now: number;
  bucketMs?: number;
}): AdminFeedNotification => {
  const { skus, reason, now } = input;
  const bucketMs = input.bucketMs ?? STOCK_PUSH_NOTIFY_BUCKET_MS;
  // Sorted, so the same affected set produces the same key however the events that
  // dirtied it happened to be ordered.
  const key = [...skus].sort((a, b) => a.localeCompare(b)).join(",");
  return {
    channel: ADMIN_FEED_CHANNEL,
    data: {
      description:
        `The immediate Allegro quantity update for ${skus.length} product(s) failed, so they may be advertising a quantity they no longer have: ${summarizeSkus(skus)}. ` +
        `Reason: ${reason}. The scheduled stock reconciliation will retry and should correct it; if this keeps appearing, the quantity is not reaching Allegro at all.`,
      title: "Allegro stock update failed",
    },
    idempotency_key: `allegro-stock-push-failed-${key}-${Math.floor(now / bucketMs)}`,
    template: ADMIN_FEED_TEMPLATE,
    to: "",
    trigger_type: STOCK_PUSH_FAILED_TRIGGER,
  };
};
