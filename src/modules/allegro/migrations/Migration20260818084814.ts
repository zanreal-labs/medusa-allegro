import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260818084814 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "allegro_sync_state" drop constraint if exists "allegro_sync_state_status_check";`);

    this.addSql(`alter table if exists "allegro_sync_state" add column if not exists "last_finding" text null;`);
    this.addSql(`alter table if exists "allegro_sync_state" add constraint "allegro_sync_state_status_check" check("status" in ('idle', 'running', 'ok', 'error', 'disabled'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "allegro_sync_state" drop constraint if exists "allegro_sync_state_status_check";`);

    this.addSql(`alter table if exists "allegro_sync_state" drop column if exists "last_finding";`);

    this.addSql(`alter table if exists "allegro_sync_state" add constraint "allegro_sync_state_status_check" check("status" in ('idle', 'running', 'ok', 'error'));`);
  }

}
