import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260811121043 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "allegro_order" drop constraint if exists "allegro_order_checkout_form_id_unique";`);
    this.addSql(`create table if not exists "allegro_order" ("id" text not null, "allegro_status" text null, "buyer_login" text null, "checkout_form_id" text not null, "currency" text null, "derived_status" text check ("derived_status" in ('pending', 'new', 'processing', 'ready_for_shipment', 'sent', 'delivered', 'returned', 'cancelled')) null, "fulfillment_status" text null, "last_error" text null, "last_event_at" timestamptz null, "line_conflicts" jsonb null, "medusa_order_id" text null, "synced_at" timestamptz null, "total_to_pay" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_order_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_allegro_order_checkout_form_id_unique" ON "allegro_order" ("checkout_form_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_order_medusa_order_id" ON "allegro_order" ("medusa_order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_order_deleted_at" ON "allegro_order" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "allegro_offer" add column if not exists "automation_rule" text null, add column if not exists "automation_rule_id" text null, add column if not exists "automation_synced_at" timestamptz null, add column if not exists "available_quantity" integer null, add column if not exists "conflict" text check ("conflict" in ('missing-external-id', 'duplicate-sku', 'no-variant', 'no-offer')) null, add column if not exists "conflict_detail" text null, add column if not exists "ean" text null, add column if not exists "price_automation_drift" boolean not null default false, add column if not exists "price_mode" text check ("price_mode" in ('automated', 'fixed', 'paused', 'ended', 'unknown')) not null default 'unknown', add column if not exists "variant_id" text null;`);

    this.addSql(`alter table if exists "allegro_sync_state" add column if not exists "counts" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "allegro_order" cascade;`);

    this.addSql(`alter table if exists "allegro_offer" drop column if exists "automation_rule", drop column if exists "automation_rule_id", drop column if exists "automation_synced_at", drop column if exists "available_quantity", drop column if exists "conflict", drop column if exists "conflict_detail", drop column if exists "ean", drop column if exists "price_automation_drift", drop column if exists "price_mode", drop column if exists "variant_id";`);

    this.addSql(`alter table if exists "allegro_sync_state" drop column if exists "counts";`);
  }

}
