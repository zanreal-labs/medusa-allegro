import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds two nullable audit columns to `allegro_price_push`: `promotion_id` and
 * `promotion_discount`.
 *
 * Purely additive, and safe on a table with existing rows precisely because both
 * are nullable with no default - an old row simply reads NULL, which is the honest
 * value: it was not driven by a promotion. `allegro_price_push` is append-only, so
 * these only ever carry the promotion (if any) that caused a NEW row; nothing
 * backfills history.
 *
 * They exist so a promotion-driven rule switch records both which Medusa promotion
 * drove it and what discount the switched-to rule encodes, without collapsing that
 * into `rule_name_new` (which records the rule name, not the reduction it carries).
 * No consumer writes them yet - the promotion overlay that will is held until the
 * read-only preview has been seen against real data.
 */
export class Migration20260831120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_price_push" add column if not exists "promotion_id" text null;`,
    );
    this.addSql(
      `alter table if exists "allegro_price_push" add column if not exists "promotion_discount" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "allegro_price_push" drop column if exists "promotion_id";`);
    this.addSql(
      `alter table if exists "allegro_price_push" drop column if exists "promotion_discount";`,
    );
  }
}
