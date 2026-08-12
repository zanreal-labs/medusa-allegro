import { ALLEGRO_INVOICE_MAX_BYTES } from "../../allegro/types";
import type { CheckoutFormInvoice } from "../../allegro/types";
import {
  ATTACH_ERROR_PREFIX,
  attachErrorLine,
  findRegisteredInvoice,
  invoiceFileName,
  INVOICE_ISSUED_EVENT,
  isSkipped,
  readInvoiceIssued,
  rejectInvoicePdf,
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
