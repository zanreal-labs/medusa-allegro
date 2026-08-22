import { AllegroClient } from "../client";
import { AllegroApiError } from "../errors";
import { ALLEGRO_INVOICE_MAX_BYTES, ALLEGRO_MAX_INVOICES_PER_ORDER } from "../types";

type FetchMock = ReturnType<typeof jest.fn>;

/**
 * The three invoice-attachment calls, pinned at the wire.
 *
 * Every assertion here is about a detail that Allegro accepts silently when it is
 * wrong, which is what makes them worth a test rather than a read-through:
 *
 * - the PDF must reach fetch as the SAME object it was handed. A
 *   `JSON.stringify`'d `Uint8Array` is the string `{}`, and Allegro returns 2xx for
 *   it - the order then carries an invoice document with a two-byte file, and
 *   nothing anywhere reports a failure.
 * - `Content-Type: application/pdf` on the upload, but the vendor media type on
 *   `Accept` and on the JSON create. One header per call is what distinguishes the
 *   binary endpoint from every other endpoint in the client.
 * - the create returns the id the upload path depends on, and a 4xx has to arrive
 *   as `AllegroApiError` so the caller can record Allegro's own message rather than
 *   "something went wrong".
 */

const MEDIA_TYPE = "application/vnd.allegro.public.v1+json";

const apiJson = (status: number, body: unknown): Response =>
  Response.json(body, { headers: { "content-type": MEDIA_TYPE }, status });

const tokenResponse = (): Response =>
  Response.json({ access_token: "AT", expires_in: 43_200, token_type: "Bearer" });

const clientWith = (fetchImpl: FetchMock): AllegroClient =>
  new AllegroClient({
    appName: "TestApp",
    appVersion: "1.0",
    clientId: "cid",
    clientSecret: "sec",
    docsUrl: "https://example.com/docs",
    fetch: fetchImpl as unknown as typeof fetch,
  });

/** Answers the token call, then the API call with `apiResponse`. */
const stubFetch = (apiResponse: () => Response): FetchMock =>
  jest.fn((url: string) =>
    Promise.resolve(url.includes("/auth/oauth/token") ? tokenResponse() : apiResponse()),
  );

describe("checkout-form invoice documents", () => {
  it("getCheckoutFormInvoices reads the order's invoice list", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, {
        hasExternalInvoices: false,
        invoices: [{ createdAt: "2026-08-12T09:00:00Z", id: "inv-1", invoiceNumber: "FV/1/2026" }],
      }),
    );
    const listed = await clientWith(fetchImpl).getCheckoutFormInvoices("form-1");

    expect(listed.invoices?.[0]?.invoiceNumber).toBe("FV/1/2026");
    const { calls } = fetchImpl.mock;
    expect(String(calls[1]?.[0])).toContain("/order/checkout-forms/form-1/invoices");
    const init = calls[1]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("GET");
    // A GET carries no body and therefore no Content-Type at all.
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });

  it("createCheckoutFormInvoice POSTs the metadata as JSON on the vendor media type", async () => {
    const fetchImpl = stubFetch(() => apiJson(201, { id: "inv-1" }));
    const created = await clientWith(fetchImpl).createCheckoutFormInvoice("form-1", {
      file: { name: "FV_2026_08_001.pdf" },
      invoiceNumber: "FV/2026/08/001",
    });

    expect(created.id).toBe("inv-1");
    const { calls } = fetchImpl.mock;
    expect(String(calls[1]?.[0])).toContain("/order/checkout-forms/form-1/invoices");
    const init = calls[1]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    // The JSON path is unchanged by `rawBody` existing: still stringified, still the
    // vendor media type on both headers.
    expect(init?.body).toBe(
      JSON.stringify({ file: { name: "FV_2026_08_001.pdf" }, invoiceNumber: "FV/2026/08/001" }),
    );
    expect(init?.headers).toMatchObject({
      Accept: MEDIA_TYPE,
      Authorization: "Bearer AT",
      "Content-Type": MEDIA_TYPE,
      "User-Agent": "TestApp/1.0 (+https://example.com/docs)",
    });
  });

  it("uploadCheckoutFormInvoiceFile PUTs the raw bytes with application/pdf", async () => {
    const fetchImpl = stubFetch(() => new Response(null, { status: 204 }));
    // "%PDF" magic bytes.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const out = await clientWith(fetchImpl).uploadCheckoutFormInvoiceFile("form-1", "inv-1", pdf);

    expect(out).toBeUndefined();
    const { calls } = fetchImpl.mock;
    expect(String(calls[1]?.[0])).toContain("/order/checkout-forms/form-1/invoices/inv-1/file");
    const init = calls[1]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PUT");
    // Identity, not equality: the bytes must be passed through verbatim. A
    // stringified Uint8Array is "{}", which Allegro accepts.
    expect(init?.body).toBe(pdf);
    expect(init?.headers).toMatchObject({
      // Accept stays the vendor media type - only the request body is a PDF.
      Accept: MEDIA_TYPE,
      Authorization: "Bearer AT",
      "Content-Type": "application/pdf",
      "User-Agent": "TestApp/1.0 (+https://example.com/docs)",
    });
  });

  it("percent-encodes both path segments of the upload", async () => {
    const fetchImpl = stubFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchImpl).uploadCheckoutFormInvoiceFile(
      "form/1",
      "inv 1",
      new Uint8Array([1]),
    );

    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/order/checkout-forms/form%2F1/invoices/inv%201/file",
    );
  });

  it("surfaces Allegro's own message when a create is rejected", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(422, {
        errors: [{ code: "TooManyInvoices", userMessage: "Maksymalna liczba faktur to 10." }],
      }),
    );

    await expect(
      clientWith(fetchImpl).createCheckoutFormInvoice("form-1", { file: { name: "x.pdf" } }),
    ).rejects.toThrow(AllegroApiError);
    await expect(
      clientWith(fetchImpl).createCheckoutFormInvoice("form-1", { file: { name: "x.pdf" } }),
    ).rejects.toThrow("Maksymalna liczba faktur to 10.");
  });

  it("asks for English error messages on all three calls", () => {
    // `Accept-Language` is a documented parameter of every invoice endpoint and `en-US` is
    // the only value its schema enumerates. It decides the language of
    // `errors[].userMessage`, which is what a rejection recorded on `allegro_order` is
    // made of - without it a 400 arrives in Polish inside an otherwise English log.
    return Promise.all(
      [
        (client: AllegroClient) => client.getCheckoutFormInvoices("form-1"),
        (client: AllegroClient) =>
          client.createCheckoutFormInvoice("form-1", { file: { name: "x.pdf" } }),
        (client: AllegroClient) =>
          client.uploadCheckoutFormInvoiceFile("form-1", "inv-1", new Uint8Array([1])),
      ].map(async (call) => {
        const fetchImpl = stubFetch(() => apiJson(200, { invoices: [] }));
        await call(clientWith(fetchImpl));
        expect(
          (fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.headers,
        ).toMatchObject({ "Accept-Language": "en-US" });
      }),
    );
  });

  it("states Allegro's documented limits as constants", () => {
    // The size guard and the per-order ceiling are decisions callers make BEFORE
    // calling, so both live with the types rather than in a caller's head.
    expect(ALLEGRO_INVOICE_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(ALLEGRO_MAX_INVOICES_PER_ORDER).toBe(10);
  });
});
