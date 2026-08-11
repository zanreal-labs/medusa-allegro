import Medusa from "@medusajs/js-sdk";

/**
 * Admin API client for the plugin's UI route.
 *
 * `auth.type: "session"` matches how the Medusa Admin dashboard authenticates,
 * so requests carry the same cookie the dashboard already holds and there is no
 * second token for the plugin to manage.
 */
export const sdk = new Medusa({
  auth: { type: "session" },
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
});
