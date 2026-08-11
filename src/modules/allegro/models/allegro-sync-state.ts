import { model } from "@medusajs/framework/utils";

/**
 * Health and cursor state, one row per sync provider.
 *
 * `provider` is a plugin-internal label for a distinct sync loop, not an Allegro
 * concept: "offers", "promotions", "price-automation", "orders". Each keeps its
 * own cursor and its own failure record, so one wedged loop does not hide the
 * health of the others.
 *
 * Wave 1 only reads this table (the admin health section). The columns exist now
 * because the shape of the state is what the later waves have to agree on, and
 * changing it once jobs are writing to it is a migration under load.
 */
const AllegroSyncState = model.define("allegro_sync_state", {
  /**
   * Opaque resume point, meaning defined by the provider. For the orders journal
   * it is an Allegro event id; for a paged sweep it is an offset. Text, because
   * the plugin must never interpret another provider's cursor.
   */
  cursor: model.text().nullable(),
  /**
   * Per-item failure bookkeeping: `{ streaks: Record<string, number>,
   * quarantined: string[] }`, keyed by SKU. A SKU that fails repeatedly gets
   * quarantined so one permanently broken item cannot consume a whole run's
   * rate-limit budget on every pass.
   */
  failures: model.json().nullable(),
  id: model.id({ prefix: "algsync" }).primaryKey(),
  last_error: model.text().nullable(),
  last_synced_at: model.dateTime().nullable(),
  /** Sync loop label, e.g. "offers", "promotions", "orders". */
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
