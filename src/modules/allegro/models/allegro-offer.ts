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
  /** Resolved name of the attached price-automation rule. Monitor-owned. */
  automation_rule: model.text().nullable(),
  /**
   * Attached rule id, verbatim from `sellingMode.priceAutomation.rule.id`. The
   * id is what Allegro exposes per offer; the name above is resolved from the
   * account's rules list, because Allegro removed the rule type from several
   * read resources in July 2025.
   */
  automation_rule_id: model.text().nullable(),
  /** When the monitor last observed this offer's automation state. */
  automation_synced_at: model.dateTime().nullable(),
  /**
   * Last observed `stock.available` on the offer. The stock planner compares it
   * against Medusa's available quantity, so keeping the observation lets the
   * admin show what Allegro currently believes without a round trip.
   */
  available_quantity: model.number().nullable(),
  /** Allegro leaf category id; the key into `allegro_category_rate`. */
  category_id: model.text().nullable(),
  /**
   * The mapping problem this row has, when it has one. Null is the healthy
   * state; the four values are the only ways a SKU-keyed mapping can go wrong,
   * and each one needs a human rather than a retry:
   *
   * - `missing-external-id` - a live offer carries no sygnatura at all, so
   *   nothing can map it. Recorded against the EAN or offer id it was found by.
   * - `duplicate-sku` - two or more live offers claim the same sygnatura. Which
   *   one owns the SKU is not a decision this plugin may take: pushing a price
   *   or a quantity to the wrong one is a real mispricing or an oversell.
   * - `no-variant` - the sygnatura matches no Medusa variant in the configured
   *   sales channel. Either the SKU is wrong on Allegro, or the product is not
   *   published to the channel.
   * - `no-offer` - a stored mapping whose offer has disappeared from the live
   *   listing, so `offer_id` was cleared.
   *
   * A conflicted row is held out of every write path. Counting them is not
   * enough: the offer stays visibly broken in the admin until it is resolved.
   */
  conflict: model
    .enum(["missing-external-id", "duplicate-sku", "no-variant", "no-offer"])
    .nullable(),
  /** Human-readable detail for `conflict`, e.g. the competing offer ids. */
  conflict_detail: model.text().nullable(),
  /** EAN as reported by Allegro; the fallback match when a sygnatura is absent. */
  ean: model.text().nullable(),
  id: model.id({ prefix: "algoffer" }).primaryKey(),
  /** Last error seen for this offer, cleared on the next success. */
  last_error: model.text().nullable(),
  /** Offer title as shown on Allegro. Display-only. */
  name: model.text().nullable(),
  /** Resolved Allegro offer id. Null until discovery matches the SKU. */
  offer_id: model.text().index().nullable(),
  /** Offer price amount, verbatim from Allegro (decimal string). */
  price_amount: model.text().nullable(),
  /**
   * True when the observed automation state differs from what the configured
   * rules say it should be - the attached rule's name does not match the rule
   * expected for the offer's promotion state, or an active offer carries no rule
   * at all. Monitor-owned, and the read-only signal that a promotion flip
   * happened before any write path acts on it.
   */
  price_automation_drift: model.boolean().default(false),
  /** ISO currency of `price_amount`, verbatim from Allegro. */
  price_currency: model.text().nullable(),
  /**
   * How the offer prices right now, as observed: `automated` (a rule is
   * attached), `fixed` (active, no rule), `paused`, `ended` (not ACTIVE), or
   * `unknown` (not observed this run).
   */
  price_mode: model.enum(["automated", "fixed", "paused", "ended", "unknown"]).default("unknown"),
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
  /**
   * Cached id of the Medusa variant that currently carries `sku`.
   *
   * A cache, exactly like `offer_id`: the SKU owns the mapping, and this column
   * is re-resolved from it on every discovery run. A variant that is deleted and
   * recreated under the same SKU leaves this stale for one run, never orphaned.
   */
  variant_id: model.text().nullable(),
});

export default AllegroOffer;
