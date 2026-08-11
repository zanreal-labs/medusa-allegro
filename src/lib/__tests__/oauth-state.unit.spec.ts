import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  clearStateCookie,
  readStateCookie,
  requestOrigin,
  setStateCookie,
  STATE_COOKIE,
  STATE_COOKIE_TTL_SECONDS,
} from "../oauth-state";

const request = (
  overrides: {
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    secure?: boolean;
  } = {},
): MedusaRequest => {
  const headers = overrides.headers ?? {};
  return {
    cookies: overrides.cookies,
    get: (name: string) => headers[name.toLowerCase()],
    headers,
    secure: overrides.secure ?? false,
  } as unknown as MedusaRequest;
};

const response = () => {
  const calls: { name: string; value?: string; options?: unknown }[] = [];
  const res = {
    clearCookie: (name: string, options?: unknown) => calls.push({ name, options }),
    cookie: (name: string, value: string, options?: unknown) =>
      calls.push({ name, options, value }),
  } as unknown as MedusaResponse;
  return { calls, res };
};

describe("setStateCookie", () => {
  it("sets an httpOnly, lax, 10-minute cookie", () => {
    const { calls, res } = response();
    setStateCookie(res, "state-value", request());

    expect(calls[0]?.name).toBe(STATE_COOKIE);
    expect(calls[0]?.value).toBe("state-value");
    expect(calls[0]?.options).toMatchObject({
      httpOnly: true,
      maxAge: STATE_COOKIE_TTL_SECONDS * 1000,
      path: "/",
      // Lax, not Strict: the cookie has to survive Allegro's redirect back,
      // which is a cross-site top-level GET navigation.
      sameSite: "lax",
    });
  });

  it("marks the cookie Secure behind an https-terminating proxy", () => {
    const { calls, res } = response();
    setStateCookie(res, "s", request({ headers: { "x-forwarded-proto": "https" } }));
    expect(calls[0]?.options).toMatchObject({ secure: true });
  });

  it("leaves the cookie non-Secure on plain http, so local dev works", () => {
    const { calls, res } = response();
    setStateCookie(res, "s", request());
    expect(calls[0]?.options).toMatchObject({ secure: false });
  });
});

describe("clearStateCookie", () => {
  it("clears the cookie on the same path it was set on", () => {
    const { calls, res } = response();
    clearStateCookie(res);
    expect(calls[0]).toMatchObject({ name: STATE_COOKIE, options: { path: "/" } });
  });
});

describe("readStateCookie", () => {
  it("reads the parsed cookie when cookie-parser ran", () => {
    expect(readStateCookie(request({ cookies: { [STATE_COOKIE]: "parsed" } }))).toBe("parsed");
  });

  it("falls back to parsing the header", () => {
    expect(
      readStateCookie(
        request({
          headers: { cookie: `connect.sid=abc; ${STATE_COOKIE}=from-header` },
        }),
      ),
    ).toBe("from-header");
  });

  it("url-decodes a header value", () => {
    expect(readStateCookie(request({ headers: { cookie: `${STATE_COOKIE}=a%2Fb` } }))).toBe("a/b");
  });

  it("returns undefined when the cookie is absent", () => {
    expect(readStateCookie(request({ headers: { cookie: "other=1" } }))).toBeUndefined();
    expect(readStateCookie(request())).toBeUndefined();
  });
});

describe("requestOrigin", () => {
  it("prefers the forwarded host and proto", () => {
    expect(
      requestOrigin(
        request({
          headers: {
            host: "internal:9000",
            "x-forwarded-host": "shop.example.com",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe("https://shop.example.com");
  });

  it("takes the first entry of a comma-joined proxy chain", () => {
    expect(
      requestOrigin(
        request({
          headers: {
            "x-forwarded-host": "shop.example.com, inner",
            "x-forwarded-proto": "https, http",
          },
        }),
      ),
    ).toBe("https://shop.example.com");
  });

  it("falls back to Host over http", () => {
    expect(requestOrigin(request({ headers: { host: "localhost:9000" } }))).toBe(
      "http://localhost:9000",
    );
  });

  it("returns undefined without a host", () => {
    expect(requestOrigin(request())).toBeUndefined();
  });
});
