import { randomBytes } from "node:crypto";
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { AllegroAuthError } from "../../../../lib/allegro/auth-error";
import {
  HOST_PREFIXED_STATE_COOKIE,
  mintOAuthState,
  STATE_COOKIE,
  verifyOAuthState,
} from "../../../../lib/oauth-state";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { GET } from "../oauth/callback/route";

/**
 * Route-level tests for the OAuth callback.
 *
 * The route is a plain exported function, so it can be driven with a fake
 * request and response - no Medusa HTTP stack needed. What is under test is the
 * gate ordering and the error mapping: which branch wins, whether the state
 * cookie is cleared, and what reaches the log.
 */

const KEY = randomBytes(32).toString("base64");
const ACTOR = "user_01ADMIN";
const SETTINGS_PATH = "/app/settings/allegro";

interface FakeService {
  connectWithCode: jest.Mock;
  getRedirectUri: jest.Mock;
  verifyOAuthState: jest.Mock;
}

const fakeService = (overrides: Partial<FakeService> = {}): FakeService => ({
  connectWithCode: jest.fn(() => Promise.resolve({ accountLogin: "seller" })),
  getRedirectUri: jest.fn(() =>
    Promise.resolve("https://shop.example/admin/allegro/oauth/callback"),
  ),
  // Mirrors the real service: the key stays inside, the route only sees a verdict.
  verifyOAuthState: jest.fn((state?: string, actorId?: string) =>
    Promise.resolve(verifyOAuthState(state, actorId, KEY)),
  ),
  ...overrides,
});

const harness = (
  options: {
    query?: Record<string, string | undefined>;
    cookies?: Record<string, string>;
    /** `null` means the request carries no `auth_context` at all. */
    actorId?: string | null;
    service?: FakeService;
  } = {},
) => {
  const service = options.service ?? fakeService();
  const logged: { level: string; message: string }[] = [];
  const logger = {
    error: (message: string) => logged.push({ level: "error", message }),
    warn: (message: string) => logged.push({ level: "warn", message }),
  };

  const actorId = options.actorId === undefined ? ACTOR : options.actorId;
  const req = {
    auth_context: actorId === null ? undefined : { actor_id: actorId },
    cookies: options.cookies ?? {},
    get: () => {},
    headers: {},
    query: options.query ?? {},
    scope: {
      resolve: (key: string) => (key === ALLEGRO_MODULE ? service : logger),
    },
    secure: false,
  } as unknown as AuthenticatedMedusaRequest;

  const cleared: string[] = [];
  const redirects: string[] = [];
  const res = {
    clearCookie: (name: string) => cleared.push(name),
    redirect: (url: string) => redirects.push(url),
  } as unknown as MedusaResponse;

  return { cleared, logged, redirects, req, res, service };
};

const validFlow = (overrides: { actorId?: string } = {}) => {
  const actorId = overrides.actorId ?? ACTOR;
  const state = mintOAuthState(actorId, KEY);
  return { actorId, state };
};

describe("GET /admin/allegro/oauth/callback - the seller declined", () => {
  it("maps ?error=access_denied to denied", async () => {
    const h = harness({ query: { error: "access_denied" } });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=denied`]);
  });

  it("does not exchange anything, even when a code rides along", async () => {
    const h = harness({ query: { code: "CODE", error: "access_denied" } });

    await GET(h.req, h.res);

    expect(h.service.connectWithCode).not.toHaveBeenCalled();
  });

  it("leaves the state cookie alone, so a lured GET cannot kill a live flow", async () => {
    const { state } = validFlow();
    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { error: "access_denied" },
    });

    await GET(h.req, h.res);

    expect(h.cleared).toEqual([]);
  });
});

describe("GET /admin/allegro/oauth/callback - no code", () => {
  it("maps a missing code to missing_code", async () => {
    const h = harness({ query: { state: "whatever" } });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=missing_code`]);
    expect(h.service.connectWithCode).not.toHaveBeenCalled();
  });

  it("leaves the state cookie alone", async () => {
    const { state } = validFlow();
    const h = harness({ cookies: { [STATE_COOKIE]: state }, query: { state } });

    await GET(h.req, h.res);

    expect(h.cleared).toEqual([]);
  });
});

describe("GET /admin/allegro/oauth/callback - state mismatch", () => {
  it("rejects a callback with no cookie at all", async () => {
    const { state } = validFlow();
    const h = harness({ cookies: {}, query: { code: "CODE", state } });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
    expect(h.service.connectWithCode).not.toHaveBeenCalled();
  });

  it("rejects a cookie with no query.state", async () => {
    const { state } = validFlow();
    const h = harness({ cookies: { [STATE_COOKIE]: state }, query: { code: "CODE" } });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
  });

  it("rejects a query.state that differs from the cookie", async () => {
    const { state } = validFlow();
    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state: mintOAuthState(ACTOR, KEY) },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
  });

  it("rejects an equal-length but different query.state", async () => {
    // `timingSafeEqual` throws on a length mismatch, so the equal-length case is
    // the one that actually reaches the comparison.
    const { state } = validFlow();
    const flipped = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    expect(flipped).toHaveLength(state.length);
    expect(flipped).not.toBe(state);

    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state: flipped },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
  });

  it("rejects a matching cookie whose state was minted for another admin", async () => {
    // Cookie planting: the value round-trips, but the signature is bound to a
    // different actor id, so the server-side check still fails.
    const state = mintOAuthState("user_01OTHER", KEY);
    const h = harness({
      actorId: ACTOR,
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
    expect(h.service.connectWithCode).not.toHaveBeenCalled();
    expect(h.logged).toEqual([
      { level: "warn", message: expect.stringContaining("signature_mismatch") },
    ]);
  });

  it("rejects a matching cookie whose state has expired", async () => {
    const state = mintOAuthState(ACTOR, KEY, Date.now() - 11 * 60 * 1000);
    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
    expect(h.logged[0]?.message).toContain("expired");
  });

  it("rejects a callback with no authenticated actor", async () => {
    const state = mintOAuthState(ACTOR, KEY);
    const h = harness({
      actorId: null,
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=state_mismatch`]);
  });

  it("never puts the authorization code in a log line", async () => {
    const state = mintOAuthState("user_01OTHER", KEY);
    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "SECRET-AUTHZ-CODE", state },
    });

    await GET(h.req, h.res);

    for (const entry of h.logged) {
      expect(entry.message).not.toContain("SECRET-AUTHZ-CODE");
    }
    expect(h.redirects[0]).not.toContain("SECRET-AUTHZ-CODE");
  });
});

describe("GET /admin/allegro/oauth/callback - success", () => {
  it("exchanges the code, clears the cookie and redirects with ?connected=1", async () => {
    const state = mintOAuthState(ACTOR, KEY);
    const h = harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "CODE", state },
    });

    await GET(h.req, h.res);

    expect(h.service.connectWithCode).toHaveBeenCalledWith(
      "CODE",
      "https://shop.example/admin/allegro/oauth/callback",
    );
    expect(h.cleared).toEqual([STATE_COOKIE, HOST_PREFIXED_STATE_COOKIE]);
    expect(h.redirects).toEqual([`${SETTINGS_PATH}?connected=1`]);
    expect(h.logged).toEqual([]);
  });

  it("accepts the __Host- cookie too", async () => {
    const state = mintOAuthState(ACTOR, KEY);
    const h = harness({
      cookies: { [HOST_PREFIXED_STATE_COOKIE]: state },
      query: { code: "CODE", state },
    });

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?connected=1`]);
  });
});

describe("GET /admin/allegro/oauth/callback - failures after the code is spent", () => {
  const spentFlow = (connectWithCode: jest.Mock) => {
    const state = mintOAuthState(ACTOR, KEY);
    return harness({
      cookies: { [STATE_COOKIE]: state },
      query: { code: "SECRET-AUTHZ-CODE", state },
      service: fakeService({ connectWithCode }),
    });
  };

  it("maps an AllegroAuthError to exchange_failed", async () => {
    const h = spentFlow(
      jest.fn(() => Promise.reject(new AllegroAuthError("bad code", "invalid_grant", 400))),
    );

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=exchange_failed`]);
    expect(h.logged[0]?.message).toContain("invalid_grant");
  });

  it("maps any other thrown error to persist_failed", async () => {
    const h = spentFlow(jest.fn(() => Promise.reject(new Error("column does not exist"))));

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=persist_failed`]);
    expect(h.logged[0]?.message).toContain("column does not exist");
  });

  it("maps a thrown non-Error to persist_failed as well", async () => {
    const h = spentFlow(jest.fn(() => Promise.reject("just a string")));

    await GET(h.req, h.res);

    expect(h.redirects).toEqual([`${SETTINGS_PATH}?error=persist_failed`]);
  });

  it("clears the state cookie, because the code was handed to Allegro", async () => {
    const h = spentFlow(jest.fn(() => Promise.reject(new Error("boom"))));

    await GET(h.req, h.res);

    expect(h.cleared).toEqual([STATE_COOKIE, HOST_PREFIXED_STATE_COOKIE]);
  });

  it("never logs the authorization code, whatever the failure", async () => {
    // The route composes its log line from the error only, never from
    // `query.code`. None of these rejections mentions the code, so if it shows
    // up in the log the route put it there.
    for (const rejection of [
      new AllegroAuthError("bad grant", "invalid_grant", 400),
      new Error("relation allegro_auth does not exist"),
      "opaque",
    ]) {
      const h = spentFlow(jest.fn(() => Promise.reject(rejection)));

      await GET(h.req, h.res);

      expect(h.logged).not.toEqual([]);
      for (const entry of h.logged) {
        expect(entry.message).not.toContain("SECRET-AUTHZ-CODE");
      }
      expect(h.redirects[0]).not.toContain("SECRET-AUTHZ-CODE");
    }
  });

  it("never puts Allegro's raw message in the redirect URL", async () => {
    // Allegro error text can carry the client id; the browser only gets a code.
    const h = spentFlow(
      jest.fn(() =>
        Promise.reject(
          new AllegroAuthError("client_id abc123 is not authorized", "invalid_client", 401),
        ),
      ),
    );

    await GET(h.req, h.res);

    expect(h.redirects[0]).toBe(`${SETTINGS_PATH}?error=exchange_failed`);
    expect(h.redirects[0]).not.toContain("abc123");
  });
});
