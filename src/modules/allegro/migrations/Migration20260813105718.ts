import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds the editable sync-configuration columns to `allegro_settings`: the two
 * automation rule names, the SRP source, the change cap, the marketplace id and
 * the sales-channel scope.
 *
 * These eight fields were `medusa-config.ts` constructor options only, rendered
 * in the admin as inert text - changing one meant editing the config file and
 * redeploying. This migration is what makes them editable-and-persisted, the same
 * shape the runtime toggles already use.
 *
 * Every column is nullable with NO default, unlike the runtime toggles' `NOT
 * NULL DEFAULT false/true`: `null` means "nothing persisted, fall back to the
 * `medusa-config.ts` default", not a fresh-install posture that needs a concrete
 * starting value. An existing store upgrading into this migration therefore keeps
 * behaving exactly as it did before - every column reads back `null`, and
 * `getSyncOptions()` falls all the way through to the same `medusa-config.ts`
 * values it always read.
 */
export class Migration20260813105718 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_settings" add column if not exists "automation_rule_promoted" text null, add column if not exists "automation_rule_standard" text null, add column if not exists "change_cap" integer null, add column if not exists "marketplace_id" text null, add column if not exists "sales_channel_id" text null, add column if not exists "sales_channel_name" text null, add column if not exists "srp_metadata_key" text null, add column if not exists "srp_price_list_id" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_settings" drop column if exists "automation_rule_promoted", drop column if exists "automation_rule_standard", drop column if exists "change_cap", drop column if exists "marketplace_id", drop column if exists "sales_channel_id", drop column if exists "sales_channel_name", drop column if exists "srp_metadata_key", drop column if exists "srp_price_list_id";`,
    );
  }
}
