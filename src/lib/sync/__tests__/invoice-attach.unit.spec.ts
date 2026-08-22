import { ALLEGRO_INVOICE_MAX_BYTES } from "../../allegro/types";
import type { CheckoutFormInvoice } from "../../allegro/types";
import {
  ATTACH_ERROR_PREFIX,
  attachErrorLine,
  describeAllegroErrors,
  describeAttachFailure,
  findRegisteredInvoice,
  invoiceFileName,
  INVOICE_ISSUED_EVENT,
  isSkipped,
  MAX_ALLEGRO_ERROR_CHARS,
  readInvoiceIssued,
  rejectInvoicePdf,
  shouldRetryWithoutInvoiceNumber,
} from "../invoice-attach";

/**
 * The three decisions of the attach path, tested directly because each one guards a
 * failure that is invisible from the outside: a duplicate invoice on a real order, a
 * two-byte PDF Allegro accepted, and a subscriber that throws on every redelivery of a
 * payload it will never be able to read.
 */

const invoice = (over: Partial<CheckoutFormInvoice> & { id: string }): CheckoutFormInvoice => ({
  createdAt: "2026-08-12T09:00:00Z",
  ...over,
});

const issued = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  invoice_number: "FV/2026/08/001",
  invoice_uuid: "uuid-1",
  ksef_number: null,
  order_id: "order_1",
  pdf_available: true,
  ...over,
});

describe("readInvoiceIssued", () => {
  it("reads the emitter's payload", () => {
    const read = readInvoiceIssued(issued());

    expect(isSkipped(read)).toBe(false);
    expect(read).toEqual({
      invoiceNumber: "FV/2026/08/001",
      invoiceUuid: "uuid-1",
      orderId: "order_1",
    });
  });

  it("ignores fields it does not use", () => {
    // The contract is the two ids and the number. An emitter that adds a field must not
    // break this consumer, which is the whole reason the payload is read rather than
    // destructured against a shared type.
    const read = readInvoiceIssued(issued({ correction_of: "uuid-0", ksef_number: "KSEF-1" }));

    expect(read).toEqual({
      invoiceNumber: "FV/2026/08/001",
      invoiceUuid: "uuid-1",
      orderId: "order_1",
    });
  });

  it.each([
    ["order_id", { order_id: undefined }, /missing order_id/],
    ["invoice_uuid", { invoice_uuid: undefined }, /missing invoice_uuid/],
    ["a blank order_id", { order_id: "   " }, /missing order_id/],
    ["a non-string order_id", { order_id: 42 }, /missing order_id/],
  ])("skips rather than throws on %s", (_name, over, expected) => {
    // Never thrown: the same payload arrives on every redelivery, so throwing would burn
    // the retry budget without ever succeeding, and the invoice exists upstream regardless.
    const read = readInvoiceIssued(issued(over));

    expect(isSkipped(read)).toBe(true);
    expect(isSkipped(read) ? read.skip : "").toMatch(expected);
  });

  it("names both missing ids at once", () => {
    const read = readInvoiceIssued({ pdf_available: true });

    expect(isSkipped(read) ? read.skip : "").toBe("payload is missing order_id and invoice_uuid");
  });

  it.each([[undefined], [null], ["a string"], [42]])("skips a %p payload", (data) => {
    const read = readInvoiceIssued(data);

    expect(isSkipped(read)).toBe(true);
    expect(isSkipped(read) ? read.skip : "").toMatch(/not an object/);
  });

  it("keeps going without an invoice number", () => {
    // Dedupe is weaker without it - see the fallback in the attach path - but an invoice
    // with no number recorded is still an invoice the buyer needs on the order.
    const read = readInvoiceIssued(issued({ invoice_number: null }));

    expect(isSkipped(read)).toBe(false);
    expect(isSkipped(read) ? undefined : read.invoiceNumber).toBeUndefined();
  });

  it("honours pdf_available: false as nothing to attach yet", () => {
    const read = readInvoiceIssued(issued({ pdf_available: false }));

    expect(isSkipped(read) ? read.skip : "").toMatch(/no PDF available yet/);
  });

  it("treats an absent pdf_available as available", () => {
    // Absence must not stop the chain: the emitter sends `true`, and reading a missing
    // field as "no PDF" would silently break the chain against an emitter that drops it.
    expect(isSkipped(readInvoiceIssued(issued({ pdf_available: undefined })))).toBe(false);
  });

  it("pins the event name both plugins agree on", () => {
    expect(INVOICE_ISSUED_EVENT).toBe("infakt.invoice.issued");
  });
});

describe("findRegisteredInvoice", () => {
  it("finds the document already registered under this number", () => {
    // THE dedupe guard. Without it a redelivered event puts a second invoice document on
    // a real order, because Allegro's create takes no idempotency key.
    const found = findRegisteredInvoice(
      [
        invoice({ id: "inv-0", invoiceNumber: "FV/2026/07/999" }),
        invoice({ id: "inv-1", invoiceNumber: "FV/2026/08/001" }),
      ],
      "FV/2026/08/001",
    );

    expect(found?.id).toBe("inv-1");
  });

  it("matches across incidental whitespace", () => {
    const found = findRegisteredInvoice(
      [invoice({ id: "inv-1", invoiceNumber: " FV/1 " })],
      "FV/1",
    );

    expect(found?.id).toBe("inv-1");
  });

  it("does not match a different number", () => {
    expect(
      findRegisteredInvoice(
        [invoice({ id: "inv-1", invoiceNumber: "FV/2026/08/002" })],
        "FV/2026/08/001",
      ),
    ).toBeUndefined();
  });

  it("does not match a document Allegro reported without a number", () => {
    // An invoice attached outside this plugin can have no number. Treating that as a match
    // would make the attach silently upload over somebody else's document.
    expect(findRegisteredInvoice([invoice({ id: "inv-1" })], "FV/1")).toBeUndefined();
  });

  it("handles an order with no invoices at all", () => {
    expect(findRegisteredInvoice(undefined, "FV/1")).toBeUndefined();
    expect(findRegisteredInvoice([], "FV/1")).toBeUndefined();
  });

  it("never matches on a blank number", () => {
    expect(
      findRegisteredInvoice([invoice({ id: "inv-1", invoiceNumber: "" })], "  "),
    ).toBeUndefined();
  });
});

describe("invoiceFileName", () => {
  it("makes a Polish invoice number safe as a filename", () => {
    // `FV/2026/08/001` contains path separators, which a filename cannot carry.
    expect(invoiceFileName("FV/2026/08/001")).toBe("FV_2026_08_001.pdf");
  });

  it("keeps the number readable for a buyer with several invoices", () => {
    expect(invoiceFileName("FV-2026-08-001")).toBe("FV-2026-08-001.pdf");
  });

  it("collapses a run of unsafe characters into one underscore", () => {
    expect(invoiceFileName("FV // 1")).toBe("FV_1.pdf");
  });

  it("falls back to a usable name rather than a bare extension", () => {
    expect(invoiceFileName("///")).toBe("invoice.pdf");
    expect(invoiceFileName("  ")).toBe("invoice.pdf");
  });
});

describe("rejectInvoicePdf", () => {
  it("accepts a PDF inside the limit", () => {
    expect(rejectInvoicePdf(1)).toBeUndefined();
    expect(rejectInvoicePdf(ALLEGRO_INVOICE_MAX_BYTES)).toBeUndefined();
  });

  it("rejects one byte over the limit", () => {
    const rejected = rejectInvoicePdf(ALLEGRO_INVOICE_MAX_BYTES + 1);

    expect(rejected).toMatch(/over Allegro's/);
    // The size is in the message: the operator's next question is "by how much?", and the
    // answer decides whether the fix is a template change or a broken generator.
    expect(rejected).toContain(String(ALLEGRO_INVOICE_MAX_BYTES + 1));
  });

  it("rejects an empty PDF", () => {
    // Allegro accepts a zero-byte upload, and the buyer then downloads nothing - worse
    // than a recorded failure, because it looks attached.
    expect(rejectInvoicePdf(0)).toMatch(/empty/);
  });
});

describe("attachErrorLine", () => {
  it("prefixes the failure so a human can see which subsystem it came from", () => {
    expect(attachErrorLine("Allegro is not connected")).toBe(
      `${ATTACH_ERROR_PREFIX}: Allegro is not connected`,
    );
  });
});

/**
 * An `AllegroApiError` as the client builds one, structurally.
 *
 * Built here rather than imported so these stay pure decision tests: the formatter reads
 * `httpStatus`, `message`, `errors`, `raw` and `requestId`, and nothing about the class.
 */
const allegroFailure = (over: Partial<Parameters<typeof describeAllegroErrors>[0]> = {}) => ({
  errors: [],
  httpStatus: 400,
  message: "Bad Request",
  ...over,
});

describe("describeAllegroErrors", () => {
  it("renders every field of every entry, not just the first message", () => {
    // The production loss: `AllegroApiError.message` is only `errors[0].userMessage` (or
    // `message`), and for a 400 that string is routinely the generic "Bad Request" - while
    // the code and the path that name the offending field go unread.
    const rendered = describeAllegroErrors(
      allegroFailure({
        errors: [
          {
            code: "InvoiceNumberInvalid",
            message: "Bad Request",
            path: "invoiceNumber",
            userMessage: "The invoice number has an unsupported format.",
          },
          { code: "SecondProblem", message: "Something else" },
        ],
      }),
    );

    expect(rendered).toContain("code=InvoiceNumberInvalid");
    expect(rendered).toContain("path=invoiceNumber");
    expect(rendered).toContain("The invoice number has an unsupported format.");
    expect(rendered).toContain("SecondProblem");
  });

  it("does not repeat a userMessage identical to the message", () => {
    const rendered = describeAllegroErrors(
      allegroFailure({ errors: [{ message: "Bad Request", userMessage: "Bad Request" }] }),
    );

    expect(rendered.match(/Bad Request/gu)).toHaveLength(1);
  });

  it("falls back to the raw body when there is no structured errors[]", () => {
    // Allegro also answers `{ error, error_description }` on some paths, and its gateway
    // answers plain text. Either beats "something went wrong".
    expect(
      describeAllegroErrors(
        allegroFailure({ raw: { error: "invalid_request", error_description: "no scope" } }),
      ),
    ).toContain("invalid_request");
    expect(describeAllegroErrors(allegroFailure({ raw: "  <html>Bad Request</html>  " }))).toBe(
      "<html>Bad Request</html>",
    );
  });

  it("says so rather than lying when Allegro sent no body", () => {
    expect(describeAllegroErrors(allegroFailure())).toBe("Allegro returned no error body.");
  });

  it("bounds what a remote body can push through the logger", () => {
    const rendered = describeAllegroErrors(allegroFailure({ raw: "x".repeat(5000) }));

    expect(rendered.length).toBeLessThan(MAX_ALLEGRO_ERROR_CHARS + 40);
    expect(rendered).toContain("more)");
  });
});

describe("describeAttachFailure", () => {
  it("names which of the four calls failed", () => {
    // "Allegro rejected the invoice attachment" was true of three different requests that
    // fail for entirely different reasons, and the log named none of them.
    expect(describeAttachFailure("create", allegroFailure())).toContain(
      "registering the invoice document",
    );
    expect(describeAttachFailure("upload", allegroFailure())).toContain(
      "uploading the invoice file",
    );
    expect(describeAttachFailure("list", allegroFailure())).toContain(
      "reading the documents already on the Allegro order",
    );
    expect(describeAttachFailure("pdf", new Error("inFakt timed out"))).toContain(
      "fetching the invoice PDF",
    );
  });

  it("echoes back exactly what this plugin chose to send", () => {
    // The metadata create carries two values and no others, so a rejection of it can only
    // be about one of them. Neither is buyer data.
    const line = describeAttachFailure("create", allegroFailure(), {
      fileName: "5_08_2026.pdf",
      invoiceNumber: "5/08/2026",
      pdfBytes: 42_000,
    });

    expect(line).toContain('file.name="5_08_2026.pdf"');
    expect(line).toContain('invoiceNumber="5/08/2026"');
    expect(line).toContain("pdfBytes=42000");
  });

  it("quotes the x-request-id, which is what Allegro support asks for", () => {
    expect(describeAttachFailure("create", allegroFailure({ requestId: "req-9" }))).toContain(
      "x-request-id: req-9",
    );
  });

  it("reports a transport failure as no response rather than HTTP 0", () => {
    const line = describeAttachFailure(
      "create",
      allegroFailure({ httpStatus: 0, message: "Allegro request failed: fetch failed" }),
    );

    expect(line).toContain("HTTP no response");
    expect(line).not.toContain("HTTP 0");
  });

  it("keeps a plain error readable", () => {
    expect(describeAttachFailure(undefined, new Error("boom"))).toContain("boom");
  });
});

describe("shouldRetryWithoutInvoiceNumber", () => {
  it("retries only a 400, and only when a number was actually sent", () => {
    // `CheckFormsNewOrderInvoice` requires `file` and nothing else, so `invoiceNumber` is
    // the only field of this body whose VALUE can make an otherwise valid request invalid.
    expect(shouldRetryWithoutInvoiceNumber(allegroFailure(), "5/08/2026")).toBe(true);
    expect(shouldRetryWithoutInvoiceNumber(allegroFailure(), undefined)).toBe(false);
    expect(shouldRetryWithoutInvoiceNumber(allegroFailure(), "")).toBe(false);
  });

  it("leaves every other status alone", () => {
    // Each of these means something the retry would destroy: 409 the order already has an
    // invoice, 422 the order will not take one, 403 a missing write scope, 429 too fast.
    for (const httpStatus of [401, 403, 404, 409, 413, 422, 429, 500, 0]) {
      expect(shouldRetryWithoutInvoiceNumber(allegroFailure({ httpStatus }), "5/08/2026")).toBe(
        false,
      );
    }
  });

  it("never fires for something that is not an Allegro rejection at all", () => {
    expect(shouldRetryWithoutInvoiceNumber(new Error("inFakt timed out"), "5/08/2026")).toBe(
      false,
    );
    expect(shouldRetryWithoutInvoiceNumber(undefined, "5/08/2026")).toBe(false);
  });
});
