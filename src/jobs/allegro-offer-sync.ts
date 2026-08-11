import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { runOfferDiscovery } from "../workflows/discover-allegro-offers";
import { runPriceAutomationMonitor } from "../workflows/run-price-automation-monitor";
import { syncAllegroPrices } from "../workflows/sync-allegro-prices";

const JOB_NAME = "allegro-offer-sync";

/**
 * The hourly Allegro catalogue pass.
 *
 * Runs the loops that all need the same input - a complete listing of the seller's
 * offers - one after another, off a single listing:
 *
 * 1. **Offer discovery** reconciles the SKU-to-offer mapping, sweeps promotion
 *    state, and discovers categories. Read-only against Allegro.
 * 2. **The price-automation monitor** records what each offer's pricing actually
 *    looks like, and its drift. Also read-only.
 * 3. **Price sync** attaches rules and asserts bounds. The only writer here, and
 *    the only stage with a kill switch.
 *
 * They are separate workflows with separate `allegro_sync_state` rows, separate
 * single-flight claims and separate kill switches, so each is independently
 * observable and independently runnable from the admin. This job only chains them,
 * and the reason it chains rather than scheduling three crons is the listing:
 * paging a full catalogue is the expensive part of all three, and doing it three
 * times an hour is how a well-behaved integration earns a rate limit.
 *
 * The order matters. Discovery establishes which offer owns which SKU and which
 * mappings are conflicted, and price sync refuses to write to anything conflicted -
 * so running price sync against a stale mapping is exactly the case where a command
 * lands on the wrong offer. The monitor runs in between so the observed state the
 * admin shows is the state price sync then acted on.
 *
 * Discovery skipping aborts the chain: nothing downstream can run against a mapping
 * it has no reason to trust. The later stages are individually guarded, so one of
 * them skipping (kill switch, claim held) does not stop the other.
 */
export default async function allegroOfferSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const discovery = await runOfferDiscovery(container);
  if (discovery.result.skipped) {
    logger.info(`[${JOB_NAME}] offer discovery skipped: ${discovery.result.skipped}`);
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

  // The listing discovery already verified is passed through, so neither of the
  // stages below pages the catalogue again.
  const monitor = await runPriceAutomationMonitor(container, discovery.listing);
  if (monitor.skipped) {
    logger.info(`[${JOB_NAME}] price-automation monitor skipped: ${monitor.skipped}`);
  } else {
    logger.info(
      `[${JOB_NAME}] monitor: scanned=${monitor.scanned} drift=${monitor.drift} ` +
        `updated=${monitor.updated} transitions=${monitor.transitions} ` +
        `notObserved=${monitor.notObserved} ` +
        // Logged beside `drift` on purpose: an unresolved promotion state means drift
        // was NOT judged for that offer, so `drift=0` alone would misread as clean.
        `promotionUnresolved=${monitor.promotionUnresolved}`,
    );
    if (monitor.error) {
      logger.warn(`[${JOB_NAME}] monitor finished with findings: ${monitor.error}`);
    }
  }

  const prices = await syncAllegroPrices(container, discovery.listing);
  if (prices.skipped) {
    logger.info(`[${JOB_NAME}] price sync skipped: ${prices.skipped}`);
    return;
  }
  logger.info(
    `[${JOB_NAME}] prices: scanned=${prices.scanned} synced=${prices.synced} ` +
      `alreadyInSync=${prices.alreadyInSync} pending=${prices.pending} failed=${prices.failed} ` +
      `capped=${prices.capped} conflicted=${prices.conflicted}`,
  );
  if (prices.error) {
    logger.warn(`[${JOB_NAME}] price sync finished with findings: ${prices.error}`);
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
