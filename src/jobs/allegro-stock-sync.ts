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
 * Reconciliation-first, which is why it needs no event subscriber to be correct.
 * Medusa's inventory events are not a reliable trigger (see the plugin README and
 * medusa#11691), so the design does not depend on them: every run reads the whole
 * eligible catalogue's available quantity and compares it against Allegro, so a
 * missed event costs at most one cycle of staleness rather than a permanently wrong
 * quantity.
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
      `complete=${result.complete}`,
  );
  if (result.error) {
    logger.warn(`[${JOB_NAME}] finished with findings: ${result.error}`);
  }
}

export const config = {
  name: JOB_NAME,
  /**
   * Env var rather than a plugin option: Medusa evaluates `config.schedule` at
   * plugin-load time, before the DI container exists. See the offer-sync job.
   *
   * Every 15 minutes by default. Fast enough that a sold-out item stops being
   * purchasable within a quarter of an hour, slow enough that a full catalogue
   * listing plus an inventory read per variant is not a constant load.
   */
  schedule: process.env.ALLEGRO_STOCK_SYNC_CRON ?? "*/15 * * * *",
};
