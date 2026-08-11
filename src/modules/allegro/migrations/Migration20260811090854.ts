import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260811090854 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "allegro_sync_state" drop constraint if exists "allegro_sync_state_provider_unique";`);
    this.addSql(`alter table if exists "allegro_offer" drop constraint if exists "allegro_offer_sku_unique";`);
    this.addSql(`alter table if exists "allegro_category_rate" drop constraint if exists "allegro_category_rate_category_id_unique";`);
    this.addSql(`create table if not exists "allegro_auth" ("id" text not null, "access_token_encrypted" text not null, "account_login" text null, "connected_at" timestamptz not null, "expires_at" timestamptz not null, "refresh_token_encrypted" text null, "scope" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_auth_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_auth_deleted_at" ON "allegro_auth" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allegro_category_rate" ("id" text not null, "category_id" text not null, "commission_rate" numeric null, "name" text null, "promoted_commission_rate" numeric null, "raw_commission_rate" jsonb null, "raw_promoted_commission_rate" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_category_rate_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_allegro_category_rate_category_id_unique" ON "allegro_category_rate" ("category_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_category_rate_deleted_at" ON "allegro_category_rate" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allegro_offer" ("id" text not null, "category_id" text null, "last_error" text null, "name" text null, "offer_id" text null, "price_amount" text null, "price_currency" text null, "price_sync_enabled" boolean not null default true, "price_synced_at" timestamptz null, "promoted" boolean not null default false, "sku" text not null, "status" text null, "stock_synced_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_offer_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_offer_offer_id" ON "allegro_offer" ("offer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_allegro_offer_sku_unique" ON "allegro_offer" ("sku") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_offer_deleted_at" ON "allegro_offer" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allegro_price_push" ("id" text not null, "allegro_command_id" text null, "bound_ceiling" text null, "bound_floor" text null, "error" text null, "offer_id" text null, "price_mode_new" text null, "price_mode_old" text null, "promotion_state" text null, "pushed_at" timestamptz not null, "pushed_by" text null, "result" text check ("result" in ('observed', 'success', 'failed', 'skipped')) not null, "rule_id_new" text null, "rule_id_old" text null, "rule_name_new" text null, "rule_name_old" text null, "sku" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_price_push_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_price_push_sku" ON "allegro_price_push" ("sku") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_price_push_deleted_at" ON "allegro_price_push" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allegro_sync_state" ("id" text not null, "cursor" text null, "failures" jsonb null, "last_error" text null, "last_synced_at" timestamptz null, "provider" text not null, "status" text check ("status" in ('idle', 'running', 'ok', 'error')) not null default 'idle', "write_scope_missing" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_sync_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_allegro_sync_state_provider_unique" ON "allegro_sync_state" ("provider") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_sync_state_deleted_at" ON "allegro_sync_state" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "allegro_auth" cascade;`);

    this.addSql(`drop table if exists "allegro_category_rate" cascade;`);

    this.addSql(`drop table if exists "allegro_offer" cascade;`);

    this.addSql(`drop table if exists "allegro_price_push" cascade;`);

    this.addSql(`drop table if exists "allegro_sync_state" cascade;`);
  }

}
