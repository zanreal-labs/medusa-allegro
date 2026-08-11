import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { summarizeOrdersSync } from "../lib/sync/order-events";
import { drainAllegroOrders } from "../workflows/drain-allegro-orders";

const JOB_NAME = "allegro-orders-sync";

/**
 * The per-minute order event drain.
 *
 * Per minute because a `BOUGHT` event that has not been applied is an order nobody
 * has been told about - no picking, no packing, no digital delivery. An idle minute
 * costs one journal request and writes nothing, so the cadence is cheap; a busy one
 * costs one journal request plus a bounded number of order refreshes.
 */
export default async function allegroOrdersSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const result = await drainAllegroOrders(container);
  if (result.skipped) {
    logger.info(`[${JOB_NAME}] skipped: ${result.skipped}`);
    return;
  }

  // The shared summary line, so the job log and the admin say the same thing. Every
  // counter is present including the zeroes: "the journal was quiet", "the journal
  // returned events it could not parse" and "an order was skipped" are three
  // different diagnoses that a bare order count renders identically.
  logger.info(
    `[${JOB_NAME}] ${summarizeOrdersSync(result)} - created: ${result.created}${
      result.withLineConflicts > 0 ? `, lineConflicts: ${result.withLineConflicts}` : ""
    }`,
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
   */
  schedule: process.env.ALLEGRO_ORDERS_SYNC_CRON ?? "* * * * *",
};
