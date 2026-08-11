import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds `sku-mismatch` to the `allegro_offer.conflict` codes.
 *
 * The mapping row both authorises a quantity write and says which variant the quantity
 * comes from. The stock loop is the only place those are compared against the LIVE offer,
 * and a seller editing a sygnatura between discovery and the push makes them disagree.
 * Re-pairing on the live value is how one product's quantity lands on another product's
 * listing, so the disagreement needs a durable, operator-visible code of its own rather
 * than a counter that vanishes with the next run.
 *
 * The column is a text column with an inline CHECK, so Postgres named the constraint
 * `allegro_offer_conflict_check`. Widening a CHECK means dropping and re-adding it.
 */
export class Migration20260811170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_offer" drop constraint if exists "allegro_offer_conflict_check";`,
    );
    this.addSql(
      `alter table if exists "allegro_offer" add constraint "allegro_offer_conflict_check" check ("conflict" in ('missing-external-id', 'duplicate-sku', 'no-variant', 'no-offer', 'sku-mismatch'));`,
    );
  }

  override async down(): Promise<void> {
    // Rows carrying the code being removed have to go somewhere first, or re-adding the
    // narrower constraint fails. They are cleared rather than remapped: the conflict is
    // re-derived on the next stock run, and inventing a different code would misreport
    // what is wrong with the offer.
    this.addSql(
      `update "allegro_offer" set "conflict" = null, "conflict_detail" = null where "conflict" = 'sku-mismatch';`,
    );
    this.addSql(
      `alter table if exists "allegro_offer" drop constraint if exists "allegro_offer_conflict_check";`,
    );
    this.addSql(
      `alter table if exists "allegro_offer" add constraint "allegro_offer_conflict_check" check ("conflict" in ('missing-external-id', 'duplicate-sku', 'no-variant', 'no-offer'));`,
    );
  }
}
