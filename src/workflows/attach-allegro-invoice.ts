import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { AllegroClient } from "../lib/allegro/client";
import {
  attachErrorLine,
  describeAttachFailure,
  findRegisteredInvoice,
  invoiceFileName,
  rejectInvoicePdf,
  shouldRetryWithoutInvoiceNumber,
} from "../lib/sync/invoice-attach";
import type { AttachRequestFacts, AttachStage } from "../lib/sync/invoice-attach";
import { ALLEGRO_MODULE } from "../modules/allegro";
import type AllegroModuleService from "../modules/allegro/service";
import { resolveInvoiceSource } from "./lib/invoicing";
import type { InvoiceSource } from "./lib/invoicing";

/**
 * Attach an issued invoice PDF to the Allegro order it belongs to.
 *
 * The last link in the invoicing chain: a Medusa order sourced from Allegro gets its
 * invoice issued by the invoicing module, and Allegro requires the document on the
 * checkout form so the buyer can download it from the order view.
 *
 * Event-driven, like the fulfillment push and for the same reason - an invoice being
 * issued is a point-in-time act, not reconcilable state - and best-effort in the same
 * way: the invoice already exists as a legal document by the time this runs, so a
 * failure here is recorded on the `allegro_order` row rather than propagated. Unlike the
 * fulfillment push there IS something a sweep can do about a failure, because "issued
 * but not attached" is a comparable state; see `sweepUnattachedInvoices`.
 *
 * The step ORDER is the design, and it is not the order the pipeline this replaces used:
 *
 *  1. Find the Allegro order. No row means the invoice belongs to an order that did not
 *     come from Allegro, which is silence rather than a skip - in a multi-channel store
 *     that is most invoices, and one indexed read is the whole cost.
 *  2. Stop if already attached. The event can be redelivered, and the sweep can pick up
 *     a row the subscriber is already working on.
 *  3. Resolve the Allegro client BEFORE fetching the PDF. Fetching flips the invoice to
 *     "printed" upstream, and doing that for an upload that cannot happen is a side
 *     effect with nothing to show for it.
 *  4. Fetch the PDF and check its size BEFORE registering anything. Allegro rejects a
 *     file over 3 MB, and a registered document with no file still counts against the
 *     ten an order allows - so registering first, as the old pipeline did, could
 *     eventually make an order unable to accept the invoice that WOULD fit.
 *  5. Reuse the registered document if there is one, matching on invoice number, and
 *     persist its id the moment a create returns. `POST .../invoices` has no idempotency
 *     key: this is what keeps a retry from putting a second invoice on a real order.
 *  6. Upload, then stamp `invoice_attached_at` last.
 */

/** What the attach needs to know about the invoice it is attaching. */
export interface AttachInvoiceInput {
  /** The Medusa order the invoice was issued for. */
  orderId: string;
  /** The invoicing system's id for the document, used to fetch the PDF. */
  invoiceUuid: string;
  /** The human invoice number, when known. Dedupe is weaker without it. */
  invoiceNumber?: string;
}

export interface AttachInvoiceResult {
  /** False when nothing was tried: not an Allegro order, already attached, switched off. */
  attempted: boolean;
  /** True when Allegro accepted the PDF on this pass. */
  attached?: boolean;
  /** True when the row already carried `invoice_attached_at`. */
  alreadyAttached?: boolean;
  /** True when an existing registered document was reused instead of creating one. */
  reusedDocument?: boolean;
  /** Why nothing was tried, when the reason is worth reporting. */
  skipped?: string;
  error?: string;
}

/** The minimum of the row this path reads. */
interface AllegroOrderRow {
  id: string;
  checkout_form_id: string;
  allegro_invoice_id?: string | null;
  invoice_attached_at?: Date | null;
}

export const INVOICE_ATTACH_DISABLED_REASON =
  "invoice attach is disabled (the `invoiceAttachDisabled` option, or ALLEGRO_INVOICE_ATTACH_DISABLED). The invoice was issued but not attached to the Allegro order.";

/**
 * Record a failure on the row and warn. Never throws, never rethrows.
 *
 * The message lands in the shared `last_error` column, which the drain clears on its
 * next clean pass of the same form. That is a known trade-off rather than an oversight:
 * a dedicated column would outlive the drain, but the retry path deliberately does not
 * depend on this string surviving - the sweep asks the invoicing module what has been
 * issued instead.
 */
const recordFailure = async (
  allegro: AllegroModuleService,
  logger: Logger,
  row: AllegroOrderRow,
  message: string,
): Promise<void> => {
  await allegro.updateAllegroOrders([
    { id: row.id, last_error: attachErrorLine(message) },
  ] as never);
  logger.warn(
    `[allegro-invoice] checkout form ${row.checkout_form_id}: ${message} Attach it by hand from the Allegro seller panel if it does not recover.`,
  );
};

/**
 * An error tagged with the call it came from.
 *
 * The attach makes four remote calls inside one `try`, and until this existed the catch
 * could only say "the invoice attachment failed" - which is why a production HTTP 400
 * was unactionable for an hour: nothing in the log said whether Allegro had rejected the
 * JSON metadata, the raw PDF upload, or neither. Tagging at the call site cannot drift
 * the way a mutable `stage` variable would.
 */
class StagedError extends Error {
  constructor(
    readonly stage: AttachStage,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "StagedError";
  }
}

/** Run one remote call, tagging anything it throws with the stage it was. */
const atStage = async <T>(stage: AttachStage, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new StagedError(stage, error);
  }
};

/**
 * Everything known about a failure, in one line the `allegro_order` row can carry.
 *
 * `AllegroApiError.message` alone is not enough and that is not a hypothetical: Allegro
 * answers a rejected invoice create with the generic "Bad Request" in `errors[0].message`
 * while the `code` and `path` naming the offending field sit in the rest of `errors[]`,
 * which the old one-line format threw away. See `describeAttachFailure`.
 */
const describeError = (error: unknown, sent: AttachRequestFacts): string =>
  error instanceof StagedError
    ? describeAttachFailure(error.stage, error.reason, sent)
    : describeAttachFailure(undefined, error, sent);

/**
 * The registered document to upload against: the stored one, an existing match, or a
 * newly created one.
 *
 * The id is persisted the instant a create returns and before the upload is attempted,
 * which is the entire point of the column. Without that write, a crash between a
 * successful create and the upload would register a second document for the same invoice
 * on the next attempt.
 */
const ensureRegisteredDocument = async (
  allegro: AllegroModuleService,
  client: Pick<AllegroClient, "createCheckoutFormInvoice" | "getCheckoutFormInvoices">,
  logger: Logger,
  row: AllegroOrderRow,
  invoiceNumber: string,
): Promise<{ invoiceId: string; reused: boolean }> => {
  if (row.allegro_invoice_id) {
    return { invoiceId: row.allegro_invoice_id, reused: true };
  }

  // The dedupe read, ALWAYS before a create. Allegro has no idempotency key here, so a
  // redelivered event or a resumed run would otherwise put a second invoice document on
  // a real order - the guard the previous pipeline ran in production.
  const existing = await atStage("list", () =>
    client.getCheckoutFormInvoices(row.checkout_form_id),
  );
  const already = findRegisteredInvoice(existing.invoices, invoiceNumber);
  if (already) {
    await allegro.updateAllegroOrders([{ allegro_invoice_id: already.id, id: row.id }] as never);
    return { invoiceId: already.id, reused: true };
  }

  const fileName = invoiceFileName(invoiceNumber);
  const created = await atStage("create", async () => {
    try {
      return await client.createCheckoutFormInvoice(row.checkout_form_id, {
        file: { name: fileName },
        invoiceNumber,
      });
    } catch (error) {
      if (!shouldRetryWithoutInvoiceNumber(error, invoiceNumber)) {
        throw error;
      }
      // ONE retry, with the minimum body Allegro's schema calls legal: `file` is the only
      // required field and `invoiceNumber` the only optional one, so this isolates the
      // number as the cause. It runs only for a 400 - the status Allegro does not
      // document for this endpoint at all, and therefore the one that means "the gateway
      // would not take this request" rather than "this order will not take this invoice"
      // (422), "it already has one" (409) or "too fast" (429). None of those retry here,
      // so this can never turn a duplicate or a scope gap into a second document.
      logger.warn(
        `[allegro-invoice] checkout form ${row.checkout_form_id}: Allegro rejected the invoice metadata (HTTP 400) with \`invoiceNumber\` set to "${invoiceNumber}"; retrying once with the number omitted, which is the only optional field in the body. ${describeError(error, { fileName, invoiceNumber })}`,
      );
      const withoutNumber = await client.createCheckoutFormInvoice(row.checkout_form_id, {
        file: { name: fileName },
      });
      logger.warn(
        `[allegro-invoice] checkout form ${row.checkout_form_id}: Allegro ACCEPTED the same invoice metadata once \`invoiceNumber\` was omitted, so it is the invoice number "${invoiceNumber}" that it rejects. The document is registered as ${withoutNumber.id} without a number, which is legal but weakens the dedupe read (\`findRegisteredInvoice\` matches on the number); \`allegro_invoice_id\` is persisted immediately below, so only a crash in the next few milliseconds could still duplicate it. Report the rejected number to Allegro with the x-request-id above.`,
      );
      return withoutNumber;
    }
  });
  await allegro.updateAllegroOrders([{ allegro_invoice_id: created.id, id: row.id }] as never);
  return { invoiceId: created.id, reused: false };
};

/**
 * Attach one invoice, given a resolved invoicing source.
 *
 * Split from `attachAllegroInvoice` so the sweep can resolve the source once for a whole
 * batch rather than per order.
 */
export const attachAllegroInvoiceWithSource = async (
  container: MedusaContainer,
  source: InvoiceSource | undefined,
  input: AttachInvoiceInput,
): Promise<AttachInvoiceResult> => {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const allegro = container.resolve<AllegroModuleService>(ALLEGRO_MODULE);

  const [row] = (await allegro.listAllegroOrders(
    { medusa_order_id: input.orderId },
    { take: 1 },
  )) as unknown as AllegroOrderRow[];
  // Not an Allegro order. Silence, not a skip reason: in a store selling through several
  // channels this is the common case, and reporting it would be noise on every invoice.
  if (!row) {
    return { attempted: false };
  }

  if (row.invoice_attached_at) {
    return { alreadyAttached: true, attempted: false };
  }

  if (await allegro.isInvoiceAttachDisabled()) {
    // Recorded on the row rather than only logged: "the invoice is not on the order" is
    // exactly the state an operator needs to be able to see, and a disabled switch is
    // the one explanation that looks identical to a broken integration from outside.
    await recordFailure(allegro, logger, row, INVOICE_ATTACH_DISABLED_REASON);
    return { attempted: false, skipped: INVOICE_ATTACH_DISABLED_REASON };
  }

  // Before the PDF fetch, deliberately: fetching flips the invoice to "printed"
  // upstream, and there is no point spending that on an upload that cannot happen.
  const client = await allegro.getClient();
  if (!client) {
    const message =
      "Allegro is not connected, so the invoice PDF was not attached. Reconnect Allegro from the admin settings.";
    await recordFailure(allegro, logger, row, message);
    return { attempted: false, error: message };
  }

  if (!source?.fetchPdf) {
    const { invoiceModuleKey } = await allegro.getSyncOptions();
    const message = `the invoicing module ("${invoiceModuleKey}") is not registered or exposes no invoice-PDF method, so there is nothing to attach. Check the \`invoiceModuleKey\` option.`;
    await recordFailure(allegro, logger, row, message);
    return { attempted: false, error: message };
  }

  // The number Allegro is asked to record, and the key the dedupe read matches on. The
  // uuid is a poor substitute - a buyer sees it in the filename - but a document
  // registered under SOME stable key can still be found again, whereas one registered
  // under none cannot.
  const invoiceNumber = input.invoiceNumber?.trim() || input.invoiceUuid;

  // Captured before the closure below: narrowing `source?.fetchPdf` above does not survive
  // into a callback, and re-asserting it with `!` would be a lie waiting to become a crash.
  const { fetchPdf } = source;

  // Echoed back into every failure line. These two values are the whole of what this
  // plugin chooses about the request, so a rejection that does not name them cannot be
  // acted on - and neither is buyer data, so logging them is safe.
  const sent: AttachRequestFacts = {
    fileName: invoiceFileName(invoiceNumber),
    invoiceNumber,
  };

  try {
    const pdf = await atStage("pdf", () => fetchPdf(input.invoiceUuid));
    sent.pdfBytes = pdf.byteLength;

    // Before anything is registered. A rejected upload leaves the document behind and it
    // still counts against the ten an order allows.
    const tooBig = rejectInvoicePdf(pdf.byteLength);
    if (tooBig) {
      await recordFailure(allegro, logger, row, tooBig);
      return { attempted: true, error: tooBig };
    }

    const document = await ensureRegisteredDocument(allegro, client, logger, row, invoiceNumber);
    await atStage("upload", () =>
      client.uploadCheckoutFormInvoiceFile(row.checkout_form_id, document.invoiceId, pdf),
    );

    // The watermark, LAST, so a row that reads attached carries a file the buyer can
    // actually download. `last_error` is cleared in the same write: the attach succeeded,
    // and a stale failure line would keep reporting a problem that is fixed.
    await allegro.updateAllegroOrders([
      {
        allegro_invoice_id: document.invoiceId,
        id: row.id,
        invoice_attached_at: new Date(),
        last_error: null,
      },
    ] as never);
    logger.info(
      `[allegro-invoice] attached invoice ${invoiceNumber} to checkout form ${row.checkout_form_id} (Medusa order ${input.orderId})${document.reused ? ", reusing the document already registered" : ""}.`,
    );
    return { attached: true, attempted: true, reusedDocument: document.reused };
  } catch (error) {
    const message = describeError(error, sent);
    await recordFailure(allegro, logger, row, message);
    return { attempted: true, error: message };
  }
};

/**
 * Attach one invoice to its Allegro order.
 *
 * Never throws. The invoice exists upstream whatever happens here, and a subscriber that
 * failed would be retried with the same inputs while the reason went unrecorded.
 */
export const attachAllegroInvoice = async (
  container: MedusaContainer,
  input: AttachInvoiceInput,
): Promise<AttachInvoiceResult> => {
  const allegro = container.resolve<AllegroModuleService>(ALLEGRO_MODULE);
  const { invoiceModuleKey } = await allegro.getSyncOptions();
  return await attachAllegroInvoiceWithSource(
    container,
    resolveInvoiceSource(container, invoiceModuleKey),
    input,
  );
};

/**
 * How many orders one sweep tick will try. Small on purpose.
 *
 * Each one is an inFakt PDF fetch plus two or three Allegro calls, inside the orders
 * claim and therefore inside the per-minute drain's budget. Ten is enough to clear a
 * backlog within minutes and small enough that a systematic failure - Allegro down,
 * every PDF oversized - costs a bounded number of calls per tick rather than a stampede.
 */
export const INVOICE_SWEEP_BATCH = 10;

/**
 * How far back through the invoicing module's rows the sweep looks for candidates.
 *
 * A bounded scan of the most recently touched invoices, not a full history walk. Rows are
 * touched when issued and again on every retry, so anything still moving stays in the
 * window; an invoice that has fallen out of it has stopped being retried by its own
 * pipeline too, and is a case for the operator rather than for a loop.
 */
export const INVOICE_SWEEP_SCAN = 50;

export interface InvoiceSweepResult {
  /** Candidates the sweep tried this tick. */
  attempted: number;
  attached: number;
  failed: number;
  /** Why the sweep did nothing, when it did nothing. */
  skipped?: string;
}

export const emptyInvoiceSweepResult = (): InvoiceSweepResult => ({
  attached: 0,
  attempted: 0,
  failed: 0,
});

/**
 * Retry the invoices that were issued but never landed on their Allegro order.
 *
 * Runs from the orders job, inside the drain's claim, because it writes to Allegro and to
 * the same rows the drain does. Two independent bounds, and both matter: the scan of the
 * invoicing module caps how much is considered, and `INVOICE_SWEEP_BATCH` caps how much
 * is acted on.
 *
 * Candidates come from the INVOICING module rather than from a marker of this plugin's
 * own, which is the one design decision here worth stating. Failures are recorded in the
 * shared `last_error` column, and the drain clears that column on its next clean pass of
 * the same form - so a sweep keyed off it would silently lose exactly the orders that are
 * otherwise healthy. Asking "what has been issued?" and comparing against
 * `invoice_attached_at` cannot be invalidated that way, and it covers both halves of the
 * failure: the attach that never registered a document, and the one that registered but
 * never uploaded.
 */
export const sweepUnattachedInvoices = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  logger: Logger,
  invoiceModuleKey: string,
  mayContinue: () => Promise<boolean>,
): Promise<InvoiceSweepResult> => {
  const result = emptyInvoiceSweepResult();

  if (await allegro.isInvoiceAttachDisabled()) {
    result.skipped = INVOICE_ATTACH_DISABLED_REASON;
    return result;
  }

  const source = resolveInvoiceSource(container, invoiceModuleKey);
  // No invoicing module (or no listing on it) means there is nothing this sweep could
  // compare against. Silent: a store that does not invoice through a module is a
  // supported configuration, and this is the common case rather than a fault.
  if (!(source?.listIssued && source.fetchPdf)) {
    return result;
  }

  const issued = await source.listIssued(INVOICE_SWEEP_SCAN);
  if (issued.length === 0) {
    return result;
  }

  const byOrderId = new Map(issued.map((invoice) => [invoice.orderId, invoice]));
  const rows = (await allegro.listAllegroOrders(
    { invoice_attached_at: null, medusa_order_id: [...byOrderId.keys()] },
    { take: INVOICE_SWEEP_BATCH },
  )) as unknown as { medusa_order_id?: string | null }[];

  for (const row of rows) {
    const invoice = row.medusa_order_id ? byOrderId.get(row.medusa_order_id) : undefined;
    if (!invoice) {
      continue;
    }
    // Both fences, per candidate: a lost claim means another run owns these rows, and a
    // switch flipped mid-run means stop writing to Allegro now.
    if (!(await mayContinue())) {
      break;
    }
    result.attempted += 1;
    const attached = await attachAllegroInvoiceWithSource(container, source, {
      invoiceNumber: invoice.invoiceNumber,
      invoiceUuid: invoice.invoiceUuid,
      orderId: invoice.orderId,
    });
    if (attached.attached) {
      result.attached += 1;
    } else if (attached.error) {
      result.failed += 1;
    }
  }

  if (result.attached > 0 || result.failed > 0) {
    logger.info(
      `[allegro-invoice] sweep attached ${result.attached} of ${result.attempted} issued invoice(s)${result.failed > 0 ? `, ${result.failed} still failing` : ""}.`,
    );
  }
  return result;
};
