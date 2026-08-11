import { model } from "@medusajs/framework/utils";

/**
 * Allegro sale-commission rates per category, maintained by hand.
 *
 * Allegro does publish a fee calculator, `POST /pricing/offer-fee-preview`, and
 * the SDK wraps it. It is not usable as the source of these numbers in
 * production: the endpoint rejects the offer bodies a seller can actually build
 * from their own live offers, so a sweep over a real catalogue returns errors
 * rather than rates. Until that changes, an operator enters the rates from the
 * published fee table and the plugin treats this table as authoritative.
 *
 * Both rates are nullable on purpose. A category row can exist because an offer
 * referenced it while nobody has filled in the numbers yet, and "unknown" has to
 * stay distinguishable from "zero commission" - a margin calculation that reads
 * a missing rate as 0% quietly turns a loss-making price into an acceptable one.
 *
 * Rates are stored as exact numerics (Medusa's big-number property maps to a
 * Postgres `numeric` column), not floats. Percentages that participate in a
 * price floor must not drift.
 */
const AllegroCategoryRate = model.define("allegro_category_rate", {
  /** Allegro category id. The join key from `allegro_offer.category_id`. */
  category_id: model.text().unique(),
  /** Sale commission for a plain offer, as a percentage (e.g. 9.5 for 9.5%). */
  commission_rate: model.bigNumber().nullable(),
  id: model.id({ prefix: "algcatrate" }).primaryKey(),
  /** Category name, for the admin table. Display-only. */
  name: model.text().nullable(),
  /** Sale commission for a promoted offer, as a percentage. */
  promoted_commission_rate: model.bigNumber().nullable(),
});

export default AllegroCategoryRate;
