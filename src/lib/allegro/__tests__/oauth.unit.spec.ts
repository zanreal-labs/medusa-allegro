import { AllegroOAuth } from "../oauth";

describe("AllegroOAuth", () => {
  it("requires credentials", () => {
    expect(
      () =>
        new AllegroOAuth({
          appName: "TestApp",
          appVersion: "1.0",
          clientId: "",
          clientSecret: "",
          docsUrl: "https://example.com/docs",
        }),
    ).toThrow();
  });

  it("builds authorization URL with all params", () => {
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
    });
    const url = o.buildAuthorizationUrl({
      prompt: "confirm",
      redirectUri: "https://example.com/cb",
      scope: "allegro:api:sale:offers:read",
      state: "xyz",
    });
    expect(url).toContain("https://allegro.pl/auth/oauth/authorize");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcb");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=xyz");
    expect(url).toContain("prompt=confirm");
    expect(url).toContain("scope=allegro%3Aapi%3Asale%3Aoffers%3Aread");
  });

  it("uses sandbox URL when configured", () => {
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      environment: "sandbox",
    });
    const url = o.buildAuthorizationUrl({ redirectUri: "https://x/y" });
    expect(url).toContain("allegrosandbox.pl");
  });

  it("client credentials grant POSTs to /token with Basic auth", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ access_token: "AT", expires_in: 43_200, token_type: "Bearer" }),
      ),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });
    const out = await o.clientCredentials("allegro:api:sale:offers:read");
    expect(out.access_token).toBe("AT");
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toContain("/auth/oauth/token");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("cid:sec").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(String((init as RequestInit).body)).toContain("grant_type=client_credentials");
  });

  it("exchangeCode sends authorization_code grant", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          access_token: "AT",
          expires_in: 43_200,
          refresh_token: "RT",
          token_type: "Bearer",
        }),
      ),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });
    const out = await o.exchangeCode("CODE", "https://x/y");
    expect(out.refresh_token).toBe("RT");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = String(init?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=CODE");
    expect(body).toContain("redirect_uri=https%3A%2F%2Fx%2Fy");
  });

  it("throws AllegroAuthError on OAuth error body", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ error: "invalid_grant", error_description: "bad code" }, { status: 400 }),
      ),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });
    await expect(o.exchangeCode("X", "https://x/y")).rejects.toMatchObject({
      code: "invalid_grant",
      name: "AllegroAuthError",
    });
  });

  it("reports an unparseable token response as invalid_response", async () => {
    // The body is parsed before the status is checked, so an HTML error page
    // from a proxy surfaces as invalid_response rather than the HTTP status.
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("<html>502</html>", { status: 502 })),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });

    await expect(o.clientCredentials()).rejects.toMatchObject({
      code: "invalid_response",
      name: "AllegroAuthError",
    });
  });

  it("falls back to a generic message when the error body names no error", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json({}, { status: 500 })),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });

    await expect(o.clientCredentials()).rejects.toMatchObject({
      code: "token_request_failed",
      name: "AllegroAuthError",
    });
  });

  it("encodes Basic auth without Buffer, for browser and edge runtimes", async () => {
    // `btoa` only accepts latin1, so the UTF-8 bytes of a non-ASCII secret have
    // to be widened one char per byte first; a naive `btoa(raw)` throws.
    const expected = Buffer.from("cid-ż:sekret-ół", "utf-8").toString("base64");
    // Hand-rolled: undici's Response needs Buffer both to build and to read.
    const response = {
      json: () => Promise.resolve({ access_token: "AT", expires_in: 43_200 }),
      ok: true,
      status: 200,
    } as unknown as Response;
    const spy = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve(response));

    // The explicit `undefined` is the point: `typeof Buffer` has to read
    // "undefined" for the hand-rolled btoa branch to be exercised.
    const realBuffer = globalThis.Buffer;
    (globalThis as { Buffer?: typeof Buffer }).Buffer = undefined;
    try {
      const o = new AllegroOAuth({
        appName: "TestApp",
        appVersion: "1.0",
        clientId: "cid-ż",
        clientSecret: "sekret-ół",
        docsUrl: "https://example.com/docs",
        fetch: spy as unknown as typeof fetch,
      });
      await o.clientCredentials();
    } finally {
      (globalThis as { Buffer?: typeof Buffer }).Buffer = realBuffer;
    }

    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({ Authorization: `Basic ${expected}` });
  });

  it("omits the scope from a client-credentials body when none was asked for", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json({ access_token: "AT", expires_in: 43_200 })),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });

    await o.clientCredentials();

    expect(String(spy.mock.calls[0]?.[1]?.body)).toBe("grant_type=client_credentials");
  });

  it("refreshes with and without a redirect_uri", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json({ access_token: "AT2", expires_in: 43_200 })),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });

    await o.refresh("RT");
    await o.refresh("RT", "https://x/y");

    expect(String(spy.mock.calls[0]?.[1]?.body)).toBe("grant_type=refresh_token&refresh_token=RT");
    expect(String(spy.mock.calls[1]?.[1]?.body)).toContain("redirect_uri=https%3A%2F%2Fx%2Fy");
  });

  it("exposes the composed User-Agent it sends", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json({ access_token: "AT", expires_in: 1 })),
    );
    const o = new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: spy as unknown as typeof fetch,
    });

    await o.clientCredentials();

    expect(spy.mock.calls[0]?.[1]?.headers).toMatchObject({ "User-Agent": o.getUserAgent() });
    expect(o.getUserAgent()).toContain("TestApp");
  });
});

describe("AllegroOAuth.revoke", () => {
  const oauth = (fetchImpl: typeof fetch) =>
    new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl,
    });

  it("posts the token to /revoke, with the hint when given", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await oauth(spy as unknown as typeof fetch).revoke("TOKEN", "refresh_token");

    expect(spy.mock.calls[0]?.[0]).toContain("/auth/oauth/revoke");
    const body = String(spy.mock.calls[0]?.[1]?.body);
    expect(body).toContain("token=TOKEN");
    expect(body).toContain("token_type_hint=refresh_token");
  });

  it("omits the hint when none was given", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await oauth(spy as unknown as typeof fetch).revoke("TOKEN");

    expect(String(spy.mock.calls[0]?.[1]?.body)).toBe("token=TOKEN");
  });

  it("throws a revoke_failed error on a non-2xx response", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("nope", { status: 400 })),
    );

    await expect(oauth(spy as unknown as typeof fetch).revoke("TOKEN")).rejects.toMatchObject({
      code: "revoke_failed",
      name: "AllegroAuthError",
    });
  });
});

describe("AllegroOAuth timeouts", () => {
  const withTimeout = (fetchImpl: typeof fetch, timeoutMs?: number) =>
    new AllegroOAuth({
      appName: "TestApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
      fetch: fetchImpl,
      timeoutMs,
    });

  it("arms an abort signal on the token request", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json({ access_token: "AT", expires_in: 43_200 })),
    );

    await withTimeout(spy as unknown as typeof fetch).clientCredentials();

    expect(spy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("arms an abort signal on the revoke request", async () => {
    const spy = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await withTimeout(spy as unknown as typeof fetch).revoke("TOKEN");

    expect(spy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a token request that outlives the budget", async () => {
    // Without a timeout a black-holed /token hangs for the platform socket
    // default, wedging whatever asked for the refresh.
    const spy = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted by signal"));
          });
        }),
    );

    await expect(
      withTimeout(spy as unknown as typeof fetch, 10).clientCredentials(),
    ).rejects.toThrow(/abort/i);
  });
});
