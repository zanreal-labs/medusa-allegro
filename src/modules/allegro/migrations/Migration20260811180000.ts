import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Gives the single-flight claim a fencing token and a heartbeat.
 *
 * The claim was take-once: `updated_at` was bumped when it was acquired and then not again
 * until the run finished. Anything slower than the six-minute staleness window was taken
 * over MID-FLIGHT - the orders drain refreshes up to 100 forms sequentially, the stock loop
 * polls each command for up to 120 seconds, a manual full-catalogue price run is minutes of
 * sequential commands - so two runs then pushed to Allegro concurrently, which is exactly
 * what single-flight exists to prevent.
 *
 * `claim_heartbeat_at` is what a long run bumps to prove it is alive. It is a real column
 * rather than a re-touch of `updated_at` because a heartbeat must write a value that
 * genuinely changes: an update whose fields all already match may not flush, so the ORM's
 * `onUpdate` would never fire and the heartbeat would be a no-op that looked successful.
 *
 * `claim_token` is what makes ownership checkable. Every write a running loop makes is
 * conditioned on it, so a run that HAS been taken over discovers that fact instead of
 * overwriting its successor's state or releasing a claim it no longer holds.
 *
 * Both are nullable with no default: an existing row simply has no live claim, which is the
 * correct reading, and the next claim mints a token.
 */
export class Migration20260811180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_sync_state" add column if not exists "claim_heartbeat_at" timestamptz null, add column if not exists "claim_token" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_sync_state" drop column if exists "claim_heartbeat_at", drop column if exists "claim_token";`,
    );
  }
}
