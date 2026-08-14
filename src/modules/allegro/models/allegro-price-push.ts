import { model } from "@medusajs/framework/utils";

/**
 * Append-only audit trail of price-automation decisions.
 *
 * This table is the ONLY memory of the price range the plugin pushed. Allegro's
 * API does not expose the `[min, max]` range attached to a rule on an offer:
 * you can write `configuration.priceRange` with the rule-assignment command, and
 * you can read back which rule is attached, but the bounds are write-only. So
 * without this table there is no way to answer "what floor is this offer
 * currently pinned to, and who set it" - not from Allegro, not from anywhere.
 *
 * Consequences, worth stating because they are easy to break:
 *
 * - Never update or delete a row. Correcting a mistake means appending the
 *   correction; rewriting history destroys the only bounds record there is.
 * - Rows are written for observations too, not just writes. `result: "observed"`
 *   records a state the plugin saw without touching, which is what makes a
 *   read-only monitoring wave still worth running.
 * - Money is text, exactly as it goes to Allegro. The audit trail has to record
 *   the bytes that were sent, not a re-rendering of them.
 */
const AllegroPricePush = model.define("allegro_price_push", {
  /** The async command id, so a report can be re-fetched from Allegro later. */
  allegro_command_id: model.text().nullable(),
  /** Ceiling pushed as `configuration.priceRange.maxPrice.amount` (decimal string). */
  bound_ceiling: model.text().nullable(),
  /** Floor pushed as `configuration.priceRange.minPrice.amount` (decimal string). */
  bound_floor: model.text().nullable(),
  /** Failure detail, verbatim where possible. */
  error: model.text().nullable(),
  id: model.id({ prefix: "algpush" }).primaryKey(),
  /** Allegro offer id the command targeted, when one was resolved. */
  offer_id: model.text().nullable(),
  /**
   * The exact Buy Now price sent in fixed-price mode (decimal string), and its
   * currency. Null on an automation-rule row, where no price was sent at all -
   * the rule's engine picks the number and this plugin only supplies the range.
   *
   * Separate columns from `bound_floor` / `bound_ceiling` rather than reusing
   * them, because the two are different facts and one of them is load-bearing:
   * `fetchLastSuccessfulBounds` reads the bounds off success rows as the ONLY
   * memory of the price range attached to a rule. A fixed price written into
   * those columns would be read back as a rule range that was never attached, and
   * the offer would then be left alone by a later automation-rule run that should
   * have re-attached it.
   */
  price_amount: model.text().nullable(),
  price_currency: model.text().nullable(),
  price_mode_new: model.text().nullable(),
  /** Pricing mode before and after, e.g. "fixed" or "automation". */
  price_mode_old: model.text().nullable(),
  /** Promotion state at decision time; it selects the commission rate. */
  promotion_state: model.text().nullable(),
  pushed_at: model.dateTime(),
  /**
   * Who caused the row: the Medusa user id for an admin action, or a job name
   * for an automated one. Free-form so a later wave can add actors without a
   * migration.
   */
  pushed_by: model.text().nullable(),
  /**
   * Outcome of the row:
   * - `observed` - the plugin recorded state without writing anything.
   * - `success`  - Allegro accepted the command and it completed.
   * - `failed`   - Allegro rejected it, or the command reported task failures.
   * - `skipped`  - a guard stopped it (kill-switch, per-offer opt-out, no rate).
   */
  result: model.enum(["observed", "success", "failed", "skipped"]),
  /** Rule attached after the change. */
  rule_id_new: model.text().nullable(),
  /** Rule attached before the change. */
  rule_id_old: model.text().nullable(),
  rule_name_new: model.text().nullable(),
  rule_name_old: model.text().nullable(),
  /** The mapped SKU. Indexed: the audit is almost always read per SKU. */
  sku: model.text().index(),
});

export default AllegroPricePush;
