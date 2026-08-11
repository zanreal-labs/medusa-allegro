import { defineMiddlewares } from "@medusajs/framework/http";

/**
 * Route middleware for the Allegro plugin.
 *
 * Nothing is registered, and that is the point of the file existing: it is the
 * documented place where someone would reach for `AUTHENTICATE = false` or a
 * relaxed matcher on the OAuth callback, and the reason not to belongs here
 * where they will look.
 *
 * Every route this plugin adds lives under `/admin`, which Medusa authenticates
 * by default. That default is what protects the OAuth flow:
 *
 * - `oauth/start` mints the CSRF state, so only a logged-in admin can begin a
 *   connection. The state is signed over that admin's `auth_context.actor_id`.
 * - `oauth/callback` keeps the same default. Allegro's redirect back is a
 *   top-level GET navigation, and Medusa's admin session cookie is
 *   `SameSite=Lax`, so the session survives the hop and the callback still
 *   authenticates. Making it public to "fix" a failing callback would break more
 *   than the session check: with no `auth_context` there is no actor id to verify
 *   the signed state against, so every flow would fail `state_mismatch` instead.
 * - `disconnect` deletes a credential, so it is admin-only for the obvious
 *   reason.
 *
 * If a deployment authenticates its admin with a bearer token in local storage
 * rather than a session cookie, the callback will 401 - the browser has no
 * cookie to send on that navigation. Fix it by serving the admin and the backend
 * on the same origin with session auth, not by unauthenticating the route.
 */
export default defineMiddlewares({
  routes: [],
});
