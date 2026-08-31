import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260831203001 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "allegro_settings" add column if not exists "promotion_overlay_enabled" boolean not null default false;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "allegro_settings" drop column if exists "promotion_overlay_enabled";`);
  }

}
