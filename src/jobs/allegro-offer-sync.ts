import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { runOfferDiscovery } from "../workflows/discover-allegro-offers";

const JOB_NAME = "allegro-offer-sync";

/**
 * The hourly Allegro catalogue pass.
 *
 * Runs the loops that all need the same input - a complete listing of the seller's
 * offers - one after another, off a single listing:
 *
 * 1. **Offer discovery** reconciles the SKU-to-offer mapping, sweeps promotion
 *    state, and discovers categories. Read-only against Allegro.
 * 2. (wave 3) the price-automation monitor, then the price-sync write loop.
 *
 * They are separate workflows with separate `allegro_sync_state` rows, separate
 * single-flight claims and separate kill switches, so each is independently
 * observable and independently runnable from the admin. This job only chains them,
 * and the reason it chains rather than scheduling three crons is the listing:
 * paging a full catalogue is the expensive part of all three, and doing it three
 * times an hour is how a well-behaved integration earns a rate limit.
 *
 * Each stage is independently guarded, so a stage that skips (kill switch, claim
 * held, not connected) does not stop the next one - the state rows say what
 * happened.
 */
export default async function allegroOfferSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const discovery = await runOfferDiscovery(container);
  if (discovery.result.skipped) {
    logger.info(`[${JOB_NAME}] offer discovery skipped: ${discovery.result.skipped}`);
    // Nothing downstream can run without a mapping refresh it can trust.
    return;
  }

  const { result } = discovery;
  logger.info(
    `[${JOB_NAME}] discovery: listed=${result.offersListed} matched=${result.matched} ` +
      `created=${result.created} updated=${result.updated} unlinked=${result.unlinked} ` +
      `noSku=${result.skippedNoSku} unmatchedVariants=${result.unmatchedVariants} ` +
      `categories=${result.categoriesCreated}/${result.categoriesSeen}`,
  );
  if (result.error) {
    logger.warn(`[${JOB_NAME}] discovery finished with findings: ${result.error}`);
  }
}

export const config = {
  name: JOB_NAME,
  /**
   * NOTE ON "configurable via option": Medusa evaluates a scheduled job's
   * `config.schedule` at plugin-load time, before the DI container - and therefore
   * this plugin's `options` - exists. There is no way to read a module's resolved
   * options from this static export, so the cron is driven by an env var rather
   * than a plugin option. Same constraint the sibling Marken plugin documents.
   *
   * Hourly at :15 by default, deliberately off the hour: a store that also runs a
   * supplier import on the hour wants its inventory settled before the marketplace
   * mapping is reconciled against it.
   */
  schedule: process.env.ALLEGRO_OFFER_SYNC_CRON ?? "15 * * * *",
};
