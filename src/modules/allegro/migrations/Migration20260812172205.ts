import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Creates `allegro_settings`, the one-row store of live, operator-flippable runtime
 * toggles that arms or disarms each writer without a redeploy.
 *
 * Every WRITER column defaults `false` (off), so a store that upgrades into this
 * migration publishes nothing to Allegro until an operator arms each writer from the
 * admin - the deliberate, safe fresh-install posture. `invoice_attach_enabled` is the
 * one column defaulting `true`, because by the time an invoice event lands the document
 * already exists as a legal record and delivering it is the safe default; it is
 * enabled-but-inert until an invoicing module is wired.
 *
 * The columns are `NOT NULL` with defaults, which is safe precisely because this is a
 * brand-new table with no existing rows to backfill. The row itself is created lazily
 * by the service under a fixed primary key, so this migration only shapes the table.
 */
export class Migration20260812172205 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "allegro_settings" ("id" text not null, "fulfillment_writeback_enabled" boolean not null default false, "invoice_attach_enabled" boolean not null default true, "orders_sync_enabled" boolean not null default false, "price_sync_enabled" boolean not null default false, "stock_sync_enabled" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_settings_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_allegro_settings_deleted_at" ON "allegro_settings" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "allegro_settings" cascade;`);
  }
}
