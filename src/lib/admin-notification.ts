/**
 * Admin feed notifications for Allegro conditions a person needs to see.
 *
 * The point of this file: when a promotion applies to only some of its Allegro
 * auctions, when the stored token cannot write offers, or when a price-sync tick
 * holds on a systemic condition, the operator should be told without watching a
 * log. Medusa 2.18 has exactly one supported surface for that - the admin
 * notification feed behind the dashboard's bell icon, which reads notifications on
 * the `feed` channel and renders `data.title` / `data.description`. Core's own
 * flows push to it the same way (`{ to: "", channel: "feed", template: "admin-ui",
 * data: {...} }`), and so do this repo's sibling plugins (marken, infakt), so this
 * matches a first-class mechanism rather than inventing one.
 *
 * Crucially it raises a NOTIFICATION, not a bespoke event. `@zanreal/medusa-slack`
 * already mirrors every feed notification to Slack, classifying by `trigger_type`,
 * so raising one here reaches Slack with zero new wiring - and reaches it exactly
 * once per condition, because the Slack mirror throttles repeats and this builder
 * sets an idempotency key that collapses a sweep re-raising the same condition.
 * The `allegro.*` trigger names are the ones medusa-slack's ALERT_CLASSES already
 * classifies.
 *
 * The builder is PURE and separate from the send, so the two things worth testing
 * - what the operator reads, and how a repeat is deduplicated - are testable
 * without a container. The send is a thin resolve-and-call helper.
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * The Allegro conditions worth a feed entry.
 *
 * - `promotion_half_applied` - a promotion repriced some of its targeted auctions
 *   but not all; a live marketplace is inconsistently discounted. Critical.
 * - `promotion_no_coverage` - an armed promotion resolved to zero eligible
 *   auctions; the discount the operator believes is live is not. Warning.
 * - `write_scope_missing` - the token cannot write offers, so writes no-op until a
 *   reconnect. Warning.
 * - `price_sync_systemic` - a tick held on a systemic condition (429/5xx/auth).
 *   Warning; the loop self-heals, but a persistent one needs eyes.
 */
export type AllegroAlertKind =
  | "promotion_half_applied"
  | "promotion_no_coverage"
  | "write_scope_missing"
  | "price_sync_systemic";

export interface BuildAllegroAlertInput {
  kind: AllegroAlertKind;
  /**
   * A stable identifier for the thing the alert is about - a promotion id for the
   * promotion alerts, a provider label for the account-wide ones. It anchors both
   * the idempotency key (one persistent feed entry per condition) and the Slack
   * throttle key (the mirror collapses repeats of the same trigger+resource).
   */
  resourceId: string;
  /** One-line human detail: which promotion, how many auctions, the error text. */
  detail?: string;
}

/** The feed-channel notification payload, shaped like core's own admin feeds. */
export interface AdminFeedNotification {
  to: string;
  channel: "feed";
  template: "admin-ui";
  trigger_type: string;
  resource_id: string;
  idempotency_key: string;
  data: { title: string; description: string };
}

const TITLES: Record<AllegroAlertKind, string> = {
  price_sync_systemic: "Allegro price sync held",
  promotion_half_applied: "Allegro promotion only partly applied",
  promotion_no_coverage: "Allegro promotion covers no auctions",
  write_scope_missing: "Allegro cannot write offers",
};

const DESCRIPTIONS: Record<AllegroAlertKind, string> = {
  price_sync_systemic:
    "A price-sync tick held on a systemic condition (rate limit, 5xx, or auth). Nothing was mispriced and the next tick retries; if it persists, check the Allegro connection.",
  promotion_half_applied:
    "A promotion repriced some but not all of its targeted Allegro auctions. The marketplace is inconsistently discounted until the rest apply or are resolved.",
  promotion_no_coverage:
    "An armed promotion resolved to zero eligible Allegro auctions. Check the promotion's product targets, its sales-channel scope, and that the offers are linked and active.",
  write_scope_missing:
    "The stored Allegro token cannot write offers (missing offer write scope), so every price and promotion write no-ops. Reconnect Allegro with the write scope.",
};

/**
 * One persistent feed entry per condition. Keyed on trigger + resource, so a sweep
 * re-raising the same condition updates rather than multiplies it - the same
 * property marken relies on, and what keeps the feed (and, through the mirror,
 * Slack) from filling with repeats of one ongoing problem.
 */
const idempotencyKey = (input: BuildAllegroAlertInput): string =>
  `allegro-${input.kind}-${input.resourceId}`;

/** Build the feed notification for one Allegro condition. Pure. */
export const buildAllegroAlert = (input: BuildAllegroAlertInput): AdminFeedNotification => {
  const description = input.detail?.trim()
    ? `${DESCRIPTIONS[input.kind]}\n${input.detail.trim()}`
    : DESCRIPTIONS[input.kind];
  return {
    channel: "feed",
    data: { description, title: TITLES[input.kind] },
    idempotency_key: idempotencyKey(input),
    resource_id: input.resourceId,
    template: "admin-ui",
    to: "",
    trigger_type: `allegro.${input.kind}`,
  };
};

interface NotificationModuleLike {
  createNotifications: (notification: AdminFeedNotification) => Promise<unknown>;
}

/**
 * Raise one Allegro admin-feed alert.
 *
 * Best-effort by design and never throws: an alert that cannot be recorded must
 * not fail the loop that raised it - the condition it describes (a half-applied
 * promotion, a missing scope) already happened, and turning a missed feed entry
 * into an unbounded retry would make a bad situation worse. A failure is returned
 * as `false` and left for the caller to log.
 */
export const raiseAllegroAlert = async (
  container: MedusaContainer,
  input: BuildAllegroAlertInput,
): Promise<boolean> => {
  try {
    const notifications = container.resolve(Modules.NOTIFICATION) as NotificationModuleLike;
    await notifications.createNotifications(buildAllegroAlert(input));
    return true;
  } catch {
    // Swallow: see the doc comment. Best-effort, never fatal to the caller.
    return false;
  }
};
