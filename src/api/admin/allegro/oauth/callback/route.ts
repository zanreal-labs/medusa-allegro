import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { AllegroAuthError } from "../../../../../lib/allegro/auth-error";
import { describeError } from "../../../../../lib/allegro/errors";
import { safeEqual } from "../../../../../lib/crypto";
import { clearStateCookie, readStateCookie, requestOrigin } from "../../../../../lib/oauth-state";
import { ALLEGRO_MODULE } from "../../../../../modules/allegro";
import type AllegroModuleService from "../../../../../modules/allegro/service";

/** Where the browser lands afterwards: the plugin's settings page. */
const SETTINGS_PATH = "/app/settings/allegro";

/**
 * Error codes appended to the settings URL as `?error=`.
 *
 * Deliberately a closed set of short codes rather than the raw error text.
 * Allegro's messages can carry the client id and other request detail, and this
 * value ends up in a URL, in browser history, and in access logs. The detail
 * goes to the server log instead.
 */
type CallbackError =
  | "denied"
  | "missing_code"
  | "state_mismatch"
  | "exchange_failed"
  | "persist_failed";

/**
 * Fail WITHOUT clearing the state cookie.
 *
 * Used by every branch that runs before the state has been verified. Those
 * branches are reachable by anyone who can get the admin's browser to issue one
 * GET - `?error=whatever` needs no code, no state and no cooperation from
 * Allegro. Clearing the cookie there let a lured navigation destroy an OAuth
 * flow the operator had legitimately started in another tab, which is a small
 * but free denial of service. Leaving the cookie alone costs nothing: it is
 * httpOnly, it expires in 10 minutes, and the signed state inside it is useless
 * without a matching authorization code.
 */
const failEarly = (res: MedusaResponse, error: CallbackError): void => {
  res.redirect(`${SETTINGS_PATH}?error=${error}`);
};

/**
 * Fail AND clear the state cookie.
 *
 * Used once the authorization code has actually been handed to Allegro. The
 * state is spent at that point whether the exchange succeeded or not, so
 * clearing it is what keeps it single-use. Only reachable after state
 * verification passed, so there is no lure to worry about.
 */
const failSpent = (res: MedusaResponse, error: CallbackError): void => {
  clearStateCookie(res);
  res.redirect(`${SETTINGS_PATH}?error=${error}`);
};

/**
 * GET /admin/allegro/oauth/callback
 *
 * Allegro's redirect target. Verifies the CSRF state, exchanges the code, stores
 * the encrypted tokens, and sends the browser back to the settings page.
 *
 * Three gates protect this route. Medusa authenticates every `/admin/*` route by
 * default, and the admin session cookie is `SameSite=Lax`, so it is present on
 * this top-level GET navigation. The `state` cookie must match what Allegro
 * echoes back, which ties the callback to a flow this browser started. And the
 * state itself is signed over the admin's actor id and its mint time, so it must
 * also have been minted by this server, for this admin, within the last ten
 * minutes - a cookie planted in someone else's browser fails that check. The
 * route is deliberately NOT marked `AUTHENTICATE = false`.
 *
 * The redirect URI has to be byte-identical to the one used at `start`, because
 * Allegro validates it during the exchange. Both derive it from the same
 * `getRedirectUri`, which is why a pinned `backendUrl` matters behind a proxy
 * that rewrites Host.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    error: (message: string) => void;
    warn: (message: string) => void;
  };

  const query = req.query as Record<string, string | undefined>;

  // The seller declined on the consent screen, or Allegro refused the request.
  if (query.error) {
    return failEarly(res, "denied");
  }

  // Named `authorizationCode`, not `code`: `code` is also what `AllegroAuthError`
  // calls its error taxonomy field, and a bare `code` in this scope is one
  // careless edit away from a log line that prints the authorization code.
  const authorizationCode = query.code;
  if (!authorizationCode) {
    return failEarly(res, "missing_code");
  }

  const expectedState = readStateCookie(req);
  if (!(expectedState && query.state && safeEqual(expectedState, query.state))) {
    return failEarly(res, "state_mismatch");
  }

  // The cookie proved same-browser. The signature proves same-server, same
  // admin, recent - none of which the cookie alone can establish.
  const verification = await allegro.verifyOAuthState(query.state, req.auth_context?.actor_id);
  if (!verification.valid) {
    logger.warn(`[medusa-allegro] OAuth state rejected - ${verification.reason}`);
    return failEarly(res, "state_mismatch");
  }

  try {
    await allegro.connectWithCode(
      authorizationCode,
      await allegro.getRedirectUri(requestOrigin(req)),
    );
  } catch (error) {
    const isExchange = error instanceof AllegroAuthError;
    const reason = isExchange
      ? `${(error as AllegroAuthError).code}: ${error.message}`
      : describeError(error);
    logger.error(`[medusa-allegro] connect failed - ${reason}`);
    return failSpent(res, isExchange ? "exchange_failed" : "persist_failed");
  }

  clearStateCookie(res);
  res.redirect(`${SETTINGS_PATH}?connected=1`);
}
