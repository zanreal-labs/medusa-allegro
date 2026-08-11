import { createHmac } from "node:crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomToken, safeEqual } from "./crypto";

/**
 * The OAuth CSRF `state` round-trip.
 *
 * The value is minted when the flow starts, parked in an httpOnly cookie, and
 * compared against what Allegro echoes back. Without it, anyone could hand the
 * callback a code of their own choosing and bind a foreign Allegro account to
 * this Medusa instance.
 *
 * The state is not an opaque nonce. It is signed with the plugin's
 * `encryptionKey` over the admin user's actor id and the mint timestamp, so the
 * callback can establish three things without trusting the cookie alone:
 *
 * - this server minted the value (nobody can forge one without the key),
 * - it was minted for the admin who is completing the flow (an attacker who
 *   plants a cookie in someone else's browser still fails the actor check),
 * - it was minted within the last 10 minutes (age is enforced server-side, not
 *   left to the cookie's own expiry, which the client controls).
 *
 * The cookie stays: it is what proves the callback lands in the same browser
 * that started the flow, and clearing it is what makes the state single-use.
 */
export const STATE_COOKIE = "medusa_allegro_oauth_state";

/**
 * The `__Host-` form of the same cookie, used whenever the request is https.
 *
 * `__Host-` is a browser-enforced contract: the cookie is rejected unless it is
 * `Secure`, has `Path=/`, and carries no `Domain`. Both conditions were already
 * true, so the prefix costs nothing and buys the part that cannot be expressed
 * any other way - a sibling subdomain (or anything that manages to respond on
 * one) cannot overwrite it. Cookie shadowing is otherwise the standard way to
 * defeat a double-submit CSRF token.
 *
 * Plain http keeps the unprefixed name, because a `__Host-` cookie without
 * `Secure` is simply dropped and local development over http would break.
 */
export const HOST_PREFIXED_STATE_COOKIE = `__Host-${STATE_COOKIE}`;

/**
 * 10 minutes. Long enough to log in to Allegro and read a consent screen, short
 * enough that an abandoned flow does not leave a usable cookie behind for the
 * rest of the day. Also the signed state's maximum age.
 */
export const STATE_COOKIE_TTL_SECONDS = 600;

/**
 * `SameSite=Lax`, not `Strict`.
 *
 * The cookie has to survive exactly one cross-site hop: Allegro's 302 back to
 * the callback. `Strict` withholds cookies on that navigation and the callback
 * would reject every legitimate flow. `Lax` sends them on top-level GET
 * navigations only, which is what this is, and still withholds them from the
 * cross-site POSTs that CSRF needs.
 */
const SAME_SITE = "lax" as const;

const isSecureRequest = (req: MedusaRequest): boolean =>
  req.secure || req.get("x-forwarded-proto") === "https";

/** The cookie name this request should use. See `HOST_PREFIXED_STATE_COOKIE`. */
export const stateCookieName = (req: MedusaRequest): string =>
  isSecureRequest(req) ? HOST_PREFIXED_STATE_COOKIE : STATE_COOKIE;

/**
 * Absolute origin the request arrived on, honouring a terminating proxy.
 *
 * `x-forwarded-host` and `x-forwarded-proto` are client-settable headers when
 * nothing strips them, so treating them as authoritative is normally a
 * host-header injection. It is safe HERE, and only here, because of what the
 * value is used for: it becomes the `redirect_uri` sent to Allegro, and Allegro
 * only accepts a `redirect_uri` that is registered for the app character for
 * character. A forged host produces a rejected exchange, not a redirect
 * anywhere. The value is never used as a redirect target, never written to a
 * `Location` header, and never stored.
 *
 * If you reach for this function for anything else, stop and derive the origin
 * from configuration instead - or gate it on Express's `trust proxy` setting,
 * which this deliberately does not consult. Pinning the `backendUrl` plugin
 * option (or `MEDUSA_BACKEND_URL`) takes these headers out of the picture
 * entirely, and is the documented recommendation behind a proxy.
 */
export const requestOrigin = (req: MedusaRequest): string | undefined => {
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (!host) {
    return undefined;
  }
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
};

export const setStateCookie = (res: MedusaResponse, state: string, req: MedusaRequest): void => {
  const secure = isSecureRequest(req);
  res.cookie(stateCookieName(req), state, {
    httpOnly: true,
    maxAge: STATE_COOKIE_TTL_SECONDS * 1000,
    // `path` and the absence of `domain` are what make the `__Host-` prefix
    // legal; changing either silently breaks the cookie on https.
    path: "/",
    sameSite: SAME_SITE,
    secure,
  });
};

/**
 * Clear the state cookie.
 *
 * Clears BOTH names unconditionally. A deployment can flip between http and
 * https across a single flow (a proxy reconfigured, a health check arriving on
 * the other listener), and a cookie left behind under the other name would
 * survive as a replayable state. Clearing a cookie that was never set is a
 * no-op, so there is nothing to lose.
 */
export const clearStateCookie = (res: MedusaResponse): void => {
  res.clearCookie(STATE_COOKIE, { path: "/" });
  res.clearCookie(HOST_PREFIXED_STATE_COOKIE, { path: "/" });
};

/**
 * Percent-decode a cookie value, falling back to the raw text.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape such as `%zz`,
 * and this function is called before the callback route's try block. An
 * unhandled throw there would surface as a 500 from an attacker-controlled
 * header rather than the `state_mismatch` redirect the route is written to
 * produce. A value that will not decode cannot match a minted state anyway, so
 * handing back the raw text loses nothing.
 */
const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Read the state cookie.
 *
 * Prefers `req.cookies` (Medusa registers cookie-parser) and falls back to
 * parsing the header, so the route keeps working if that ever changes. The
 * `__Host-` name is tried first: on https it is the one that was set, and on
 * plain http it is simply absent.
 */
export const readStateCookie = (req: MedusaRequest): string | undefined => {
  const parsed = (req as { cookies?: Record<string, string> }).cookies;
  const fromParser = parsed?.[HOST_PREFIXED_STATE_COOKIE] ?? parsed?.[STATE_COOKIE];
  if (fromParser) {
    return fromParser;
  }

  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }

  let fallback: string | undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name === HOST_PREFIXED_STATE_COOKIE) {
      return decodeCookieValue(part.slice(index + 1).trim());
    }
    if (name === STATE_COOKIE) {
      fallback = decodeCookieValue(part.slice(index + 1).trim());
    }
  }

  return fallback;
};

/**
 * Wire format of a signed state: `v1.<issuedAt>.<nonce>.<mac>`.
 *
 * The actor id is deliberately NOT in the state. The state travels through
 * Allegro's authorize URL, ends up in Allegro's logs, in the browser's history
 * and in this server's access logs; putting an internal user id there would leak
 * it to all three for no gain. The callback already knows its own actor id and
 * recomputes the MAC over it, which is a stronger check than echoing it back
 * would be.
 */
const STATE_VERSION = "v1";
const STATE_NONCE_BYTES = 16;

const stateMac = (issuedAt: number, nonce: string, actorId: string, secret: string): string =>
  createHmac("sha256", secret)
    .update(`${STATE_VERSION}.${issuedAt}.${nonce}.${actorId}`)
    .digest("base64url");

/** Mint a signed `state` bound to this admin user and this moment. */
export const mintOAuthState = (
  actorId: string,
  secret: string,
  now: number = Date.now(),
): string => {
  const nonce = randomToken(STATE_NONCE_BYTES);
  return `${STATE_VERSION}.${now}.${nonce}.${stateMac(now, nonce, actorId, secret)}`;
};

/** Why a state was rejected. Surfaced to the server log, never to the browser. */
export type OAuthStateRejection =
  | "malformed"
  | "unknown_version"
  | "bad_timestamp"
  | "expired"
  | "signature_mismatch";

export interface OAuthStateVerification {
  valid: boolean;
  reason?: OAuthStateRejection;
}

/**
 * Verify a signed `state` against the admin completing the flow.
 *
 * Returns a reason rather than throwing, because the caller maps every failure
 * onto the same opaque `state_mismatch` code for the browser and wants the
 * detail for the log.
 */
export const verifyOAuthState = (
  state: string | undefined,
  actorId: string | undefined,
  secret: string,
  now: number = Date.now(),
): OAuthStateVerification => {
  if (!(state && actorId)) {
    return { reason: "malformed", valid: false };
  }

  const parts = state.split(".");
  if (parts.length !== 4) {
    return { reason: "malformed", valid: false };
  }

  const [version, issuedAtRaw, nonce, mac] = parts;
  if (version !== STATE_VERSION) {
    return { reason: "unknown_version", valid: false };
  }

  const issuedAt = Number(issuedAtRaw);
  if (!(Number.isInteger(issuedAt) && issuedAt > 0)) {
    return { reason: "bad_timestamp", valid: false };
  }

  // A state minted in the future is treated as expired rather than accepted:
  // modest clock skew is fine, a timestamp well ahead of now is not something a
  // legitimate mint produces.
  const age = now - issuedAt;
  if (age < -STATE_COOKIE_TTL_SECONDS * 1000 || age > STATE_COOKIE_TTL_SECONDS * 1000) {
    return { reason: "expired", valid: false };
  }

  if (!safeEqual(stateMac(issuedAt, nonce, actorId, secret), mac)) {
    return { reason: "signature_mismatch", valid: false };
  }

  return { valid: true };
};
