import { AllegroClient } from "../client";
import { AllegroApiError } from "../errors";

type FetchMock = ReturnType<typeof jest.fn>;

const apiJson = (status: number, body: unknown): Response =>
  Response.json(body, {
    headers: { "content-type": "application/vnd.allegro.public.v1+json" },
    status,
  });

const client = (fetchImpl: FetchMock): AllegroClient =>
  new AllegroClient({
    accessToken: "AT",
    accessTokenExpiresAt: Date.now() + 60_000,
    appName: "TestApp",
    appVersion: "1.0",
    clientId: "cid",
    clientSecret: "sec",
    docsUrl: "https://example.com/docs",
    fetch: fetchImpl as unknown as typeof fetch,
  });

describe("assignOfferPriceAutomation", () => {
  it("POSTs a single-offer set command with the rule id + bounds", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(201, { completedAt: null, id: "cmd-1" })),
    );
    const report = await client(fetchImpl).assignOfferPriceAutomation({
      bounds: {
        max: { amount: "233.21", currency: "PLN" },
        min: { amount: "100.45", currency: "PLN" },
      },
      commandId: "fixed-uuid",
      offerId: "off-1",
      ruleId: "rule-1",
    });

    expect(report.id).toBe("cmd-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sale/offer-price-automation-commands");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "fixed-uuid",
      modification: {
        set: [
          {
            configuration: {
              priceRange: {
                maxPrice: { amount: "233.21", currency: "PLN" },
                minPrice: { amount: "100.45", currency: "PLN" },
                type: "MARKETPLACE_CURRENCY",
              },
            },
            marketplace: { id: "allegro-pl" },
            rule: { id: "rule-1" },
          },
        ],
      },
      // configuration is a sibling of rule on the set item (swagger).
      offerCriteria: [{ offers: [{ id: "off-1" }], type: "CONTAINS_OFFERS" }],
    });
  });

  it("omits the configuration when no bounds are supplied", async () => {
    const fetchImpl: FetchMock = jest.fn(() => Promise.resolve(apiJson(201, { id: "cmd-2" })));
    await client(fetchImpl).assignOfferPriceAutomation({
      commandId: "u",
      offerId: "off-2",
      ruleId: "rule-2",
    });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.modification.set[0].configuration).toBeUndefined();
  });

  it("surfaces a 403 as a forbidden (write-scope-gap) error", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(403, { errors: [{ message: "Forbidden" }] })),
    );
    await expect(
      client(fetchImpl).assignOfferPriceAutomation({ offerId: "o", ruleId: "r" }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    try {
      await client(
        jest.fn(() => Promise.resolve(apiJson(403, {}))) as FetchMock,
      ).assignOfferPriceAutomation({ offerId: "o", ruleId: "r" });
    } catch (error) {
      expect(error).toBeInstanceOf(AllegroApiError);
      expect((error as AllegroApiError).isForbidden()).toBe(true);
      expect((error as AllegroApiError).isSystemic()).toBe(false);
    }
  });
});

describe("pollOfferPriceAutomationCommand", () => {
  it("polls until completedAt is set, then returns the terminal report", async () => {
    const reports = [
      { completedAt: null, id: "cmd-9" },
      { completedAt: null, id: "cmd-9" },
      {
        completedAt: "2026-08-03T00:00:00Z",
        id: "cmd-9",
        taskCount: { failed: 0, success: 1, total: 1 },
      },
    ];
    let call = 0;
    const fetchImpl: FetchMock = jest.fn(() => {
      const body = reports[Math.min(call, reports.length - 1)];
      call += 1;
      return Promise.resolve(apiJson(200, body));
    });
    const sleep = jest.fn(() => Promise.resolve());

    const report = await client(fetchImpl).pollOfferPriceAutomationCommand("cmd-9", {
      intervalMs: 1,
      sleep,
      timeoutMs: 10_000,
    });

    expect(report.completedAt).toBe("2026-08-03T00:00:00Z");
    expect(report.taskCount).toEqual({ failed: 0, success: 1, total: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats a full task tally as terminal even without completedAt", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(200, { id: "c", taskCount: { failed: 1, success: 0, total: 1 } })),
    );
    const report = await client(fetchImpl).pollOfferPriceAutomationCommand("c", {
      sleep: () => Promise.resolve(),
    });
    expect(report.taskCount?.failed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the last non-terminal report when the budget is exhausted", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(200, { completedAt: null, id: "c" })),
    );
    const report = await client(fetchImpl).pollOfferPriceAutomationCommand("c", {
      intervalMs: 5,
      sleep: () => Promise.resolve(),
      timeoutMs: 12,
    });
    expect(report.completedAt).toBeNull();
  });
});

describe("removeOfferPriceAutomation", () => {
  it("POSTs a single-offer remove command, scoped by marketplace and carrying no rule", async () => {
    // An offer holds at most one rule per marketplace, so removal names the
    // marketplace and Allegro removes whichever rule is there.
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(201, { completedAt: null, id: "cmd-rm" })),
    );

    const report = await client(fetchImpl).removeOfferPriceAutomation({
      commandId: "fixed-uuid",
      marketplaceId: "allegro-cz",
      offerId: "off-1",
    });

    expect(report.id).toBe("cmd-rm");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sale/offer-price-automation-commands");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "fixed-uuid",
      modification: { remove: [{ marketplace: { id: "allegro-cz" } }] },
      offerCriteria: [{ offers: [{ id: "off-1" }], type: "CONTAINS_OFFERS" }],
    });
  });

  it("defaults to the PL marketplace, like the assignment does", async () => {
    const fetchImpl: FetchMock = jest.fn(() => Promise.resolve(apiJson(201, { id: "cmd-rm" })));

    await client(fetchImpl).removeOfferPriceAutomation({ commandId: "u", offerId: "off-2" });

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.modification.remove[0].marketplace.id).toBe("allegro-pl");
  });
});

describe("changeOfferPrice", () => {
  it("PUTs a FIXED_PRICE modification on the command id", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(201, { completedAt: null, id: "cmd-price" })),
    );

    const report = await client(fetchImpl).changeOfferPrice({
      commandId: "fixed-uuid",
      marketplaceId: "allegro-pl",
      offerId: "off-1",
      price: { amount: "300.00", currency: "PLN" },
    });

    expect(report.id).toBe("cmd-price");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // The command id is the PATH, not a body field: this resource is a PUT.
    expect(url).toContain("/sale/offer-price-change-commands/fixed-uuid");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      modification: {
        marketplaceId: "allegro-pl",
        price: { amount: "300.00", currency: "PLN" },
        type: "FIXED_PRICE",
      },
      offerCriteria: [{ offers: [{ id: "off-1" }], type: "CONTAINS_OFFERS" }],
    });
  });

  it("omits the marketplace, which Allegro reads as the offer's base marketplace", async () => {
    const fetchImpl: FetchMock = jest.fn(() => Promise.resolve(apiJson(201, { id: "c" })));

    await client(fetchImpl).changeOfferPrice({
      commandId: "u",
      offerId: "off-2",
      price: { amount: "10.00", currency: "PLN" },
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.modification.marketplaceId).toBeUndefined();
  });

  it("surfaces a 403 as a forbidden (write-scope-gap) error, like every other write", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(403, { errors: [{ message: "Forbidden" }] })),
    );

    await expect(
      client(fetchImpl).changeOfferPrice({
        commandId: "u",
        offerId: "off-3",
        price: { amount: "10.00", currency: "PLN" },
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      client(fetchImpl).changeOfferPrice({
        commandId: "u",
        offerId: "off-3",
        price: { amount: "10.00", currency: "PLN" },
      }),
    ).rejects.toBeInstanceOf(AllegroApiError);
  });

  it("polls the price command to terminal, on its own resource", async () => {
    const fetchImpl: FetchMock = jest
      .fn()
      .mockResolvedValueOnce(apiJson(200, { completedAt: null, id: "c" }))
      .mockResolvedValueOnce(
        apiJson(200, {
          completedAt: "2026-06-01T00:00:00.000Z",
          id: "c",
          taskCount: { failed: 0, success: 1, total: 1 },
        }),
      );

    const report = await client(fetchImpl).pollOfferPriceChangeCommand("c", {
      sleep: () => Promise.resolve(),
    });

    expect(report.completedAt).toBe("2026-06-01T00:00:00.000Z");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/sale/offer-price-change-commands/c");
  });
});
