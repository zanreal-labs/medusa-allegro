import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomToken } from "../../../../../lib/crypto";
import {
  requestOrigin,
  setStateCookie,
  STATE_COOKIE_TTL_SECONDS,
} from "../../../../../lib/oauth-state";
import { ALLEGRO_MODULE } from "../../../../../modules/allegro";
import type AllegroModuleService from "../../../../../modules/allegro/service";

/**
 * GET /admin/allegro/oauth/start
 *
 * Mints a CSRF `state`, parks it in an httpOnly cookie, and returns the Allegro
 * authorization URL. The admin then navigates the top-level window to that URL.
 *
 * It returns a URL instead of issuing a 302 on purpose: the admin dashboard
 * calls this with `fetch`, and a redirect out of a fetch cannot hand the browser
 * to Allegro's consent screen. The caller doing the navigation is also what puts
 * the state cookie in play for the callback - Allegro's redirect back is a
 * top-level GET navigation, which SameSite=Lax permits.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const state = randomToken();
  const origin = requestOrigin(req);
  const authorizationUrl = await allegro.buildAuthorizationUrl(state, origin);

  setStateCookie(res, state, req);

  res.json({
    authorization_url: authorizationUrl,
    expires_in: STATE_COOKIE_TTL_SECONDS,
    redirect_uri: await allegro.getRedirectUri(origin),
  });
}
