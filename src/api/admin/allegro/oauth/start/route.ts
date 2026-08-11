import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
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
 * The state is signed over the authenticated admin's actor id and the mint
 * timestamp (see `src/lib/oauth-state.ts`), so the callback verifies who started
 * the flow and how long ago server-side rather than trusting the cookie alone.
 * `AuthenticatedMedusaRequest` is what makes `auth_context` non-optional here;
 * every `/admin/*` route is authenticated by Medusa's default middleware.
 *
 * It returns a URL instead of issuing a 302 on purpose: the admin dashboard
 * calls this with `fetch`, and a redirect out of a fetch cannot hand the browser
 * to Allegro's consent screen. The caller doing the navigation is also what puts
 * the state cookie in play for the callback - Allegro's redirect back is a
 * top-level GET navigation, which SameSite=Lax permits.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const state = await allegro.mintOAuthState(req.auth_context.actor_id);
  const origin = requestOrigin(req);
  const authorizationUrl = await allegro.buildAuthorizationUrl(state, origin);

  setStateCookie(res, state, req);

  res.json({
    authorization_url: authorizationUrl,
    expires_in: STATE_COOKIE_TTL_SECONDS,
    redirect_uri: await allegro.getRedirectUri(origin),
  });
}
