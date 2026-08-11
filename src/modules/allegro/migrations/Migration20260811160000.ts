import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `allegro_offer.promoted` becomes three-state: true / false / NULL-as-unresolved.
 *
 * The column was `boolean not null default false`. That default is what made a real
 * mispricing reachable: promotion state selects the commission rate, the rate sets the
 * break-even price, and the break-even is the FLOOR a price-automation rule may sell
 * down to. A row created by discovery while the promo sweep was unresolved took the
 * default and therefore priced at the STANDARD commission, giving a promoted offer a
 * floor below its true break-even. `evaluateSyncEligibility` already had a
 * `promotion-unresolved` gate for exactly this, but it was unreachable while the column
 * could not be null.
 *
 * Every existing row is set to NULL rather than preserved. The stored booleans cannot be
 * trusted after the fact - there is no way to tell, per row, whether a `false` came from
 * a successful sweep or from the default - and the safe direction is to withhold the
 * write. The next discovery run repopulates from a resolved sweep, and until it does,
 * price sync skips those offers with a counted, visible reason instead of pricing them
 * on a guess.
 */
export class Migration20260811160000 extends Migration {
  override async up(): Promise<void> {
    // Order matters: the NOT NULL has to go before the rows can be nulled.
    this.addSql(`alter table if exists "allegro_offer" alter column "promoted" drop default;`);
    this.addSql(`alter table if exists "allegro_offer" alter column "promoted" drop not null;`);
    this.addSql(`update "allegro_offer" set "promoted" = null;`);
  }

  override async down(): Promise<void> {
    // Reinstating NOT NULL needs a value for the rows that are legitimately NULL, and
    // `false` is the only one the column can take. That is lossy in exactly the way this
    // migration exists to fix, so it is spelled out rather than looking like a clean
    // round trip.
    this.addSql(`update "allegro_offer" set "promoted" = false where "promoted" is null;`);
    this.addSql(`alter table if exists "allegro_offer" alter column "promoted" set default false;`);
    this.addSql(`alter table if exists "allegro_offer" alter column "promoted" set not null;`);
  }
}
