import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260831125449 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "allegro_promotion_config" ("id" text not null, "discount_base" text null, "enabled" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allegro_promotion_config_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allegro_promotion_config_deleted_at" ON "allegro_promotion_config" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "allegro_promotion_config" cascade;`);
  }

}
