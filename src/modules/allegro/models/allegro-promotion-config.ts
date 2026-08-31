import { model } from "@medusajs/framework/utils";

/**
 * The Allegro-specific execution config for a native Medusa promotion.
 *
 * This is an EXTENSION of the promotion, not a competing promotions concept. The
 * promotion itself - its targets, its discount, its campaign window, its sales
 * channels - lives entirely in the native module and is the single source of
 * truth the storefront also honours; this row carries only the two things that
 * have no native home:
 *
 * - `discount_base` selects which of the two per-offer mechanisms the overlay
 *   would use. It is nullable on purpose: an unset base is preview-only and NOT
 *   armable, so nothing silently picks a mechanism. `competitor` -> switch the
 *   targeted offers onto a promotional price-automation rule that carries the
 *   reduction (competitor-relative, clamped to `[break-even, SRP]`); `srp` ->
 *   detach the rule and set a fixed `SRP - discount` Buy Now price (clamped at
 *   break-even). Revert is a rule switch / re-attach in both cases.
 * - `enabled` arms the overlay for this promotion. Defaults OFF like every other
 *   writer in this plugin, so linking a config never itself causes a write; the
 *   overlay that reads it is held until the preview has been seen against real
 *   data, and this column exists so arming later needs no migration.
 *
 * The association to the promotion is a module LINK (`src/links`), so there is no
 * `promotion_id` column here - the link owns the relationship and keeps the two
 * modules isolated. The row is looked up by traversing the link from the
 * promotion.
 */
const AllegroPromotionConfig = model.define("allegro_promotion_config", {
  /**
   * Which per-offer mechanism the overlay would use, or NULL for "not chosen".
   * NULL is preview-only: the promotion cannot be armed until a base is set, so no
   * mechanism is ever selected by default.
   *
   * Plain text rather than a DB enum on purpose: the two allowed values (`srp`,
   * `competitor`) are validated in the write route against `DISCOUNT_BASES`, and a
   * text column keeps the hand-written migration and ORM snapshot free of the
   * check-constraint drift a `db:generate` would otherwise have to reconcile.
   */
  discount_base: model.text().nullable(),
  /** Arms the overlay for this promotion. Defaults OFF; the overlay is held regardless. */
  enabled: model.boolean().default(false),
  id: model.id({ prefix: "algpromo" }).primaryKey(),
});

export default AllegroPromotionConfig;
