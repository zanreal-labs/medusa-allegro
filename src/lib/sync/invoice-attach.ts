import { ALLEGRO_INVOICE_MAX_BYTES } from "../allegro/types";
import type { CheckoutFormInvoice } from "../allegro/types";

/**
 * The decisions the invoice-attach path makes, with no I/O.
 *
 * Attaching an invoice to an Allegro order is a two-call sequence against an API with
 * no idempotency key, driven by an event emitted by a plugin this one does not depend
 * on. Three of those words are where the bugs live, so each gets a pure function here:
 *
 * - **the event is untrusted input.** It arrives over the event bus from another
 *   plugin's version, so a field can be missing, renamed or the wrong type. Reading it
 *   must never throw - a subscriber that throws on a malformed payload gets retried
 *   with the same malformed payload.
 * - **the create has no idempotency key.** Matching an already-registered document by
 *   invoice number is the only thing standing between a retry and a duplicate invoice
 *   on a real order. This is the guard the pipeline this plugin replaces ran in
 *   production.
 * - **the size limit is a precondition, not an error to handle.** Allegro rejects a
 *   file over 3 MB, and by then the document is already registered and counts against
 *   the ten an order allows. So the check happens before anything is created.
 */

/** The event this plugin listens for. Emitted by `@zanreal/medusa-infakt`. */
export const INVOICE_ISSUED_EVENT = "infakt.invoice.issued";

/**
 * Prefix every attach failure recorded on `allegro_order.last_error` carries.
 *
 * `last_error` is shared with the drain, which clears it on its next clean pass of the
 * same form - so the prefix is for a human reading the admin, and deliberately NOT what
 * the retry sweep keys off. The sweep asks the invoicing module what has been issued
 * instead, precisely because this column can be overwritten by an unrelated healthy
 * pass.
 */
export const ATTACH_ERROR_PREFIX = "invoice attach";

/** The one-line failure a row records. */
export const attachErrorLine = (message: string): string => `${ATTACH_ERROR_PREFIX}: ${message}`;

/** What the attach path needs out of an `infakt.invoice.issued` payload. */
export interface InvoiceIssued {
  /** The Medusa order the invoice was issued for. */
  orderId: string;
  /** The invoicing system's own id for the document, used to fetch the PDF. */
  invoiceUuid: string;
  /**
   * The human invoice number, when the emitter knew it.
   *
   * Optional to the emitter, and the dedupe guard is weaker without it: matching an
   * already-registered document is a match on this number, so a payload without one
   * falls back to the uuid and only dedupes against a document this plugin registered.
   */
  invoiceNumber?: string;
}

const readString = (value: unknown): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
};

/**
 * Read an `infakt.invoice.issued` payload, or say why it is unusable.
 *
 * Tolerant on purpose, and the tolerance is asymmetric:
 *
 * - `order_id` and `invoice_uuid` are REQUIRED, because there is no useful action
 *   without them. A payload missing either is reported as a skip reason, never thrown:
 *   the invoice already exists upstream, the event is not replayable into existence,
 *   and a throwing subscriber would simply be retried with the same payload until the
 *   retry budget ran out.
 * - everything else is optional. `invoice_number` missing weakens dedupe but does not
 *   stop the attach, and unknown fields are ignored rather than rejected, so an emitter
 *   that adds one does not break this consumer.
 * - `pdf_available: false` is honoured as "there is nothing to attach yet". Any other
 *   value, including absent, reads as available - the emitter sends `true`, and
 *   treating absence as "no PDF" would make a future emitter that drops the field stop
 *   the chain silently.
 */
export const readInvoiceIssued = (data: unknown): InvoiceIssued | { skip: string } => {
  if (typeof data !== "object" || data === null) {
    return { skip: `payload is ${data === null ? "null" : typeof data}, not an object` };
  }
  const payload = data as Record<string, unknown>;

  const orderId = readString(payload.order_id);
  const invoiceUuid = readString(payload.invoice_uuid);
  const missing = [
    orderId ? undefined : "order_id",
    invoiceUuid ? undefined : "invoice_uuid",
  ].filter((field): field is string => field !== undefined);
  if (missing.length > 0 || !(orderId && invoiceUuid)) {
    return { skip: `payload is missing ${missing.join(" and ")}` };
  }

  if (payload.pdf_available === false) {
    return { skip: `invoice ${invoiceUuid} reports no PDF available yet` };
  }

  return { invoiceNumber: readString(payload.invoice_number), invoiceUuid, orderId };
};

/** True when reading the payload produced a skip rather than a usable event. */
export const isSkipped = (read: InvoiceIssued | { skip: string }): read is { skip: string } =>
  "skip" in read;

/**
 * The invoice document already registered on the order for this number, if any.
 *
 * THE dedupe guard, and the reason it exists is a production incident class rather than
 * a hypothetical: `POST /order/checkout-forms/{id}/invoices` takes no idempotency key,
 * so a crash - or a redelivered event - between a successful create and the id being
 * persisted registers a SECOND document for the same invoice. The buyer then sees two
 * invoices for one order, and an order accepts only ten.
 *
 * Matched on the trimmed invoice number because that is the only field both sides
 * agree on. Allegro echoes back what it was given, so an exact match is a document
 * this plugin created for this invoice.
 */
export const findRegisteredInvoice = (
  invoices: readonly CheckoutFormInvoice[] | undefined,
  invoiceNumber: string,
): CheckoutFormInvoice | undefined => {
  const wanted = invoiceNumber.trim();
  if (!wanted) {
    return undefined;
  }
  return (invoices ?? []).find((invoice) => invoice.invoiceNumber?.trim() === wanted);
};

/**
 * The filename Allegro shows the buyer for the attached document.
 *
 * A Polish invoice number contains slashes (`FV/2026/08/001`), which are path separators
 * in a filename and are rejected. Every character outside `[A-Za-z0-9._-]` collapses to
 * a single underscore, and the number is what the name is built from so a buyer with
 * several invoices can tell them apart.
 */
export const invoiceFileName = (invoiceNumber: string): string => {
  const safe = invoiceNumber
    .trim()
    .replaceAll(/[^\w.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return `${safe || "invoice"}.pdf`;
};

/**
 * Why this PDF must not be uploaded, or undefined when it may be.
 *
 * Checked BEFORE the document is registered, which is a deliberate departure from the
 * pipeline this replaces. That one registered first and discovered the size afterwards,
 * leaving a document with no file behind on the order - and a document with no file
 * still counts against Allegro's limit of ten, so a repeatedly-oversized invoice could
 * eventually make the order unable to accept the correct one.
 *
 * An empty file is rejected for the same reason it was upstream: Allegro accepts the
 * upload and the buyer downloads zero bytes, which is worse than a recorded failure.
 */
export const rejectInvoicePdf = (byteLength: number): string | undefined => {
  if (byteLength === 0) {
    return "the invoice PDF is empty (0 bytes), so it was not uploaded";
  }
  if (byteLength > ALLEGRO_INVOICE_MAX_BYTES) {
    return `the invoice PDF is ${byteLength} bytes, over Allegro's ${ALLEGRO_INVOICE_MAX_BYTES}-byte limit, so it was not uploaded. Allegro would reject the upload and the registered document would still count against the ten an order allows.`;
  }
  return undefined;
};
