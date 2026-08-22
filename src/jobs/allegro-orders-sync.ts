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
    }${
      // Conditional, unlike the drain counters above: a store that does not invoice
      // through a module never sweeps anything, and a permanent ", invoicesAttached: 0"
      // would be noise on all 1440 ticks of the day.
      result.invoicesAttached > 0 ? `, invoicesAttached: ${result.invoicesAttached}` : ""
    }${
      // The reconciliation's own counters, conditional for the same reason: a healthy
      // store sweeps a handful of open orders and repairs none of them, and a permanent
      // ", reconcileRepaired: 0" on all 4320 ticks of the day is noise. A NON-zero one is
      // the signal that the event journal lost something.
      result.reconciled > 0 ? `, reconciled: ${result.reconciled}` : ""
    }${
      result.reconcileRepaired > 0 ? `, reconcileRepaired: ${result.reconcileRepaired}` : ""
    }${
      result.reconcilePayments > 0 ? `, paymentsRecorded: ${result.reconcilePayments}` : ""
    }`,
  );
  if (result.error) {
    logger.warn(`[${JOB_NAME}] finished with findings: ${result.error}`);
  }
}

/** The default drain cadence, in milliseconds. */
export const DEFAULT_ORDERS_SYNC_INTERVAL_MS = 20_000;

/**
 * Resolve the drain schedule from the environment.
 *
 * Interval-based by default rather than cron. A `BOUGHT` event that has not been
 * applied is an order nobody has been told about, and an interval keeps the gap tight
 * and even without pinning the drain to a whole-minute cron tick - Medusa's cron only
 * resolves to the minute, so ~20s is expressible only as an interval.
 *
 * `ALLEGRO_ORDERS_SYNC_INTERVAL_MS` overrides the default; a non-numeric or
 * non-positive value falls back to it rather than scheduling something nonsensical.
 * `ALLEGRO_ORDERS_SYNC_CRON`, if set, switches back to a cron expression - the two are
 * mutually exclusive in Medusa's scheduler, so a cron wins when both are present.
 *
 * An env var rather than a plugin option because Medusa evaluates `config.schedule` at
 * plugin-load time, before the DI container - and therefore this plugin's `options` -
 * exists. See the offer-sync job.
 */
export const resolveOrdersSyncSchedule = (
  env: NodeJS.ProcessEnv = process.env,
): { cron: string } | { interval: number } => {
  const cron = env.ALLEGRO_ORDERS_SYNC_CRON?.trim();
  if (cron) {
    return { cron };
  }
  const parsed = Number.parseInt(env.ALLEGRO_ORDERS_SYNC_INTERVAL_MS ?? "", 10);
  const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORDERS_SYNC_INTERVAL_MS;
  return { interval };
};

export const config = {
  name: JOB_NAME,
  schedule: resolveOrdersSyncSchedule(),
};
