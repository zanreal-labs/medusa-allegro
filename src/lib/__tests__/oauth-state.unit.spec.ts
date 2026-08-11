import { randomBytes } from "node:crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  clearStateCookie,
  HOST_PREFIXED_STATE_COOKIE,
  mintOAuthState,
  readStateCookie,
  requestOrigin,
  setStateCookie,
  STATE_COOKIE,
  STATE_COOKIE_TTL_SECONDS,
  stateCookieName,
  verifyOAuthState,
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

describe("stateCookieName", () => {
  it("uses the __Host- prefix on https, where the browser can enforce it", () => {
    expect(stateCookieName(request({ secure: true }))).toBe(HOST_PREFIXED_STATE_COOKIE);
    expect(stateCookieName(request({ headers: { "x-forwarded-proto": "https" } }))).toBe(
      HOST_PREFIXED_STATE_COOKIE,
    );
  });

  it("stays unprefixed on plain http, where a __Host- cookie would be dropped", () => {
    expect(stateCookieName(request())).toBe(STATE_COOKIE);
  });
});

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

  it("marks the cookie Secure behind an https-terminating proxy, and prefixes it", () => {
    const { calls, res } = response();
    setStateCookie(res, "s", request({ headers: { "x-forwarded-proto": "https" } }));
    expect(calls[0]?.name).toBe(HOST_PREFIXED_STATE_COOKIE);
    expect(calls[0]?.options).toMatchObject({ secure: true });
  });

  it("leaves the cookie non-Secure on plain http, so local dev works", () => {
    const { calls, res } = response();
    setStateCookie(res, "s", request());
    expect(calls[0]?.name).toBe(STATE_COOKIE);
    expect(calls[0]?.options).toMatchObject({ secure: false });
  });

  it("sets no Domain, which is what makes the __Host- prefix legal", () => {
    const { calls, res } = response();
    setStateCookie(res, "s", request({ secure: true }));
    expect((calls[0]?.options as Record<string, unknown>).domain).toBeUndefined();
  });
});

describe("clearStateCookie", () => {
  it("clears both names, so a proxy flipping scheme cannot leave one behind", () => {
    const { calls, res } = response();
    clearStateCookie(res);
    expect(calls.map((call) => call.name)).toEqual([STATE_COOKIE, HOST_PREFIXED_STATE_COOKIE]);
    expect(calls[0]).toMatchObject({ options: { path: "/" } });
    expect(calls[1]).toMatchObject({ options: { path: "/" } });
  });
});

describe("readStateCookie", () => {
  it("reads the parsed cookie when cookie-parser ran", () => {
    expect(readStateCookie(request({ cookies: { [STATE_COOKIE]: "parsed" } }))).toBe("parsed");
  });

  it("prefers the __Host- name over the unprefixed one", () => {
    expect(
      readStateCookie(
        request({
          cookies: { [HOST_PREFIXED_STATE_COOKIE]: "prefixed", [STATE_COOKIE]: "plain" },
        }),
      ),
    ).toBe("prefixed");
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

  it("prefers the __Host- name in the header too, whatever the order", () => {
    expect(
      readStateCookie(
        request({
          headers: {
            cookie: `${STATE_COOKIE}=plain; ${HOST_PREFIXED_STATE_COOKIE}=prefixed`,
          },
        }),
      ),
    ).toBe("prefixed");
  });

  it("url-decodes a header value", () => {
    expect(readStateCookie(request({ headers: { cookie: `${STATE_COOKIE}=a%2Fb` } }))).toBe("a/b");
  });

  it("falls back to the raw value on malformed percent-encoding instead of throwing", () => {
    // `decodeURIComponent("%zz")` throws URIError, and this runs before the
    // callback route's try block: an unhandled throw would turn an
    // attacker-controlled header into a 500.
    expect(readStateCookie(request({ headers: { cookie: `${STATE_COOKIE}=%zz` } }))).toBe("%zz");
    expect(
      readStateCookie(request({ headers: { cookie: `${HOST_PREFIXED_STATE_COOKIE}=%E0%A4%A` } })),
    ).toBe("%E0%A4%A");
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

describe("mintOAuthState / verifyOAuthState", () => {
  const secret = randomBytes(32).toString("base64");
  const actor = "user_01ABC";

  it("verifies a freshly minted state for the same actor", () => {
    expect(verifyOAuthState(mintOAuthState(actor, secret), actor, secret)).toEqual({ valid: true });
  });

  it("is URL-safe, so it survives the trip through Allegro's authorize URL", () => {
    expect(mintOAuthState(actor, secret)).toMatch(/^v1\.\d+\.[\w-]+\.[\w-]+$/);
  });

  it("does not carry the actor id, which would leak it into Allegro's logs", () => {
    expect(mintOAuthState(actor, secret)).not.toContain(actor);
  });

  it("never repeats a value for the same actor and moment", () => {
    const now = Date.now();
    expect(mintOAuthState(actor, secret, now)).not.toBe(mintOAuthState(actor, secret, now));
  });

  it("rejects a state minted for a different admin", () => {
    // The whole point: a cookie planted in another admin's browser still fails.
    expect(verifyOAuthState(mintOAuthState(actor, secret), "user_other", secret)).toEqual({
      reason: "signature_mismatch",
      valid: false,
    });
  });

  it("rejects a state signed with a different key", () => {
    const other = randomBytes(32).toString("base64");
    expect(verifyOAuthState(mintOAuthState(actor, secret), actor, other)).toEqual({
      reason: "signature_mismatch",
      valid: false,
    });
  });

  it("rejects a tampered nonce or mac", () => {
    const state = mintOAuthState(actor, secret);
    const parts = state.split(".");

    expect(
      verifyOAuthState(`${parts[0]}.${parts[1]}.tampered.${parts[3]}`, actor, secret).reason,
    ).toBe("signature_mismatch");
    expect(
      verifyOAuthState(`${parts[0]}.${parts[1]}.${parts[2]}.tampered`, actor, secret).reason,
    ).toBe("signature_mismatch");
  });

  it("rejects a state older than the 10-minute window", () => {
    const now = Date.now();
    const state = mintOAuthState(actor, secret, now - (STATE_COOKIE_TTL_SECONDS * 1000 + 1));

    expect(verifyOAuthState(state, actor, secret, now)).toEqual({
      reason: "expired",
      valid: false,
    });
  });

  it("accepts a state right at the edge of the window", () => {
    const now = Date.now();
    const state = mintOAuthState(actor, secret, now - STATE_COOKIE_TTL_SECONDS * 1000);

    expect(verifyOAuthState(state, actor, secret, now).valid).toBe(true);
  });

  it("rejects a state minted far in the future", () => {
    const now = Date.now();
    const state = mintOAuthState(actor, secret, now + STATE_COOKIE_TTL_SECONDS * 1000 + 1);

    expect(verifyOAuthState(state, actor, secret, now).reason).toBe("expired");
  });

  it("tolerates modest clock skew in the other direction", () => {
    const now = Date.now();
    const state = mintOAuthState(actor, secret, now + 5000);

    expect(verifyOAuthState(state, actor, secret, now).valid).toBe(true);
  });

  it.each([
    ["", "malformed"],
    ["not-a-state", "malformed"],
    ["v1.123.nonce", "malformed"],
    ["v1.123.nonce.mac.extra", "malformed"],
    ["v2.123.nonce.mac", "unknown_version"],
    ["v1.abc.nonce.mac", "bad_timestamp"],
    ["v1.-5.nonce.mac", "bad_timestamp"],
    ["v1.1.5.nonce.mac", "malformed"],
  ])("rejects %p as %s", (state, reason) => {
    expect(verifyOAuthState(state, actor, secret).reason).toBe(reason);
  });

  it("rejects a missing state or a missing actor", () => {
    expect(verifyOAuthState(undefined, actor, secret).reason).toBe("malformed");
    expect(verifyOAuthState(mintOAuthState(actor, secret), undefined, secret).reason).toBe(
      "malformed",
    );
  });
});
