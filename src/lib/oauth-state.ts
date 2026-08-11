import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * The OAuth CSRF `state` round-trip.
 *
 * The value is minted when the flow starts, parked in an httpOnly cookie, and
 * compared against what Allegro echoes back. Without it, anyone could hand the
 * callback a code of their own choosing and bind a foreign Allegro account to
 * this Medusa instance.
 */
export const STATE_COOKIE = "medusa_allegro_oauth_state";

/**
 * 10 minutes. Long enough to log in to Allegro and read a consent screen, short
 * enough that an abandoned flow does not leave a usable cookie behind for the
 * rest of the day.
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

/** Absolute origin the request arrived on, honouring a terminating proxy. */
export const requestOrigin = (req: MedusaRequest): string | undefined => {
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (!host) {
    return undefined;
  }
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
};

export const setStateCookie = (res: MedusaResponse, state: string, req?: MedusaRequest): void => {
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: STATE_COOKIE_TTL_SECONDS * 1000,
    path: "/",
    sameSite: SAME_SITE,
    secure: req ? isSecureRequest(req) : process.env.NODE_ENV === "production",
  });
};

export const clearStateCookie = (res: MedusaResponse): void => {
  res.clearCookie(STATE_COOKIE, { path: "/" });
};

/**
 * Read the state cookie.
 *
 * Prefers `req.cookies` (Medusa registers cookie-parser) and falls back to
 * parsing the header, so the route keeps working if that ever changes.
 */
export const readStateCookie = (req: MedusaRequest): string | undefined => {
  const parsed = (req as { cookies?: Record<string, string> }).cookies?.[STATE_COOKIE];
  if (parsed) {
    return parsed;
  }

  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === STATE_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return undefined;
};
