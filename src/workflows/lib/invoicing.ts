import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * The soft dependency on the module that issues invoices.
 *
 * The invoicing module issues the documents and emits `infakt.invoice.issued`; this
 * plugin attaches them to Allegro orders. Neither depends on the other, on purpose: a
 * store can invoice without selling on Allegro and sell on Allegro without invoicing,
 * and a hard dependency in either direction would make each plugin unusable without the
 * other. So the coupling is a container key (`invoiceModuleKey`) and two structurally
 * matched members, exactly like `resolveCostsService` and the product-costs module.
 *
 * Both members are that module's PUBLIC surface - `apiClient` is a documented public
 * getter, `listInfaktInvoices` is the generated CRUD read for its model - and nothing
 * here reaches past them into its internals. Duck-typed member by member rather than
 * all-or-nothing, because the two are needed independently: the event path needs only
 * the PDF, and the retry sweep needs only the listing. A version skew that renames one
 * degrades that half and leaves the other working.
 */

/** The PDF fetch: `infakt.apiClient.getInvoicePdf(uuid)`. */
interface InvoiceApiClientLike {
  getInvoicePdf?: (
    uuid: string,
    options?: { documentType?: string; locale?: string },
  ) => Promise<Uint8Array>;
}

/** The shape the attach path matches on the resolved module service. */
interface InvoiceModuleLike {
  apiClient?: InvoiceApiClientLike;
  listInfaktInvoices?: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[]>;
}

/** One issued invoice, as the sweep reads it out of the invoicing module. */
export interface IssuedInvoice {
  orderId: string;
  invoiceUuid: string;
  invoiceNumber?: string;
}

/** What this plugin can do with the invoicing module, once resolved. */
export interface InvoiceSource {
  /**
   * The invoice PDF, or a thrown error.
   *
   * Fetching it has a side effect upstream: inFakt flips the invoice to "printed",
   * which is how it records that the document left the system. That is why the attach
   * path resolves the Allegro client FIRST - flipping the status for an upload that
   * cannot happen is a side effect with nothing to show for it.
   */
  fetchPdf?: (invoiceUuid: string) => Promise<Uint8Array>;
  /**
   * The most recently touched issued invoices, newest first, capped at `limit`.
   *
   * Ordered by `updated_at` rather than an issue timestamp because every Medusa model
   * has it, and it is the right axis anyway: a row is touched when it is issued and
   * again on every retry, so the window naturally holds whatever is still moving.
   */
  listIssued?: (limit: number) => Promise<IssuedInvoice[]>;
}

/**
 * Resolve the invoicing module, if it is registered.
 *
 * Returns an object whose members are present only for the parts that resolved, so a
 * caller checks the capability it needs rather than assuming both. An absent module is
 * `undefined` - a supported configuration, not a boot failure - and the invoice chain is
 * then simply inert.
 */
export const resolveInvoiceSource = (
  container: MedusaContainer,
  invoiceModuleKey: string,
): InvoiceSource | undefined => {
  let service: InvoiceModuleLike | undefined;
  try {
    service = container.resolve<InvoiceModuleLike>(invoiceModuleKey);
  } catch {
    return undefined;
  }
  if (!service) {
    return undefined;
  }

  const source: InvoiceSource = {};

  // `apiClient` is a getter that constructs its client lazily, so reading it is real
  // work and can in principle throw. Guarded rather than assumed, since a throw here
  // would surface as "the Allegro plugin crashed" for a fault in another module.
  try {
    const client = service.apiClient;
    const getInvoicePdf = client?.getInvoicePdf;
    if (client && typeof getInvoicePdf === "function") {
      // Called through `client` rather than as a detached function, so the memoized
      // client stays its own receiver.
      source.fetchPdf = (invoiceUuid: string) =>
        getInvoicePdf.call(client, invoiceUuid);
    }
  } catch {
    // Leave `fetchPdf` absent: the caller reports "no PDF surface" rather than crashing.
  }

  const { listInfaktInvoices } = service;
  if (typeof listInfaktInvoices === "function") {
    source.listIssued = async (limit: number): Promise<IssuedInvoice[]> => {
      const rows = await listInfaktInvoices.call(
        service,
        {},
        { order: { updated_at: "DESC" }, take: limit },
      );
      return (
        (rows ?? [])
          .map((row) => ({
            // An adopted invoice was issued by whatever ran before this plugin, and
            // its PDF belongs to that pipeline's records - the old system attached
            // it, or decided not to, months ago. Sweeping it now means pushing a
            // historical document at a historical order on every tick: it fails,
            // and a permanent failure in the drain's health line is worse than the
            // attachment was ever worth.
            adopted: row.adopted_at !== null && row.adopted_at !== undefined,
            invoiceNumber:
              typeof row.invoice_number === "string"
                ? row.invoice_number
                : undefined,
            invoiceUuid:
              typeof row.invoice_uuid === "string" ? row.invoice_uuid : "",
            orderId: typeof row.order_id === "string" ? row.order_id : "",
          }))
          // A row without a uuid has no issued document yet, and one without an order id
          // cannot be matched to an Allegro order. Both are normal states of that table
          // rather than errors, so they are filtered rather than reported.
          .filter(
            (row) =>
              row.invoiceUuid !== "" && row.orderId !== "" && !row.adopted,
          )
          .map(({ adopted, ...row }) => row)
      );
    };
  }

  return source;
};
