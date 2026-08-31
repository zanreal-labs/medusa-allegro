import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { describeError } from "../lib/allegro/errors";
import {
  readSupplierStockChanged,
  SUPPLIER_STOCK_CHANGED_EVENT,
} from "../lib/sync/supplier-stock";
import { enqueueStockPush } from "../workflows/lib/stock-push-queue";

/**
 * Push a quantity to Allegro when the SUPPLIER's stock moves, not just when we sell.
 *
 * ## The gap this closes
 *
 * The sibling subscriber (`allegro-stock-dirty`) reacts to our own order and
 * reservation lifecycle, which covers every way WE consume stock. It cannot see the
 * other direction: stock we resell can change without anybody buying anything here -
 * a different reseller takes the last key, or the supplier restocks. No Medusa event
 * fires for that, because from Medusa's point of view nothing happened.
 *
 * What does happen is that the supplier plugin's snapshot moves a quantity into
 * Medusa inventory on its own schedule, and it now says so. Without this subscriber
 * that change waited for the 15-minute stock reconciliation to notice it, so a
 * supplier stock-out took the supplier sync's cadence PLUS ours to reach the buyer.
 * In that window Allegro is advertising something nobody can supply, and the sale
 * fails at fulfilment as a licence purchase that cannot be satisfied - the most
 * expensive place for it to fail, because the buyer has already paid.
 *
 * ## Why it is the same queue
 *
 * `enqueueStockPush` is the queue the sale path uses, which means the same debounce,
 * the same coalescing, the same STOCK single-flight claim, the same kill switch and
 * the same plan-safety refusal. That is deliberate and it is the whole design rule
 * here: two ways to write a quantity to Allegro would drift, and the one that drifted
 * would be the one nobody watches.
 *
 * It also makes the two sources compose for free. A supplier restock landing in the
 * same window as a sale of the same SKU produces ONE push carrying that SKU once,
 * reading the quantity after both have been applied - rather than two commands racing
 * each other with two different answers.
 *
 * ## The contract, and why nothing is imported
 *
 * An event name and a payload. This plugin does not import the supplier plugin and
 * must not: a store can sell on Allegro without reselling licences, and resell
 * licences without selling on Allegro, so a hard dependency either way would make
 * each unusable without the other. Exactly the arrangement the invoice chain uses.
 * With no supplier plugin installed the subscriber is simply never called.
 *
 * ## The event is a hint, never a quantity
 *
 * The payload names SKUs; it does not carry numbers, and this subscriber would ignore
 * them if it did. The push re-reads Medusa's available quantity and Allegro's offer
 * for itself, so a stale or malformed announcement can make the push redundant but
 * never wrong. That is what lets the payload be read this loosely.
 */
export default async function allegroSupplierStockSubscriber({
  container,
  event,
}: SubscriberArgs<{ skus?: unknown }>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  try {
    const read = readSupplierStockChanged(event.data);
    if (!read.ok) {
      // Logged rather than thrown. The payload crosses a version boundary between two
      // separately-installable plugins, so a shape this one does not recognise is a
      // compatibility problem to read about, not a reason to fail somebody else's
      // supplier sync - and a throwing subscriber would be retried with the same
      // payload until its budget ran out, with the reason reaching nobody.
      logger.warn(
        `[allegro-stock] ignoring ${SUPPLIER_STOCK_CHANGED_EVENT}: ${read.skip}. No quantity was pushed; the scheduled reconciliation still covers it.`,
      );
      return;
    }
    if (read.truncated) {
      // Never silent: the SKUs past the cap keep a stale quantity on Allegro until the
      // next reconciliation, and an operator seeing this repeatedly is looking at a
      // supplier feed that re-derives its whole catalogue rather than at real changes.
      logger.warn(
        `[allegro-stock] ${SUPPLIER_STOCK_CHANGED_EVENT} named more than ${read.skus.length} SKU(s); ${read.truncated} were not queued for an immediate push and are left to the scheduled reconciliation.`,
      );
    }
    logger.info(
      `[allegro-stock] supplier reported ${read.skus.length} changed SKU(s); queueing an immediate Allegro quantity push.`,
    );
    enqueueStockPush(container, read.skus);
  } catch (error) {
    logger.warn(
      `[allegro-stock] could not queue a push for ${event.name}: ${describeError(error)}. The scheduled reconciliation still covers it.`,
    );
  }
}

export const config: SubscriberConfig = {
  event: SUPPLIER_STOCK_CHANGED_EVENT,
};
