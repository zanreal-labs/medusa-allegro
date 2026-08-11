import { decodeEncryptionKey } from "./crypto";
import type { AllegroEnvironment } from "./allegro/types";
import { buildAllegroUserAgent } from "./allegro/user-agent";

/**
 * Options accepted by the Allegro plugin.
 *
 * Everything here comes from `medusa-config.ts`; Medusa hands the plugin's
 * `options` object to every module inside the plugin unchanged. Secrets belong
 * in environment variables that the config file reads - the plugin never reads
 * `process.env` for credentials itself, so a host project keeps a single place
 * where its secrets are wired.
 */
export interface AllegroPluginOptions {
  /** Allegro application client id (Developer Portal). */
  clientId: string;
  /** Allegro application client secret (Developer Portal). */
  clientSecret: string;
  /** Which Allegro to talk to. Defaults to "production". */
  environment?: AllegroEnvironment;
  /**
   * App identity for the mandatory Allegro User-Agent. `appName` MUST match the
   * name of the app registered in the Allegro Developer Portal.
   */
  appName: string;
  appVersion: string;
  /** Public https URL documenting or contacting the integration. */
  docsUrl: string;
  /**
   * Base64-encoded 32-byte key used to seal the stored OAuth tokens
   * (AES-256-GCM). Generate with `openssl rand -base64 32`.
   */
  encryptionKey: string;
  /**
   * Path of the OAuth callback route, appended to the backend URL to form the
   * `redirect_uri`. The value must match the redirect URI registered for the
   * Allegro app character for character.
   */
  redirectPath?: string;
  /** Space-separated OAuth scopes requested during the authorization flow. */
  scopes?: string;
  /**
   * Kill-switch for every price-affecting write. Wave 1 performs no writes at
   * all, but the switch is read (and surfaced in the admin) from day one so an
   * operator can disable price sync before the code that needs disabling ships.
   */
  priceSyncDisabled?: boolean;
  /**
   * Absolute base URL of this Medusa backend, e.g. "https://admin.example.com".
   * Only needed when the backend sits behind a proxy that rewrites Host, or
   * when you want the redirect URI pinned rather than derived per request.
   * Falls back to `MEDUSA_BACKEND_URL`, then to the incoming request's origin.
   */
  backendUrl?: string;
}

/** Options after defaults have been applied. Every field is present. */
export interface ResolvedAllegroOptions {
  clientId: string;
  clientSecret: string;
  environment: AllegroEnvironment;
  appName: string;
  appVersion: string;
  docsUrl: string;
  encryptionKey: string;
  redirectPath: string;
  scopes: string;
  priceSyncDisabled: boolean;
  backendUrl?: string;
}

export const DEFAULT_REDIRECT_PATH = "/admin/allegro/oauth/callback";

export const DEFAULT_SCOPES =
  "allegro:api:sale:offers:read allegro:api:sale:offers:write allegro:api:orders:read";

/**
 * `ALLEGRO_PRICE_SYNC_DISABLED=1|true|yes` disables price writes without a
 * redeploy of the config file. The environment wins when it is set to a truthy
 * value: an operator reaching for an env kill-switch is responding to an
 * incident, and a stale `priceSyncDisabled: false` in config must not undo that.
 */
const PRICE_SYNC_DISABLED_ENV = "ALLEGRO_PRICE_SYNC_DISABLED";

const truthyEnv = (value: string | undefined): boolean => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const isPriceSyncDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  truthyEnv(env[PRICE_SYNC_DISABLED_ENV]);

const requireString = (value: unknown, field: keyof AllegroPluginOptions): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(
      `medusa-allegro: plugin option \`${field}\` is required. See https://github.com/zanreal-labs/medusa-allegro#options`,
    );
  }
  return trimmed;
};

/**
 * Validate and normalize the plugin options.
 *
 * Called from the module loader so a misconfigured plugin fails at boot with a
 * precise message, rather than at the first Allegro call in the middle of a
 * merchant's workflow. Every check here is one that would otherwise surface as
 * an opaque 400/401 from Allegro.
 */
export const resolveAllegroOptions = (
  options?: Partial<AllegroPluginOptions>
): ResolvedAllegroOptions => {
  if (!options) {
    throw new Error(
      "medusa-allegro: no plugin options were provided. Configure the plugin in medusa-config.ts.",
    );
  }

  const clientId = requireString(options.clientId, "clientId");
  const clientSecret = requireString(options.clientSecret, "clientSecret");
  const appName = requireString(options.appName, "appName");
  const appVersion = requireString(options.appVersion, "appVersion");
  const docsUrl = requireString(options.docsUrl, "docsUrl");
  const encryptionKey = requireString(options.encryptionKey, "encryptionKey");

  const environment = options.environment ?? "production";
  if (environment !== "production" && environment !== "sandbox") {
    throw new Error(
      `medusa-allegro: plugin option \`environment\` must be "production" or "sandbox" (got "${String(environment)}").`,
    );
  }

  // Rejects a key that is not base64 or not 32 bytes. Doing it here means a bad
  // key is a boot failure, not a token that gets written and can never be read.
  decodeEncryptionKey(encryptionKey);

  // Same validator the SDK runs at construction time. Running it during option
  // resolution turns "Allegro rejects our User-Agent" into a startup error.
  buildAllegroUserAgent({ appName, appVersion, docsUrl }, "medusa-allegro plugin options");

  const redirectPath = (options.redirectPath ?? DEFAULT_REDIRECT_PATH).trim();
  if (!redirectPath.startsWith("/")) {
    throw new Error(
      `medusa-allegro: plugin option \`redirectPath\` must start with "/" (got "${redirectPath}").`,
    );
  }

  const backendUrl = options.backendUrl?.trim();
  if (backendUrl) {
    try {
      new URL(backendUrl);
    } catch {
      throw new Error(
        `medusa-allegro: plugin option \`backendUrl\` must be an absolute URL (got "${backendUrl}").`,
      );
    }
  }

  return {
    appName,
    appVersion,
    backendUrl: backendUrl || undefined,
    clientId,
    clientSecret,
    docsUrl,
    encryptionKey,
    environment,
    priceSyncDisabled: options.priceSyncDisabled === true || isPriceSyncDisabledByEnv(),
    redirectPath,
    scopes: (options.scopes ?? DEFAULT_SCOPES).trim() || DEFAULT_SCOPES,
  };
};
