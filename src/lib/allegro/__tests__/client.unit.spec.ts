import { setTimeout as sleep } from "node:timers/promises";
import { AllegroClient } from "../client";
import { AllegroApiError } from "../errors";

type FetchMock = ReturnType<typeof jest.fn>;

const apiJson = (status: number, body: unknown): Response =>
  Response.json(body, {
    headers: { "content-type": "application/vnd.allegro.public.v1+json" },
    status,
  });

const tokenResponse = (): Response =>
  Response.json({ access_token: "AT", expires_in: 43_200, token_type: "Bearer" });

describe("AllegroClient", () => {
  it("auto-fetches token via client credentials and calls API with Bearer", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, { count: 0, offers: [], totalCount: 0 }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.listOffers({ limit: 10 });
    const { calls } = fetchImpl.mock;
    expect(calls[0]?.[0]).toContain("/auth/oauth/token");
    expect(calls[1]?.[0]).toContain("/sale/offers");
    expect(calls[1]?.[0]).toContain("limit=10");
    const init = calls[1]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({
      Accept: "application/vnd.allegro.public.v1+json",
      Authorization: "Bearer AT",
      "User-Agent": "TestApp/1.0 (+https://example.com/docs)",
    });
    const tokenInit = calls[0]?.[1] as RequestInit | undefined;
    expect(tokenInit?.headers).toMatchObject({
      "User-Agent": "TestApp/1.0 (+https://example.com/docs)",
    });
  });

  it("uses pre-issued accessToken when supplied and not expired", async () => {
    const fetchImpl: FetchMock = jest.fn(() =>
      Promise.resolve(apiJson(200, { count: 0, offers: [], totalCount: 0 })),
    );
    const c = new AllegroClient({
      accessToken: "PRESET",
      accessTokenExpiresAt: Date.now() + 60_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.listOffers();
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer PRESET",
    });
  });

  it("refreshes via refresh_token when access token is expired", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchMock = jest.fn((url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (url.includes("/auth/oauth/token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return Promise.resolve(
          Response.json({
            access_token: "NEW",
            expires_in: 43_200,
            refresh_token: "NEWRT",
            token_type: "Bearer",
          }),
        );
      }
      return Promise.resolve(apiJson(200, { id: "offer1" }));
    });
    const onRefresh = jest.fn();
    const c = new AllegroClient({
      accessToken: "OLD",
      accessTokenExpiresAt: Date.now() - 1000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      onTokenRefresh: onRefresh,
      refreshToken: "RT",
    });
    await c.getOffer("offer1");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain("/auth/oauth/token");
    expect(c.getToken()?.accessToken).toBe("NEW");
    expect(c.getToken()?.refreshToken).toBe("NEWRT");
  });

  it("throws AllegroApiError with parsed error body", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(400, {
          errors: [{ code: "InvalidInput", message: "bad", userMessage: "Nieprawidłowe dane" }],
        }),
      );
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(c.listOffers()).rejects.toMatchObject({
      httpStatus: 400,
      message: "Nieprawidłowe dane",
      name: "AllegroApiError",
    });
  });

  it("uses sandbox base URL", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, { categories: [] }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      environment: "sandbox",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.getCategories();
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("api.allegro.pl.allegrosandbox.pl");
  });

  it("deduplicates concurrent token refreshes", async () => {
    let tokenCalls = 0;
    const fetchImpl: FetchMock = jest.fn(async (url: string) => {
      if (url.includes("/auth/oauth/token")) {
        tokenCalls += 1;
        await sleep(10);
        return tokenResponse();
      }
      return apiJson(200, {});
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all([c.listOffers(), c.getCategories(), c.me()]);
    expect(tokenCalls).toBe(1);
  });

  it("serializes array query params with repeated keys", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, { count: 0, offers: [], totalCount: 0 }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.listOffers({ publication_status: ["ACTIVE", "ENDED"] });
    const apiUrl = String(fetchImpl.mock.calls[1]?.[0]);
    expect(apiUrl).toContain("publication.status=ACTIVE");
    expect(apiUrl).toContain("publication.status=ENDED");
  });

  it("getOfferPromoOptions reads promo state from /sale/offers (NOT product-offers)", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, { basePackage: { id: "emphasized10d" } }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.getOfferPromoOptions("123");
    const url = String(fetchImpl.mock.calls[1]?.[0]);
    // /sale/product-offers/{id}/promo-options does not exist - Allegro answers
    // "Feature unavailable", which froze promotion sync entirely.
    expect(url).toContain("/sale/offers/123/promo-options");
    expect(url).not.toContain("product-offers");
  });

  it("listSellerPromoOptions pages the batch promo-options resource", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(200, {
          count: 1,
          promoOptions: [{ basePackage: { id: "emphasized10d" }, offerId: "9" }],
          totalCount: 1,
        }),
      );
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const { promoOptions, totalCount } = await c.listSellerPromoOptions({
      limit: 5000,
      offset: 0,
    });
    const url = String(fetchImpl.mock.calls[1]?.[0]);
    expect(url).toContain("/sale/offers/promo-options?");
    expect(url).toContain("limit=5000");
    expect(promoOptions[0]?.offerId).toBe("9");
    expect(totalCount).toBe(1);
  });

  it("updateCheckoutFormFulfillment PUTs the status to the fulfillment resource", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await c.updateCheckoutFormFulfillment("form-1", "SENT");
    const { calls } = fetchImpl.mock;
    expect(String(calls[1]?.[0])).toContain("/order/checkout-forms/form-1/fulfillment");
    const init = calls[1]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ status: "SENT" }));
  });

  it("returns undefined on 204", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const out = await c.delete("/sale/offers/x");
    expect(out).toBeUndefined();
  });

  it("listOrderEvents pages the journal with from/limit/type", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(200, {
          events: [
            {
              id: "evt-2",
              occurredAt: "2026-07-27T10:00:00Z",
              order: { checkoutForm: { id: "form-9" } },
              type: "FULFILLMENT_STATUS_CHANGED",
            },
          ],
        }),
      );
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const { events } = await c.listOrderEvents({
      from: "evt-1",
      limit: 100,
      type: ["FULFILLMENT_STATUS_CHANGED", "READY_FOR_PROCESSING"],
    });
    const url = String(fetchImpl.mock.calls[1]?.[0]);
    expect(url).toContain("/order/events?");
    expect(url).toContain("from=evt-1");
    expect(url).toContain("limit=100");
    expect(url).toContain("type=FULFILLMENT_STATUS_CHANGED");
    expect(url).toContain("type=READY_FOR_PROCESSING");
    expect(events[0]?.order?.checkoutForm?.id).toBe("form-9");
  });

  it("getOrderEventStats reads the newest event id", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(200, { latestEvent: { id: "evt-99", occurredAt: "2026-07-27T10:00:00Z" } }),
      );
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const stats = await c.getOrderEventStats();
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/order/event-stats");
    expect(stats.latestEvent?.id).toBe("evt-99");
  });

  it("retries once with a refreshed token when a live token gets a 401", async () => {
    // Allegro can invalidate a token before it expires (consent withdrawn,
    // rotated elsewhere); without the retry the caller fails forever.
    const seen: string[] = [];
    let apiCalls = 0;
    const fetchImpl: FetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/oauth/token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return Promise.resolve(
          Response.json({ access_token: "FRESH", expires_in: 43_200, token_type: "Bearer" }),
        );
      }
      apiCalls += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(String(headers.Authorization));
      if (apiCalls === 1) {
        return Promise.resolve(apiJson(401, { error: "invalid_token" }));
      }
      return Promise.resolve(apiJson(200, { events: [] }));
    });
    const c = new AllegroClient({
      accessToken: "STALE",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      refreshToken: "RT",
    });
    const { events } = await c.listOrderEvents({ from: "evt-1" });
    expect(events).toEqual([]);
    expect(apiCalls).toBe(2);
    expect(seen).toEqual(["Bearer STALE", "Bearer FRESH"]);
  });

  it("retries a 401 only once", async () => {
    let apiCalls = 0;
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(
          Response.json({ access_token: "FRESH", expires_in: 43_200, token_type: "Bearer" }),
        );
      }
      apiCalls += 1;
      return Promise.resolve(apiJson(401, { errors: [{ message: "still no" }] }));
    });
    const c = new AllegroClient({
      accessToken: "STALE",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      refreshToken: "RT",
    });
    await expect(c.listOrderEvents()).rejects.toMatchObject({
      httpStatus: 401,
      name: "AllegroApiError",
    });
    expect(apiCalls).toBe(2);
  });

  it("surfaces a distinct auth error when the 401 refresh is rejected", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(
          Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }),
        );
      }
      return Promise.resolve(apiJson(401, { error: "invalid_token" }));
    });
    const c = new AllegroClient({
      accessToken: "STALE",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      refreshToken: "RT",
    });
    await expect(c.listOrderEvents()).rejects.toMatchObject({
      code: "refresh_rejected",
      name: "AllegroAuthError",
    });
  });

  it("does not retry a 401 without a refresh token", async () => {
    let apiCalls = 0;
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      apiCalls += 1;
      return Promise.resolve(apiJson(401, { errors: [{ message: "no scope" }] }));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(c.listOrderEvents()).rejects.toMatchObject({
      httpStatus: 401,
      name: "AllegroApiError",
    });
    expect(apiCalls).toBe(1);
  });

  it("lists price-automation rules from /sale/price-automation/rules", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(200, {
          rules: [
            { default: false, id: "r1", name: "Bitdefender", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" },
            { default: false, id: "r2", name: "Bitdefender Sale" },
          ],
        }),
      );
    });
    const c = new AllegroClient({
      accessToken: "AT",
      accessTokenExpiresAt: Date.now() + 60_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const { rules } = await c.listPriceAutomationRules();
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/sale/price-automation/rules");
    expect(rules).toHaveLength(2);
    expect(rules[0]?.name).toBe("Bitdefender");
  });

  it("reads a single offer's attached price-automation rule + status", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        apiJson(200, {
          id: "offer1",
          publication: { status: "ACTIVE" },
          sellingMode: {
            priceAutomation: { rule: { id: "r1", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" } },
          },
        }),
      );
    });
    const c = new AllegroClient({
      accessToken: "AT",
      accessTokenExpiresAt: Date.now() + 60_000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const state = await c.getOfferPriceAutomation("offer1");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/sale/product-offers/offer1");
    expect(state).toEqual({
      offerId: "offer1",
      rule: { id: "r1", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" },
      status: "ACTIVE",
    });
  });

  it("classifies rate-limit (429) and server (>=500) errors as systemic", () => {
    const rateLimit = new AllegroApiError({ httpStatus: 429, message: "Too Many Requests" });
    const server = new AllegroApiError({ httpStatus: 503, message: "Service Unavailable" });
    const badInput = new AllegroApiError({ httpStatus: 400, message: "Bad Request" });
    expect(rateLimit.isRateLimit()).toBe(true);
    expect(rateLimit.isSystemic()).toBe(true);
    expect(server.isServerError()).toBe(true);
    expect(server.isSystemic()).toBe(true);
    expect(badInput.isRateLimit()).toBe(false);
    expect(badInput.isServerError()).toBe(false);
    expect(badInput.isSystemic()).toBe(false);
  });

  it("AllegroApiError preserves request id", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(
        Response.json(
          { errors: [{ message: "x" }] },
          {
            headers: {
              "content-type": "application/vnd.allegro.public.v1+json",
              "x-request-id": "req-123",
            },
            status: 500,
          },
        ),
      );
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await c.listOffers();
      throw new Error("expected listOffers to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AllegroApiError);
      expect((error as AllegroApiError).requestId).toBe("req-123");
    }
  });
});
