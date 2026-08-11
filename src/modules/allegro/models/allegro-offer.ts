import { model } from "@medusajs/framework/utils";

/**
 * The mapping between a Medusa variant and an Allegro offer.
 *
 * `sku` is the identity, and it is the only identity. Allegro exposes a
 * seller-controlled field on every offer, `external.id` (called "sygnatura" in
 * the Polish seller panel), and this plugin's contract is that a seller puts the
 * Medusa variant SKU there. Discovery then matches `external.id` against
 * variant SKUs. `offer_id` is a resolved cache of the numeric Allegro offer id:
 * useful for building API calls and links, never the thing a row is keyed by.
 *
 * Why this matters in practice: an offer id changes when a seller re-lists an
 * item, and one SKU can move between offers over an item's life. Keying on the
 * offer id produces silent orphans; keying on the SKU produces a row whose
 * `offer_id` simply needs re-resolving.
 *
 * Money is stored as text, exactly as Allegro returns it. Allegro's API speaks
 * decimal strings ("233.21"), and re-encoding those through a float on the way
 * in and out is how price sync starts pushing 233.20999999999998.
 */
const AllegroOffer = model.define("allegro_offer", {
  /** Allegro leaf category id; the key into `allegro_category_rate`. */
  category_id: model.text().nullable(),
  id: model.id({ prefix: "algoffer" }).primaryKey(),
  /** Last error seen for this offer, cleared on the next success. */
  last_error: model.text().nullable(),
  /** Offer title as shown on Allegro. Display-only. */
  name: model.text().nullable(),
  /** Resolved Allegro offer id. Null until discovery matches the SKU. */
  offer_id: model.text().index().nullable(),
  /** Offer price amount, verbatim from Allegro (decimal string). */
  price_amount: model.text().nullable(),
  /** ISO currency of `price_amount`, verbatim from Allegro. */
  price_currency: model.text().nullable(),
  /** Per-offer opt-out from price sync, independent of the global kill-switch. */
  price_sync_enabled: model.boolean().default(true),
  price_synced_at: model.dateTime().nullable(),
  /**
   * Whether the offer currently carries a promotion package ("Wyróżnienie").
   * Resolved from the promo-options resource, not from the offer body, which
   * does not carry promotion state.
   */
  promoted: model.boolean().default(false),
  /** Medusa variant SKU; matched against the Allegro offer's `external.id`. */
  sku: model.text().unique(),
  /** Allegro publication status: ACTIVE, INACTIVE, ENDED, and so on. */
  status: model.text().nullable(),
  stock_synced_at: model.dateTime().nullable(),
});

export default AllegroOffer;
