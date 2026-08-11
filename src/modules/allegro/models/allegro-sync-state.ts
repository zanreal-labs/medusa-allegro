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
  last_error: model.text().nullable(),
  last_synced_at: model.dateTime().nullable(),
  /** Sync loop label: "offers", "price-automation", "prices", "stock", "orders". */
  provider: model.text().unique(),
  status: model.enum(["idle", "running", "ok", "error"]).default("idle"),
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
