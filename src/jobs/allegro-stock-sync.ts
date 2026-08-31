import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { pushAllegroStock } from "../workflows/push-allegro-stock";

const JOB_NAME = "allegro-stock-sync";

/**
 * The quantity reconciliation.
 *
 * Its own job rather than a stage of the hourly catalogue pass, for one reason:
 * cadence. Stock moves on every order, and a marketplace quantity that is an hour
 * stale is how an item stays purchasable after it sold out. Prices and mappings do
 * not move on that timescale, so pinning both to the faster cadence would multiply
 * the catalogue listing cost for no benefit.
 *
 * Reconciliation-first, which is why it needs no event subscriber to be CORRECT.
 * Medusa's inventory events are not a reliable trigger (see the plugin README and
 * medusa#11691), so the design does not depend on them: every run reads the whole
 * eligible catalogue's available quantity and compares it against Allegro, so a
 * missed event costs at most one cycle of staleness rather than a permanently wrong
 * quantity.
 *
 * There IS an event path now (`subscribers/allegro-stock-dirty` ->
 * `workflows/lib/stock-push-queue`), and it changes nothing about the above. It makes
 * the common case fast - a sale updates its own SKUs within seconds instead of within
 * the cycle - and this run remains the thing that makes the catalogue right. Anything
 * the events missed, dropped on a restart, or could not read is repaired here, so the
 * guarantee this job provides is exactly what it was before the fast path existed.
 */
export default async function allegroStockSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const result = await pushAllegroStock(container);
  if (result.skipped) {
    logger.info(`[${JOB_NAME}] skipped: ${result.skipped}`);
    return;
  }

  logger.info(
    `[${JOB_NAME}] eligible=${result.eligible} mismatched=${result.mismatched} ` +
      `synced=${result.synced} alreadyInSync=${result.alreadyInSync} ` +
      `commands=${result.commands} pending=${result.pending} failed=${result.failed} ` +
      `ambiguous=${result.ambiguous} unresolved=${result.unresolved} ` +
      `inactive=${result.skippedInactive} unlinked=${result.skippedUnlinked} ` +
      // The bounded exclusions. None refuses the run, so each is the only signal that
      // part of the catalogue had its quantity published nowhere.
      `noInventory=${result.skippedNoInventory} noListingStock=${result.skippedNoListingStock} ` +
      `unmatched=${result.skippedUnmatched} ` +
      `conflicted=${result.conflicted} ` +
      `complete=${result.complete}`,
  );
  // The two halves, reported as what they are. This used to print `result.error`
  // under the label "findings", which was accurate only because that field carried
  // both - the same conflation that let the immediate push page on a normal state.
  if (result.finding) {
    logger.info(`[${JOB_NAME}] findings: ${result.finding}`);
  }
  if (result.error) {
    logger.warn(`[${JOB_NAME}] finished with errors: ${result.error}`);
  }
}

/** The default reconciliation cadence, in milliseconds. */
export const DEFAULT_STOCK_SYNC_INTERVAL_MS = 900_000;

/**
 * Resolve the reconciliation schedule from the environment.
 *
 * Fifteen minutes by default, unchanged: fast enough to bound how long a wrong
 * quantity can persist, slow enough that a full catalogue listing plus an inventory
 * read per variant is not a constant load.
 *
 * What is new is that the cadence is now expressible as an INTERVAL and not only as
 * cron. Medusa's cron resolves to the minute, so cron could express "every 15
 * minutes" and "every minute" and nothing in between or below - and this is the loop
 * whose staleness window is an oversell, so the cadence is a dial an operator may
 * genuinely need to turn during an incident. An interval also spreads the run off the
 * whole-minute boundary that every other cron in the stack fires on.
 *
 * Note the cadence itself is deliberately NOT changed here. The event-driven push
 * (`workflows/lib/stock-push-queue`) is what closes the window in the common case;
 * this loop's job is to be the reconciliation that catches what events miss, and
 * making it run more often is a separate decision with a real request cost, taken with
 * numbers rather than bundled into the plumbing that makes it possible.
 *
 * `ALLEGRO_STOCK_SYNC_CRON`, if set, wins - the two are mutually exclusive in Medusa's
 * scheduler. That also means every store already setting the cron (the shipped
 * `.env.template` does) keeps precisely the behaviour it has today.
 *
 * An env var rather than a plugin option because Medusa evaluates `config.schedule` at
 * plugin-load time, before the DI container - and therefore this plugin's `options` -
 * exists. See the offer-sync job.
 */
export const resolveStockSyncSchedule = (
  env: NodeJS.ProcessEnv = process.env,
): { cron: string } | { interval: number } => {
  const cron = env.ALLEGRO_STOCK_SYNC_CRON?.trim();
  if (cron) {
    return { cron };
  }
  const parsed = Number.parseInt(env.ALLEGRO_STOCK_SYNC_INTERVAL_MS ?? "", 10);
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STOCK_SYNC_INTERVAL_MS;
  return { interval };
};

export const config = {
  name: JOB_NAME,
  schedule: resolveStockSyncSchedule(),
};
