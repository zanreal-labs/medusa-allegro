import { model } from "@medusajs/framework/utils";

/**
 * The stored Allegro OAuth connection.
 *
 * One row per connected Allegro account. Allegro apps authorize a single seller
 * account, and this plugin is built for that shape, so in practice the table
 * holds exactly one row: connecting replaces whatever was there, disconnecting
 * deletes it. The table is not hard-constrained to one row, so a later wave can
 * add multi-account support without a destructive migration.
 *
 * Both tokens are sealed with AES-256-GCM using the plugin's `encryptionKey`
 * before they are written (see `src/lib/crypto.ts`). The refresh token is a
 * long-lived credential for the seller's entire Allegro account; treat this
 * table as secret material even though the values are encrypted.
 */
const AllegroAuth = model.define("allegro_auth", {
  /** AES-256-GCM envelope of the access token. */
  access_token_encrypted: model.text(),
  /**
   * Allegro login of the connected account, read from `GET /me` right after the
   * code exchange. Display-only: the mapping key for offers is the SKU, never
   * the account.
   */
  account_login: model.text().nullable(),
  /** When the connection was established (or last re-established). */
  connected_at: model.dateTime(),
  /** When the stored access token expires. Refresh kicks in 30s before this. */
  expires_at: model.dateTime(),
  id: model.id({ prefix: "algauth" }).primaryKey(),
  /**
   * AES-256-GCM envelope of the refresh token.
   *
   * Nullable because Allegro's token response types `refresh_token` as
   * optional: an authorization-code grant always returns one, but a row written
   * from any other grant would not have it, and a NOT NULL column would turn
   * that into a write failure instead of a visible "reconnect required" state.
   */
  refresh_token_encrypted: model.text().nullable(),
  /** Space-separated scopes Allegro actually granted, as reported at exchange. */
  scope: model.text().nullable(),
});

export default AllegroAuth;
