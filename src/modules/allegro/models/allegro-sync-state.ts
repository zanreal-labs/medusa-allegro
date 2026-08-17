import { model } from "@medusajs/framework/utils";

/**
 * Health and cursor state, one row per sync provider.
 *
 * `provider` is a plugin-internal label for a distinct sync loop, not an Allegro
 * concept: "offers", "promotions", "price-automation", "orders". Each keeps its
 * own cursor and its own failure record, so one wedged loop does not hide the
 * health of the others.
 *
 * The row is also the single-flight claim. Every loop claims its own provider row
 * with a conditional update before it does anything, so the scheduled job and an
 * operator pressing "run now" cannot interleave. See
 * `AllegroModuleService.claimSyncRun`.
 */
const AllegroSyncState = model.define("allegro_sync_state", {
  /**
   * When the current claim holder last proved it was alive.
   *
   * A long run has to keep saying so, or the staleness window takes it over mid-flight and
   * two runs push to Allegro concurrently. It exists as a column of its own, rather than
   * relying on `updated_at`, because a heartbeat has to write a value that genuinely
   * CHANGES: an update whose every field already matches may not flush at all, and then the
   * ORM's `onUpdate` would never bump `updated_at` and the heartbeat would be a silent
   * no-op that looked like a success.
   */
  claim_heartbeat_at: model.dateTime().nullable(),
  /**
   * Fencing token for the run that currently holds the claim.
   *
   * Minted on every successful claim. Writes a running loop makes to this row are
   * conditioned on it, which is what turns "I took the claim" into "I still hold it". A run
   * that was taken over as stale finds its token no longer matches, learns it has lost the
   * claim, and stops writing - rather than overwriting the state of the run that replaced
   * it, or releasing a claim it no longer owns.
   */
  claim_token: model.text().nullable(),
  /**
   * The last run's counters, in the provider's own summary shape. Purely for the
   * admin, and worth a column: a run that wrote nothing is only distinguishable
   * from a run that found nothing to write by its skip counts, and a health table
   * reading "ok" with no numbers is exactly how a silently inert loop passes for
   * a healthy one.
   */
  counts: model.json().nullable(),
  /**
   * Opaque resume point, meaning defined by the provider. For the orders journal
   * it is an Allegro event id; for a paged sweep it is an offset. Text, because
   * the plugin must never interpret another provider's cursor.
   */
  cursor: model.text().nullable(),
  /**
   * Per-item failure bookkeeping, as
   * `{ streaks: { <key>: { count, error, since } },
   *    quarantined: { <key>: { error, since } } }`.
   *
   * Keyed by whatever the provider retries: an Allegro offer id for price sync, a
   * checkout-form id for orders. An item that fails repeatedly is quarantined so
   * one permanently broken item cannot consume a whole run's budget on every pass
   * - and, for the orders drain, so it cannot pin the event cursor forever.
   *
   * The two maps are separate on purpose, and the split is load-bearing rather
   * than cosmetic. A quarantined item is never retried automatically, so its
   * entry lives until an operator repairs it. Sharing one capped map with the
   * live streaks meant those permanent entries - the highest counts, therefore
   * the last evicted - would fill the cap and evict every fresh streak at count
   * 1, so a newly broken item could never reach its own quarantine.
   */
  failures: model.json().nullable(),
  id: model.id({ prefix: "algsync" }).primaryKey(),
  /**
   * Why the last run failed. Only ever set when the run did NOT do its job.
   *
   * Kept strictly apart from `last_finding`, because the two used to share this
   * column and the sharing is what made the health table unreadable: a disabled
   * writer, a catalogue whose data an operator should look at, and a loop that
   * genuinely broke all arrived here and all showed as `error`. An operator who
   * has learned that "error" usually means "nothing is wrong" has lost the
   * signal, which is exactly the state to be in before arming live writers.
   */
  last_error: model.text().nullable(),
  /**
   * What the last run wants an operator to know, having otherwise succeeded.
   *
   * Offers that carry no sygnatura, mapping conflicts held out of sync, an
   * unresolved promotion state: real conditions worth surfacing, none of which
   * mean the run failed. They belong beside the counters, not in the failure
   * column.
   */
  last_finding: model.text().nullable(),
  last_synced_at: model.dateTime().nullable(),
  /** Sync loop label: "offers", "price-automation", "prices", "stock", "orders". */
  provider: model.text().unique(),
  /**
   * - `idle` - never run, or reset. No claim held.
   * - `running` - a claim is held right now.
   * - `ok` - the last run did its job. May still carry a `last_finding`.
   * - `error` - the last run failed; `last_error` says how.
   * - `disabled` - a kill switch stopped it before it started. Not a failure,
   *   and deliberately not `idle` either: "off on purpose" and "never ran" are
   *   different answers to "why is this loop doing nothing".
   */
  status: model
    .enum(["idle", "running", "ok", "error", "disabled"])
    .default("idle"),
  /**
   * True when Allegro answered 403 on a write the stored token should have been
   * allowed to make - the signature of a connection granted without
   * `allegro:api:sale:offers:write`. It is a circuit-breaker condition, not a
   * per-item error: the fix is reconnecting with the right scopes, so the run
   * holds and the admin raises a reconnect prompt.
   */
  write_scope_missing: model.boolean().default(false),
});

export default AllegroSyncState;
