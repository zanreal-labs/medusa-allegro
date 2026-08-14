import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds the pricing mode, and the audit columns the fixed-price mode needs.
 *
 * `allegro_settings.pricing_mode` is the persisted answer to "how does this store
 * price its Allegro offers" - `monitor`, `automation_rule` or `fixed_price`. It
 * was not a setting at all before: the plugin could only attach an Allegro
 * price-automation rule, and that assumption was baked into the code rather than
 * chosen by the operator.
 *
 * `allegro_price_push.price_amount` / `price_currency` record the exact Buy Now
 * price a fixed-price push sent. They are separate columns rather than a reuse of
 * `bound_floor` / `bound_ceiling` on purpose: those two are the only memory of the
 * price RANGE attached to an automation rule, and a fixed price written into them
 * would be read back as a range that was never attached.
 *
 * Nullable with NO default, like every configuration column this plugin has
 * shipped: `null` means "nothing persisted, fall back to the `medusa-config.ts`
 * option", which itself defaults to `automation_rule`. An existing store upgrading
 * into this migration therefore keeps behaving exactly as it did - it does not
 * silently stop writing, and it does not silently start writing a different kind
 * of price.
 */
export class Migration20260814104615 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_price_push" add column if not exists "price_amount" text null, add column if not exists "price_currency" text null;`,
    );

    this.addSql(
      `alter table if exists "allegro_settings" add column if not exists "pricing_mode" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_price_push" drop column if exists "price_amount", drop column if exists "price_currency";`,
    );

    this.addSql(
      `alter table if exists "allegro_settings" drop column if exists "pricing_mode";`,
    );
  }
}
