import type { Logger } from "@medusajs/framework/types";
import type { AllegroSyncOptions } from "../../modules/allegro/service";

/**
 * Warnings a write loop emits about the SCOPE it is about to write over.
 *
 * Separate from the eligibility ladder on purpose. A skip reason answers "why was
 * this offer left alone?"; these answer "do you realise how much this run covers?",
 * which no per-offer counter can express - the dangerous configuration is one where
 * every offer is eligible and the run reports a clean success.
 */

/**
 * Warn when a writer is armed with no sales channel configured.
 *
 * An unset channel means the WHOLE catalogue is sync-eligible. That is a legitimate
 * default for a store that sells everything on Allegro, and a serious footgun for a
 * store that meant to sell a subset: nothing about the resulting run looks wrong. It
 * writes prices and quantities for every variant carrying a SKU, reports a clean
 * success, and the only symptom is on Allegro.
 *
 * Emitted from the write loops only. Discovery and the monitor cover the whole
 * catalogue harmlessly - they write nothing to Allegro - so warning there would train
 * an operator to ignore the line by the time it matters.
 */
export const warnOnUnscopedCatalogue = (
  logger: Logger,
  options: Pick<AllegroSyncOptions, "salesChannelId" | "salesChannelName">,
  loop: string,
): void => {
  if (options.salesChannelId || options.salesChannelName) {
    return;
  }
  logger.warn(
    `[allegro-${loop}] no sales channel is configured, so EVERY Medusa variant with a SKU is eligible for this write loop. If you meant to sell only part of the catalogue on Allegro, set \`salesChannelId\` (or \`salesChannelName\`) before this runs again - an unscoped run reports a clean success and the only symptom is on Allegro.`,
  );
};
