import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Splits findings out of failures on `allegro_sync_state`, and gives a
 * deliberately-off loop a status of its own.
 *
 * `last_error` carried three different things: a kill switch's reason, a
 * catalogue condition an operator should look at, and a run that actually
 * broke. All three then showed as `status = 'error'`. An operator who has
 * learned that a red row usually means nothing is wrong has lost the signal -
 * and that is the state this store was in on the day its live writers were
 * armed.
 *
 * `last_finding` takes the middle case. `disabled` takes the first, and is not
 * folded into `idle` because "off on purpose" and "never ran" are different
 * answers to why a loop is doing nothing.
 *
 * The backfill below is the point of doing this in a migration rather than
 * letting the next run sort it out: the rows carrying the misleading state are
 * exactly the ones an operator is looking at right now, and a loop that only
 * ticks hourly would leave them red until it happens to run.
 */
export class Migration20260817120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_sync_state" add column if not exists "last_finding" text null;`,
    );
    this.addSql(
      `alter table if exists "allegro_sync_state" drop constraint if exists "allegro_sync_state_status_check";`,
    );
    this.addSql(
      `alter table if exists "allegro_sync_state" add constraint "allegro_sync_state_status_check" check ("status" in ('idle', 'running', 'ok', 'error', 'disabled'));`,
    );

    // A row parked as `idle` while carrying a kill-switch reason is the disabled
    // case, verbatim: `runUnderSyncClaim` wrote exactly that shape. Matching on
    // the text is safe because it is this plugin's own sentence, and the state it
    // describes is one the next run re-asserts anyway.
    this.addSql(
      `update "allegro_sync_state"
          set "status" = 'disabled', "last_finding" = "last_error", "last_error" = null
        where "status" = 'idle' and "last_error" like '% sync is disabled %';`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `update "allegro_sync_state"
          set "status" = 'idle', "last_error" = coalesce("last_error", "last_finding")
        where "status" = 'disabled';`,
    );
    this.addSql(
      `alter table if exists "allegro_sync_state" drop constraint if exists "allegro_sync_state_status_check";`,
    );
    this.addSql(
      `alter table if exists "allegro_sync_state" add constraint "allegro_sync_state_status_check" check ("status" in ('idle', 'running', 'ok', 'error'));`,
    );
    this.addSql(
      `alter table if exists "allegro_sync_state" drop column if exists "last_finding";`,
    );
  }
}
