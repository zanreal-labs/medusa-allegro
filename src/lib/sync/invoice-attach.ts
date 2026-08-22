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

/** The event this plugin listens for. Emitted by the invoicing module. */
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

/**
 * Which call in the attach sequence failed.
 *
 * A 400 with no other context cost an operator an hour: "Allegro rejected the invoice
 * attachment" is true of three different requests, and they fail for entirely different
 * reasons. `create` is a JSON body Allegro validates; `upload` is a raw PDF; `list` is a
 * read that touches neither. Naming the stage is what turns one log line into a
 * diagnosis, and it costs nothing.
 */
export type AttachStage = "pdf" | "list" | "create" | "upload";

/** What each stage was trying to do, in the words an operator needs. */
export const ATTACH_STAGE_LABEL: Record<AttachStage, string> = {
  create: "registering the invoice document on the Allegro order (POST .../invoices)",
  list: "reading the documents already on the Allegro order (GET .../invoices)",
  pdf: "fetching the invoice PDF from the invoicing module",
  upload: "uploading the invoice file to Allegro (PUT .../invoices/{id}/file)",
};

/**
 * How much of Allegro's error body one log line may carry.
 *
 * Bounded because the body is remote input: a pathological `details` should not be able
 * to push megabytes through the logger. Generous enough that the several `errors[]`
 * entries Allegro actually returns all fit.
 */
export const MAX_ALLEGRO_ERROR_CHARS = 700;

/** One entry of Allegro's `errors[]`, as the API documents it (`ErrorsHolder`). */
interface AllegroErrorEntry {
  code?: string;
  message?: string;
  details?: string;
  path?: string;
  userMessage?: string;
}

/** The parts of an `AllegroApiError` this formatter reads, structurally. */
interface AllegroFailure {
  httpStatus: number;
  message: string;
  errors?: readonly AllegroErrorEntry[];
  raw?: unknown;
  requestId?: string;
}

const isAllegroFailure = (error: unknown): error is AllegroFailure =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as AllegroFailure).httpStatus === "number" &&
  typeof (error as AllegroFailure).message === "string";

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} more)`;

/** One `errors[]` entry as a single readable clause. */
const renderEntry = (entry: AllegroErrorEntry): string => {
  const parts = [
    entry.code ? `code=${entry.code}` : undefined,
    entry.path ? `path=${entry.path}` : undefined,
    entry.message,
    entry.userMessage && entry.userMessage !== entry.message ? entry.userMessage : undefined,
    entry.details,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(" | ") : "(an empty error entry)";
};

/**
 * Everything Allegro said about a rejection, rendered for a log line.
 *
 * The whole point of this function: `AllegroApiError.message` is only the FIRST
 * `userMessage` (or `message`) Allegro returned, and for a 400 that first string is
 * routinely the generic "Bad Request" - while the `code` and `path` that say WHICH field
 * was wrong sit unread in `errors[]`. Swallowing them is what made the production
 * failure unactionable.
 *
 * Falls back to the raw body when there is no structured `errors[]` - Allegro also
 * answers with `{ error, error_description }` on some paths, and with plain text through
 * its gateway, and either is worth more than nothing.
 */
export const describeAllegroErrors = (failure: AllegroFailure): string => {
  const entries = failure.errors ?? [];
  if (entries.length > 0) {
    return clip(entries.map(renderEntry).join(" ;; "), MAX_ALLEGRO_ERROR_CHARS);
  }
  if (typeof failure.raw === "string" && failure.raw.trim()) {
    return clip(failure.raw.trim(), MAX_ALLEGRO_ERROR_CHARS);
  }
  if (typeof failure.raw === "object" && failure.raw !== null) {
    try {
      return clip(JSON.stringify(failure.raw), MAX_ALLEGRO_ERROR_CHARS);
    } catch {
      // A body that cannot be stringified (a cycle, a BigInt) is not worth failing over.
    }
  }
  return "Allegro returned no error body.";
};

/** What this attach put on the wire, echoed back so a rejection can be read against it. */
export interface AttachRequestFacts {
  /** `file.name` as sent on the create. */
  fileName?: string;
  /** `invoiceNumber` as sent on the create. */
  invoiceNumber?: string;
  /** Size of the PDF, when one was read. */
  pdfBytes?: number;
}

const renderFacts = (sent: AttachRequestFacts): string => {
  const parts = [
    sent.fileName === undefined ? undefined : `file.name=${JSON.stringify(sent.fileName)}`,
    sent.invoiceNumber === undefined
      ? undefined
      : `invoiceNumber=${JSON.stringify(sent.invoiceNumber)}`,
    sent.pdfBytes === undefined ? undefined : `pdfBytes=${sent.pdfBytes}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` Sent: ${parts.join(", ")}.` : "";
};

/** `httpStatus: 0` means the request never reached Allegro; saying "HTTP 0" reads as a bug. */
const failureStatus = (failure: AllegroFailure): string =>
  failure.httpStatus === 0 ? "no response" : String(failure.httpStatus);

/**
 * The one-line failure an attach records, with everything needed to act on it.
 *
 * Deliberately says four things a bare `error.message` did not: which call failed, what
 * Allegro's own `errors[]` contained, the `x-request-id` to quote at Allegro support,
 * and the two values this plugin chose (`file.name`, `invoiceNumber`) - which are the
 * only inputs a rejection of the metadata create can be about.
 *
 * PII-safe by construction: none of those fields carries buyer data. The Allegro invoice
 * endpoints take a filename and an invoice number and nothing else, and the response
 * body is codes and field paths. The buyer's name, address and tax id live on the
 * checkout form, which this path never sends anywhere.
 */
export const describeAttachFailure = (
  stage: AttachStage | undefined,
  error: unknown,
  sent: AttachRequestFacts = {},
): string => {
  const where = stage ? `while ${ATTACH_STAGE_LABEL[stage]}` : "while attaching the invoice";
  if (isAllegroFailure(error)) {
    return `Allegro rejected the invoice attachment ${where} (HTTP ${failureStatus(error)}): ${
      error.message
    }. Allegro said: ${describeAllegroErrors(error)}${
      error.requestId ? ` [x-request-id: ${error.requestId}]` : ""
    }.${renderFacts(sent)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `the invoice attachment failed ${where}: ${message}.${renderFacts(sent)}`;
};


/**
 * Whether a rejected metadata create is worth retrying once without `invoiceNumber`.
 *
 * `CheckFormsNewOrderInvoice` requires exactly one field, `file`, and makes
 * `invoiceNumber` optional. So for a body this plugin builds, `invoiceNumber` is the ONLY
 * field whose value can make an otherwise schema-valid request invalid - and Allegro
 * documents no 400 for this endpoint at all, which means a 400 is the gateway refusing
 * the request rather than the order refusing the invoice (that is a 422, and a duplicate
 * is a 409).
 *
 * So a 400 with a number attached buys a single, cheap, decisive experiment: send the
 * minimum legal body. If Allegro accepts it, the invoice reaches the buyer AND the cause
 * is proven to be the number; if it rejects that too, the body is exonerated and the log
 * carries both rejections. Narrow on purpose - only 400, only when a number was actually
 * sent, so a 403 (scope), 409 (duplicate), 422 (order state) and 429 (too fast) all keep
 * their own meaning and are never retried into a second document.
 */
export const shouldRetryWithoutInvoiceNumber = (
  error: unknown,
  sentInvoiceNumber: string | undefined,
): boolean => Boolean(sentInvoiceNumber) && isAllegroFailure(error) && error.httpStatus === 400;
