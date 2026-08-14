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
            { default: false, id: "r1", name: "Rule One", type: "FOLLOW_BY_ALLEGRO_MIN_PRICE" },
            { default: false, id: "r2", name: "Rule Two" },
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
    expect(rules[0]?.name).toBe("Rule One");
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

describe("AllegroClient timeout budget", () => {
  it("arms the abort signal before the refresh, so a hung /token cannot outlast timeoutMs", async () => {
    // The signal handed to the API call has to already be aborted by the time
    // the (slow) refresh returns. If the timer were armed after ensureToken,
    // the refresh would sit outside the budget entirely.
    let apiSignal: AbortSignal | undefined;
    const fetchImpl: FetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/oauth/token")) {
        await sleep(30);
        return tokenResponse();
      }
      apiSignal = init?.signal ?? undefined;
      return apiJson(200, {});
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await c.me();

    expect(apiSignal?.aborted).toBe(true);
  });

  it("passes its timeout down to the OAuth helper it builds", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fetchImpl: FetchMock = jest.fn((url: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, {}));
    });
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await c.me();

    // Both the token request and the API request carry an abort signal.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
  });

  it("keeps an auth failure typed as AllegroAuthError through the send wrapper", async () => {
    // ensureToken now runs inside send's try/catch; without the re-throw an
    // auth failure would be relabelled as a transport error.
    const fetchImpl: FetchMock = jest.fn(() => Promise.resolve(apiJson(200, {})));
    const c = new AllegroClient({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      useClientCredentials: false,
    });

    await expect(c.me()).rejects.toMatchObject({
      code: "no_credentials",
      name: "AllegroAuthError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("AllegroClient token rotation", () => {
  it("hands the persistence hook the refresh token this exchange produced", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(
          Response.json({
            access_token: "NEW",
            expires_in: 43_200,
            refresh_token: "ROTATED",
            scope: "allegro:api:sale:offers:read",
            token_type: "Bearer",
          }),
        );
      }
      return Promise.resolve(apiJson(200, {}));
    });
    const onTokenRefresh = jest.fn();
    const c = new AllegroClient({
      accessToken: "OLD",
      accessTokenExpiresAt: Date.now() - 1000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      onTokenRefresh,
      refreshToken: "ORIGINAL",
    });

    await c.me();

    expect(onTokenRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "NEW",
        refreshToken: "ROTATED",
        scope: "allegro:api:sale:offers:read",
      }),
    );
  });

  it("carries the previous refresh token forward when Allegro omits one", async () => {
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        // No refresh_token in the response.
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve(apiJson(200, {}));
    });
    const onTokenRefresh = jest.fn();
    const c = new AllegroClient({
      accessToken: "OLD",
      accessTokenExpiresAt: Date.now() - 1000,
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl as unknown as typeof fetch,
      onTokenRefresh,
      refreshToken: "ORIGINAL",
    });

    await c.me();

    expect(onTokenRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "AT", refreshToken: "ORIGINAL" }),
    );
    expect(c.getToken()?.refreshToken).toBe("ORIGINAL");
  });

  it("never puts the refresh token in the refresh_rejected message", async () => {
    // The message ends up in logs and in an admin-facing error; a rotated
    // refresh token in it would be a credential leak with a long shelf life.
    const secret = "super-secret-refresh-token-value";
    const fetchImpl: FetchMock = jest.fn((url: string) => {
      if (url.includes("/auth/oauth/token")) {
        return Promise.resolve(
          Response.json(
            { error: "invalid_grant", error_description: "token revoked" },
            { status: 400 },
          ),
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
      refreshToken: secret,
    });

    try {
      await c.me();
      throw new Error("expected me() to throw");
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain("refresh token could not be exchanged");
      expect(message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("AllegroApiError.isSystemic", () => {
  const at = (httpStatus: number) => new AllegroApiError({ httpStatus, message: "x" });

  it("treats a transport failure as systemic", () => {
    // `httpStatus: 0` is how `send` reports DNS failure, connection refused, TLS errors and
    // its own abort timeout. Allegro being unreachable is the textbook systemic condition,
    // and it was the one most likely to quarantine a whole working set: every active item
    // fails together, so without a systemic verdict they all cross the threshold on the same
    // tick and are set aside, each then needing manual repair.
    expect(at(0).isTransportFailure()).toBe(true);
    expect(at(0).isSystemic()).toBe(true);
  });

  it("treats 408 and 401 as systemic", () => {
    // 408 is server-side slowness, indistinguishable in kind from a 5xx. A 401 reaches this
    // class only when there is no refresh token to retry with, so it means the stored
    // connection is dead - true of every item, not of the one it happened to hit.
    expect(at(408).isSystemic()).toBe(true);
    expect(at(401).isSystemic()).toBe(true);
  });

  it("keeps 429 and 5xx systemic", () => {
    expect(at(429).isSystemic()).toBe(true);
    expect(at(500).isSystemic()).toBe(true);
    expect(at(503).isSystemic()).toBe(true);
  });

  it("keeps 403 OUT of systemic, because it is the write-scope gap", () => {
    // Only the command paths know to read a 403 as a missing offer-write scope, and they
    // handle it as its own circuit-breaker condition with a reconnect banner.
    expect(at(403).isForbidden()).toBe(true);
    expect(at(403).isSystemic()).toBe(false);
  });

  it("keeps ordinary client errors per-item", () => {
    // These really are about the item: a 400 or a 404 on one offer says nothing about the
    // pipeline, so the streak SHOULD grow toward quarantine.
    expect(at(400).isSystemic()).toBe(false);
    expect(at(404).isSystemic()).toBe(false);
    expect(at(422).isSystemic()).toBe(false);
  });
});
