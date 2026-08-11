import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds `conflict` / `conflict_detail` to `allegro_order`, for total reconciliation.
 *
 * Nothing compared the Medusa order's total against the `totalToPay` Allegro recorded for
 * the form, so an order could silently disagree with the money the buyer actually paid.
 * That mattered most before the checkout-form reader stopped fabricating missing prices and
 * quantities, but the class of problem survives it: a rounding difference, a delivery cost
 * modelled differently, or a line carried as a custom item all move the total.
 *
 * Recorded rather than enforced, deliberately. A mismatch never blocks or rolls back the
 * order - the sale happened on Allegro whatever Medusa's arithmetic says, and an invisible
 * order is not a safer outcome than a visibly disputed one - so this is a report for a human
 * to judge, exactly like `line_conflicts`.
 *
 * Both columns are nullable with no default: an existing row simply has no recorded
 * conflict, which is the correct reading until the next pass reconciles it.
 */
export class Migration20260811190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_order" add column if not exists "conflict" text check ("conflict" in ('total-mismatch')) null, add column if not exists "conflict_detail" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_order" drop column if exists "conflict", drop column if exists "conflict_detail";`,
    );
  }
}
