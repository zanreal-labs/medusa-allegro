import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { INVOICE_ISSUED_EVENT, isSkipped, readInvoiceIssued } from "../lib/sync/invoice-attach";
import { attachAllegroInvoice } from "../workflows/attach-allegro-invoice";

/**
 * Attach an invoice to its Allegro order as soon as the invoice is issued.
 *
 * Listens for `infakt.invoice.issued`, which the invoicing module emits once the
 * document exists (and, for a B2B sale, once it is filed to KSeF). Neither plugin
 * imports the other: the event name and its payload are the whole contract, and the
 * payload is read defensively because it crosses a version boundary.
 *
 * That emitter persists an `event_emitted_at` marker so a crash between the invoice
 * landing and the row completing cannot emit twice - written for this consumer, since a
 * second event would otherwise mean a second attach. This subscriber does not lean on
 * it: an at-least-once bus is the assumption, so `invoice_attached_at` and the
 * dedupe-by-invoice-number read make a redelivered event a no-op anyway.
 *
 * It never throws. Two reasons, and they point the same way:
 *
 * - The invoice already exists as a legal document. Failing the subscriber cannot undo
 *   that, and a retried subscriber failing the same way just buries the reason. The
 *   `allegro_order` row records it instead, and the sweep in the orders job retries it.
 * - A malformed payload is not fixed by retrying. It is logged with what was missing and
 *   dropped, because the same payload will be malformed on every redelivery.
 */
export default async function allegroInvoiceAttachSubscriber({
  container,
  event,
}: SubscriberArgs<unknown>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const read = readInvoiceIssued(event.data);
  if (isSkipped(read)) {
    // Logged, not thrown, and logged even for the benign `pdf_available: false` case:
    // "the invoice is not on the Allegro order" is the same observable state whichever
    // of these it was, so the reason has to be somewhere.
    logger.warn(
      `[allegro-invoice] ignoring ${INVOICE_ISSUED_EVENT}: ${read.skip}. Nothing was attached.`,
    );
    return;
  }

  try {
    await attachAllegroInvoice(container, read);
  } catch (error) {
    // Belt and braces: `attachAllegroInvoice` contains its own failures and records them
    // on the row, so reaching here means something unexpected - a container resolve, a
    // database outage. Still swallowed, for the reasons above.
    logger.error(
      `[allegro-invoice] subscriber failed for order ${read.orderId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const config: SubscriberConfig = {
  event: INVOICE_ISSUED_EVENT,
};
