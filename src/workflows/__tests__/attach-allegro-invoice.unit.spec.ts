import { AllegroApiError } from "../../lib/allegro/errors";
import { ALLEGRO_INVOICE_MAX_BYTES } from "../../lib/allegro/types";
import { ATTACH_ERROR_PREFIX } from "../../lib/sync/invoice-attach";
import allegroInvoiceAttachSubscriber from "../../subscribers/allegro-invoice-attach";
import {
  attachAllegroInvoice,
  INVOICE_SWEEP_BATCH,
  sweepUnattachedInvoices,
} from "../attach-allegro-invoice";
import { fakeAllegroService } from "./fixtures";

/**
 * The invoice chain's Medusa wiring.
 *
 * The decisions themselves are covered directly in
 * `src/lib/sync/__tests__/invoice-attach.unit.spec.ts`. What is left here is the part
 * only the wiring can get wrong, and every case below is a production failure mode rather
 * than a branch for its own sake:
 *
 * - a second invoice document on a real order, because Allegro's create has no idempotency
 *   key and the event bus is at-least-once;
 * - an invoice attached to an order that never came from Allegro, or noise logged for one;
 * - a document registered for a PDF that can never be uploaded, permanently consuming one
 *   of the ten an order allows;
 * - a failure that vanishes, so nobody knows the buyer has no invoice.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

interface OrderRow {
  id: string;
  checkout_form_id: string;
  medusa_order_id?: string | null;
  allegro_invoice_id?: string | null;
  invoice_attached_at?: Date | null;
  last_error?: string | null;
  [key: string]: unknown;
}

/**
 * The order table, honouring the two filter forms the attach path uses.
 *
 * `medusa_order_id` arrives as a scalar from the event path and as an ARRAY from the
 * sweep (Mikro-ORM turns a list into `$in`), and `invoice_attached_at: null` is how the
 * sweep asks for "not attached". A fake that ignored either would make the sweep look like
 * it worked while selecting the wrong rows.
 */
const orderTable = (seed: OrderRow[]) => {
  const rows = seed.map((row) => ({ ...row }));
  const writes: Record<string, unknown>[] = [];
  return {
    list: (filters: Record<string, unknown> = {}, config: { take?: number } = {}) => {
      let out = rows.map((row) => ({ ...row }));
      const wantedOrderIds = filters.medusa_order_id;
      if (wantedOrderIds !== undefined) {
        const wanted = Array.isArray(wantedOrderIds) ? wantedOrderIds : [wantedOrderIds];
        out = out.filter((row) => wanted.includes(row.medusa_order_id));
      }
      if (filters.invoice_attached_at === null) {
        out = out.filter((row) => !row.invoice_attached_at);
      }
      return Promise.resolve(config.take === undefined ? out : out.slice(0, config.take));
    },
    rows,
    update: (patches: (Record<string, unknown> & { id: string })[]) => {
      for (const patch of patches) {
        writes.push(patch);
        const index = rows.findIndex((row) => row.id === patch.id);
        if (index !== -1) {
          rows[index] = { ...rows[index], ...patch } as OrderRow;
        }
      }
      return Promise.resolve(patches);
    },
    writes,
  };
};

/** The two Allegro calls the attach makes, plus the dedupe read. */
const fakeClient = (
  input: {
    registered?: { id: string; invoiceNumber?: string }[];
    createError?: Error;
    uploadError?: Error;
    listError?: Error;
  } = {},
) => {
  const creates: { formId: string; name: string; invoiceNumber?: string }[] = [];
  const uploads: { formId: string; invoiceId: string; bytes: number }[] = [];
  const lists: string[] = [];
  let sequence = 0;
  return {
    createCheckoutFormInvoice: (
      formId: string,
      invoice: { file: { name: string }; invoiceNumber?: string },
    ) => {
      if (input.createError) {
        return Promise.reject(input.createError);
      }
      creates.push({ formId, invoiceNumber: invoice.invoiceNumber, name: invoice.file.name });
      sequence += 1;
      return Promise.resolve({ id: `inv-created-${sequence}` });
    },
    creates,
    getCheckoutFormInvoices: (formId: string) => {
      if (input.listError) {
        return Promise.reject(input.listError);
      }
      lists.push(formId);
      return Promise.resolve({ invoices: input.registered ?? [] });
    },
    lists,
    uploadCheckoutFormInvoiceFile: (formId: string, invoiceId: string, pdf: Uint8Array) => {
      if (input.uploadError) {
        return Promise.reject(input.uploadError);
      }
      uploads.push({ bytes: pdf.byteLength, formId, invoiceId });
      return Promise.resolve();
    },
    uploads,
  };
};

const setup = (
  input: {
    orders?: OrderRow[];
    registered?: { id: string; invoiceNumber?: string }[];
    pdf?: Uint8Array;
    pdfError?: Error;
    /** Omit the PDF surface entirely, as an invoicing module without one would. */
    noPdfSurface?: boolean;
    /** Leave the module unregistered, as a store that does not invoice through one does. */
    noInvoiceModule?: boolean;
    issued?: { order_id?: unknown; invoice_uuid?: unknown; invoice_number?: unknown }[];
    /** Omit the listing surface, so only the event path works. */
    noListing?: boolean;
    createError?: Error;
    uploadError?: Error;
    listError?: Error;
    connected?: boolean;
    invoiceAttachDisabled?: boolean;
  } = {},
) => {
  const client = fakeClient(input);
  const table = orderTable(input.orders ?? []);
  const allegro = fakeAllegroService({
    client: input.connected === false ? null : client,
    invoiceAttachDisabled: input.invoiceAttachDisabled,
  }) as ReturnType<typeof fakeAllegroService> & Record<string, unknown>;
  allegro.listAllegroOrders = table.list;
  allegro.updateAllegroOrders = table.update;

  const pdfCalls: string[] = [];
  const logs: string[] = [];
  const invoiceModule: Record<string, unknown> = {};
  if (!input.noPdfSurface) {
    invoiceModule.apiClient = {
      getInvoicePdf: (uuid: string) => {
        pdfCalls.push(uuid);
        if (input.pdfError) {
          return Promise.reject(input.pdfError);
        }
        return Promise.resolve(input.pdf ?? PDF);
      },
    };
  }
  if (!input.noListing) {
    invoiceModule.listInfaktInvoices = () => Promise.resolve(input.issued ?? []);
  }

  const container = {
    resolve: (key: string) => {
      if (key === "allegro") {
        return allegro;
      }
      if (key === "logger") {
        return {
          error: (message: string) => logs.push(`error: ${message}`),
          info: (message: string) => logs.push(`info: ${message}`),
          warn: (message: string) => logs.push(`warn: ${message}`),
        };
      }
      if (key === "infakt") {
        if (input.noInvoiceModule) {
          throw new Error("infakt is not registered");
        }
        return invoiceModule;
      }
      throw new Error(`unexpected container key ${key}`);
    },
  };

  return { allegro, client, container, logs, pdfCalls, table };
};

const allegroOrder = (over: Partial<OrderRow> = {}): OrderRow => ({
  checkout_form_id: "form-1",
  id: "algorder_1",
  medusa_order_id: "order_1",
  ...over,
});

const event = { invoiceNumber: "FV/2026/08/001", invoiceUuid: "uuid-1", orderId: "order_1" };

describe("attachAllegroInvoice: not an Allegro order", () => {
  it("ignores an order this plugin never imported, silently", async () => {
    // The common case in a multi-channel store. One indexed read is the whole cost, and
    // reporting it would put a line in the log for every invoice the store ever issues.
    const context = setup({ orders: [] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toEqual({ attempted: false });
    expect(context.client.creates).toEqual([]);
    expect(context.pdfCalls).toEqual([]);
    expect(context.logs).toEqual([]);
  });

  it("does not fetch the PDF for it", async () => {
    // Fetching flips the invoice to "printed" upstream. Doing that for an order this
    // plugin has nothing to do with is a side effect on somebody else's document.
    const context = setup({ orders: [allegroOrder({ medusa_order_id: "order_OTHER" })] });

    await attachAllegroInvoice(context.container as never, event);

    expect(context.pdfCalls).toEqual([]);
  });
});

describe("attachAllegroInvoice: the happy path", () => {
  it("registers the document, uploads the PDF, then stamps the watermark", async () => {
    const context = setup({ orders: [allegroOrder()] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attached: true, attempted: true, reusedDocument: false });
    // Dedupe read BEFORE the create, always.
    expect(context.client.lists).toEqual(["form-1"]);
    expect(context.client.creates).toEqual([
      { formId: "form-1", invoiceNumber: "FV/2026/08/001", name: "FV_2026_08_001.pdf" },
    ]);
    expect(context.client.uploads).toEqual([
      { bytes: PDF.byteLength, formId: "form-1", invoiceId: "inv-created-1" },
    ]);
    expect(context.table.rows[0]).toMatchObject({
      allegro_invoice_id: "inv-created-1",
      last_error: null,
    });
    expect(context.table.rows[0]?.invoice_attached_at).toBeInstanceOf(Date);
  });

  it("persists the document id BEFORE the upload, not after it", async () => {
    // The whole reason `allegro_invoice_id` exists. A crash between the create and the
    // upload must leave the id behind, or the retry registers a second document.
    const context = setup({ orders: [allegroOrder()], uploadError: new Error("connection reset") });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.attached).toBeUndefined();
    expect(context.table.rows[0]?.allegro_invoice_id).toBe("inv-created-1");
    expect(context.table.rows[0]?.invoice_attached_at).toBeUndefined();
    const [firstWrite] = context.table.writes;
    expect(firstWrite).toEqual({ allegro_invoice_id: "inv-created-1", id: "algorder_1" });
  });

  it("falls back to the uuid when the emitter had no invoice number", async () => {
    const context = setup({ orders: [allegroOrder()] });

    await attachAllegroInvoice(context.container as never, {
      invoiceUuid: "uuid-1",
      orderId: "order_1",
    });

    expect(context.client.creates[0]).toMatchObject({
      invoiceNumber: "uuid-1",
      name: "uuid-1.pdf",
    });
  });
});

describe("attachAllegroInvoice: dedupe", () => {
  it("reuses the document already registered under this invoice number", async () => {
    // Allegro's create takes no idempotency key, so this is the only thing between a
    // redelivered event and two invoices on one real order.
    const context = setup({
      orders: [allegroOrder()],
      registered: [{ id: "inv-existing", invoiceNumber: "FV/2026/08/001" }],
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attached: true, reusedDocument: true });
    expect(context.client.creates).toEqual([]);
    // The file is still uploaded: the crash this recovers from may have happened before
    // the upload, and `PUT .../file` is idempotent.
    expect(context.client.uploads).toEqual([
      { bytes: PDF.byteLength, formId: "form-1", invoiceId: "inv-existing" },
    ]);
    expect(context.table.rows[0]?.allegro_invoice_id).toBe("inv-existing");
  });

  it("creates when the order carries a different invoice", async () => {
    // A second, genuinely different invoice on the same order - a correction, or a split
    // shipment - must not be suppressed by the dedupe guard.
    const context = setup({
      orders: [allegroOrder()],
      registered: [{ id: "inv-other", invoiceNumber: "FV/2026/07/500" }],
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attached: true, reusedDocument: false });
    expect(context.client.creates).toHaveLength(1);
  });

  it("skips the dedupe read entirely when the id is already stored", async () => {
    const context = setup({ orders: [allegroOrder({ allegro_invoice_id: "inv-stored" })] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attached: true, reusedDocument: true });
    expect(context.client.lists).toEqual([]);
    expect(context.client.creates).toEqual([]);
    expect(context.client.uploads[0]).toMatchObject({ invoiceId: "inv-stored" });
  });

  it("does nothing at all for an order already attached", async () => {
    const context = setup({
      orders: [allegroOrder({ allegro_invoice_id: "inv-1", invoice_attached_at: new Date() })],
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toEqual({ alreadyAttached: true, attempted: false });
    expect(context.pdfCalls).toEqual([]);
    expect(context.client.uploads).toEqual([]);
    expect(context.table.writes).toEqual([]);
  });
});

describe("attachAllegroInvoice: the size guard", () => {
  it("records an oversized PDF and registers nothing", async () => {
    // Registering first, as the pipeline this replaces did, leaves a document with no file
    // on the order - and it still counts against the ten an order allows, so a repeatedly
    // oversized invoice could eventually block the one that would fit.
    const context = setup({
      orders: [allegroOrder()],
      pdf: new Uint8Array(ALLEGRO_INVOICE_MAX_BYTES + 1),
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.attached).toBeUndefined();
    expect(result.error).toMatch(/over Allegro's/);
    expect(context.client.lists).toEqual([]);
    expect(context.client.creates).toEqual([]);
    expect(context.client.uploads).toEqual([]);
    expect(context.table.rows[0]?.last_error).toMatch(
      new RegExp(`^${ATTACH_ERROR_PREFIX}: the invoice PDF is`),
    );
  });

  it("refuses an empty PDF too", async () => {
    const context = setup({ orders: [allegroOrder()], pdf: new Uint8Array(0) });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.error).toMatch(/empty/);
    expect(context.client.uploads).toEqual([]);
  });

  it("uploads a PDF exactly at the limit", async () => {
    const context = setup({
      orders: [allegroOrder()],
      pdf: new Uint8Array(ALLEGRO_INVOICE_MAX_BYTES),
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.attached).toBe(true);
  });
});

describe("attachAllegroInvoice: failures are recorded, never thrown", () => {
  it("records Allegro's own message when the create is rejected", async () => {
    const context = setup({
      createError: new AllegroApiError({
        httpStatus: 422,
        message: "Maksymalna liczba faktur to 10.",
      }),
      orders: [allegroOrder()],
    });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attempted: true });
    expect(result.error).toContain("Maksymalna liczba faktur to 10.");
    expect(context.table.rows[0]?.last_error).toContain("HTTP 422");
    expect(context.table.rows[0]?.invoice_attached_at).toBeUndefined();
  });

  it("records a failed PDF fetch without touching Allegro", async () => {
    const context = setup({ orders: [allegroOrder()], pdfError: new Error("inFakt timed out") });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.error).toBe("inFakt timed out");
    expect(context.client.creates).toEqual([]);
    expect(context.table.rows[0]?.last_error).toBe(`${ATTACH_ERROR_PREFIX}: inFakt timed out`);
  });

  it("records a disconnected Allegro before spending the PDF fetch", async () => {
    // Fetching flips the invoice to "printed" upstream, so the client is resolved first:
    // there is no point paying that side effect for an upload that cannot happen.
    const context = setup({ connected: false, orders: [allegroOrder()] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result).toMatchObject({ attempted: false });
    expect(result.error).toMatch(/not connected/);
    expect(context.pdfCalls).toEqual([]);
  });

  it("names the option when the invoicing module is missing", async () => {
    const context = setup({ noInvoiceModule: true, orders: [allegroOrder()] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.error).toMatch(/invoiceModuleKey/);
    expect(context.table.rows[0]?.last_error).toContain("infakt");
  });

  it("says so when the module exposes no PDF method", async () => {
    // A version skew rather than a missing install, and the two need different fixes, so
    // the message covers both readings.
    const context = setup({ noPdfSurface: true, orders: [allegroOrder()] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.error).toMatch(/no invoice-PDF method/);
  });

  it("records the kill switch on the row, not just in the log", async () => {
    // "The invoice is not on the order" looks identical to a broken integration from the
    // outside, and a disabled switch is the one explanation nobody guesses.
    const context = setup({ invoiceAttachDisabled: true, orders: [allegroOrder()] });

    const result = await attachAllegroInvoice(context.container as never, event);

    expect(result.attempted).toBe(false);
    expect(result.skipped).toMatch(/ALLEGRO_INVOICE_ATTACH_DISABLED/);
    expect(context.table.rows[0]?.last_error).toMatch(/invoice attach is disabled/);
    expect(context.pdfCalls).toEqual([]);
  });
});

describe("sweepUnattachedInvoices", () => {
  const sweep = (context: ReturnType<typeof setup>, mayContinue = () => Promise.resolve(true)) =>
    sweepUnattachedInvoices(
      context.container as never,
      context.allegro as never,
      context.container.resolve("logger") as never,
      "infakt",
      mayContinue,
    );

  it("retries an order whose attach failed earlier", async () => {
    const context = setup({
      issued: [{ invoice_number: "FV/2026/08/001", invoice_uuid: "uuid-1", order_id: "order_1" }],
      orders: [allegroOrder({ last_error: `${ATTACH_ERROR_PREFIX}: inFakt timed out` })],
    });

    const result = await sweep(context);

    expect(result).toMatchObject({ attached: 1, attempted: 1, failed: 0 });
    expect(context.table.rows[0]?.invoice_attached_at).toBeInstanceOf(Date);
    // The stale failure line is cleared by the successful attach, so the admin stops
    // reporting a problem that is fixed.
    expect(context.table.rows[0]?.last_error).toBeNull();
  });

  it("finishes the half-done attach that registered but never uploaded", async () => {
    const context = setup({
      issued: [{ invoice_number: "FV/2026/08/001", invoice_uuid: "uuid-1", order_id: "order_1" }],
      orders: [allegroOrder({ allegro_invoice_id: "inv-stored" })],
    });

    const result = await sweep(context);

    expect(result.attached).toBe(1);
    // No second document: the stored id is reused.
    expect(context.client.creates).toEqual([]);
    expect(context.client.uploads[0]).toMatchObject({ invoiceId: "inv-stored" });
  });

  it("leaves an already-attached order alone", async () => {
    const context = setup({
      issued: [{ invoice_number: "FV/1", invoice_uuid: "uuid-1", order_id: "order_1" }],
      orders: [allegroOrder({ invoice_attached_at: new Date() })],
    });

    const result = await sweep(context);

    expect(result).toEqual({ attached: 0, attempted: 0, failed: 0 });
    expect(context.pdfCalls).toEqual([]);
  });

  it("ignores an issued invoice for an order that did not come from Allegro", async () => {
    const context = setup({
      issued: [{ invoice_number: "FV/1", invoice_uuid: "uuid-1", order_id: "order_WEBSHOP" }],
      orders: [allegroOrder()],
    });

    const result = await sweep(context);

    expect(result.attempted).toBe(0);
    expect(context.client.uploads).toEqual([]);
  });

  it("counts a persistent failure without stopping the batch", async () => {
    const context = setup({
      issued: [
        { invoice_number: "FV/1", invoice_uuid: "uuid-1", order_id: "order_1" },
        { invoice_number: "FV/2", invoice_uuid: "uuid-2", order_id: "order_2" },
      ],
      orders: [
        allegroOrder(),
        allegroOrder({ checkout_form_id: "form-2", id: "algorder_2", medusa_order_id: "order_2" }),
      ],
      uploadError: new Error("Allegro is unreachable"),
    });

    const result = await sweep(context);

    expect(result).toMatchObject({ attached: 0, attempted: 2, failed: 2 });
    expect(context.table.rows.every((row) => row.last_error?.startsWith(ATTACH_ERROR_PREFIX))).toBe(
      true,
    );
  });

  it("stops at the claim fence rather than finishing the batch", async () => {
    // A lost claim means another run owns these rows; a flipped switch means stop writing
    // to Allegro now. Either way the correct response is to stop immediately.
    const context = setup({
      issued: [
        { invoice_number: "FV/1", invoice_uuid: "uuid-1", order_id: "order_1" },
        { invoice_number: "FV/2", invoice_uuid: "uuid-2", order_id: "order_2" },
      ],
      orders: [
        allegroOrder(),
        allegroOrder({ checkout_form_id: "form-2", id: "algorder_2", medusa_order_id: "order_2" }),
      ],
    });

    let checks = 0;
    const result = await sweep(context, () => {
      checks += 1;
      return Promise.resolve(checks <= 1);
    });

    expect(result.attempted).toBe(1);
    expect(context.client.uploads).toHaveLength(1);
  });

  it("does nothing when the invoice-attach switch is on", async () => {
    const context = setup({
      invoiceAttachDisabled: true,
      issued: [{ invoice_number: "FV/1", invoice_uuid: "uuid-1", order_id: "order_1" }],
      orders: [allegroOrder()],
    });

    const result = await sweep(context);

    expect(result.skipped).toMatch(/ALLEGRO_INVOICE_ATTACH_DISABLED/);
    expect(result.attempted).toBe(0);
    // Not even the candidate scan runs, so a store with the switch on pays nothing.
    expect(context.pdfCalls).toEqual([]);
  });

  it("stays silent when no invoicing module is registered", async () => {
    // A store that does not invoice through a module is a supported configuration, not a
    // fault, so this is the common case rather than something to report.
    const context = setup({ noInvoiceModule: true, orders: [allegroOrder()] });

    expect(await sweep(context)).toEqual({ attached: 0, attempted: 0, failed: 0 });
    expect(context.logs).toEqual([]);
  });

  it("stays silent when the module has no listing surface", async () => {
    const context = setup({ noListing: true, orders: [allegroOrder()] });

    expect(await sweep(context)).toEqual({ attached: 0, attempted: 0, failed: 0 });
  });

  it("skips rows the invoicing module reported without usable ids", async () => {
    const context = setup({
      issued: [{ invoice_uuid: null, order_id: "order_1" }, { invoice_uuid: "uuid-2" }],
      orders: [allegroOrder()],
    });

    expect(await sweep(context)).toMatchObject({ attempted: 0 });
  });

  it("bounds what it acts on per tick", async () => {
    const count = INVOICE_SWEEP_BATCH + 5;
    const context = setup({
      issued: Array.from({ length: count }, (_unused, index) => ({
        invoice_number: `FV/${index}`,
        invoice_uuid: `uuid-${index}`,
        order_id: `order_${index}`,
      })),
      orders: Array.from({ length: count }, (_unused, index) =>
        allegroOrder({
          checkout_form_id: `form-${index}`,
          id: `algorder_${index}`,
          medusa_order_id: `order_${index}`,
        }),
      ),
    });

    const result = await sweep(context);

    // A systematic failure - Allegro down, every PDF oversized - then costs a bounded
    // number of calls per tick rather than one per unattached invoice in the database.
    expect(result.attempted).toBe(INVOICE_SWEEP_BATCH);
  });
});

describe("the infakt.invoice.issued subscriber", () => {
  const deliver = (context: ReturnType<typeof setup>, data: unknown) =>
    allegroInvoiceAttachSubscriber({
      container: context.container as never,
      event: { data, name: "infakt.invoice.issued" },
    } as never);

  it("attaches on a well-formed event", async () => {
    const context = setup({ orders: [allegroOrder()] });

    await deliver(context, {
      invoice_number: "FV/2026/08/001",
      invoice_uuid: "uuid-1",
      order_id: "order_1",
      pdf_available: true,
    });

    expect(context.client.uploads).toHaveLength(1);
  });

  it("logs and skips a payload missing the ids, rather than throwing", async () => {
    // A throwing subscriber is retried with the same malformed payload until the budget
    // runs out, and the reason never reaches anybody.
    const context = setup({ orders: [allegroOrder()] });

    await expect(deliver(context, { invoice_number: "FV/1" })).resolves.toBeUndefined();
    expect(context.logs.some((line) => line.includes("missing order_id and invoice_uuid"))).toBe(
      true,
    );
    expect(context.client.uploads).toEqual([]);
  });

  it.each([[undefined], [null], ["not an object"], [[]]])("survives a %p payload", async (data) => {
    const context = setup({ orders: [allegroOrder()] });

    await expect(deliver(context, data)).resolves.toBeUndefined();
    expect(context.client.uploads).toEqual([]);
  });

  it("does not throw when the attach itself fails", async () => {
    const context = setup({ orders: [allegroOrder()], uploadError: new Error("Allegro 500") });

    await expect(
      deliver(context, { invoice_uuid: "uuid-1", order_id: "order_1" }),
    ).resolves.toBeUndefined();
    expect(context.table.rows[0]?.last_error).toContain("Allegro 500");
  });
});
