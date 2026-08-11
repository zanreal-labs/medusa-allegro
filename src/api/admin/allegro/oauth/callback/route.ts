import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { AllegroAuthError } from "../../../../../lib/allegro/auth-error";
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

const fail = (res: MedusaResponse, error: CallbackError): void => {
  clearStateCookie(res);
  res.redirect(`${SETTINGS_PATH}?error=${error}`);
};

/**
 * GET /admin/allegro/oauth/callback
 *
 * Allegro's redirect target. Verifies the CSRF state, exchanges the code, stores
 * the encrypted tokens, and sends the browser back to the settings page.
 *
 * Two gates protect this route. Medusa authenticates every `/admin/*` route by
 * default, and the admin session cookie is `SameSite=Lax`, so it is present on
 * this top-level GET navigation. On top of that, the `state` cookie must match
 * what Allegro echoes back, which is what ties the callback to a flow this
 * browser actually started. The route is deliberately NOT marked
 * `AUTHENTICATE = false`.
 *
 * The redirect URI has to be byte-identical to the one used at `start`, because
 * Allegro validates it during the exchange. Both derive it from the same
 * `getRedirectUri`, which is why a pinned `backendUrl` matters behind a proxy
 * that rewrites Host.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    error: (message: string) => void;
  };

  const query = req.query as Record<string, string | undefined>;

  // The seller declined on the consent screen, or Allegro refused the request.
  if (query.error) {
    return fail(res, "denied");
  }

  const {code} = query;
  if (!code) {
    return fail(res, "missing_code");
  }

  const expectedState = readStateCookie(req);
  if (!(expectedState && query.state && safeEqual(expectedState, query.state))) {
    return fail(res, "state_mismatch");
  }

  try {
    await allegro.connectWithCode(code, await allegro.getRedirectUri(requestOrigin(req)));
  } catch (error) {
    const isExchange = error instanceof AllegroAuthError;
    const reason = isExchange
      ? `${(error as AllegroAuthError).code}: ${error.message}`
      : String(error);
    logger.error(`[medusa-allegro] connect failed - ${reason}`);
    return fail(res, isExchange ? "exchange_failed" : "persist_failed");
  }

  clearStateCookie(res);
  res.redirect(`${SETTINGS_PATH}?connected=1`);
}
