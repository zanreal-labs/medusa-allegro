import { AllegroAuthError } from "./auth-error";
import { ALLEGRO_ENDPOINTS } from "./types";
import type {
  AllegroAppIdentity,
  AllegroEnvironment,
  AllegroTokenResponse,
  AuthorizationUrlParams,
} from "./types";
import { buildAllegroUserAgent } from "./user-agent";

/**
 * `btoa` only accepts latin1, so the UTF-8 bytes have to be widened into a
 * one-char-per-byte string first. `TextEncoder` replaces the older
 * `unescape(encodeURIComponent(...))` trick, which relied on a deprecated API.
 */
const utf8ToBase64 = (raw: string): string => {
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const basicAuth = (clientId: string, clientSecret: string): string => {
  const raw = `${clientId}:${clientSecret}`;
  if (typeof Buffer !== "undefined") {
    return `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
  }
  return `Basic ${utf8ToBase64(raw)}`;
};

/**
 * Wall-clock budget for a single token or revoke call, in milliseconds.
 *
 * DIVERGENCE FROM THE REFERENCE SDK: upstream `AllegroOAuth` has no timeout at
 * all, so a token or revoke request against a black-holed Allegro hangs for as
 * long as the platform's socket default allows. Inside a Medusa request that is
 * a wedged admin route, and inside a background refresh it is a wedged sync
 * loop. Matches `AllegroClient`'s default so the two layers behave alike.
 */
const DEFAULT_OAUTH_TIMEOUT_MS = 60_000;

export interface AllegroOAuthOptions extends AllegroAppIdentity {
  clientId: string;
  clientSecret: string;
  environment?: AllegroEnvironment;
  fetch?: typeof fetch;
  /** Per-request timeout for /token and /revoke. Defaults to 60s. */
  timeoutMs?: number;
}

export class AllegroOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly userAgent: string;
  private readonly env: AllegroEnvironment;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AllegroOAuthOptions) {
    if (!(opts.clientId && opts.clientSecret)) {
      throw new Error("AllegroOAuth: clientId and clientSecret are required.");
    }
    this.userAgent = buildAllegroUserAgent(opts, "AllegroOAuth");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.env = opts.environment ?? "production";
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  }

  /** Composed User-Agent header value (read-only). */
  getUserAgent(): string {
    return this.userAgent;
  }

  /** Build the user-facing URL to start Authorization Code flow. */
  buildAuthorizationUrl(params: AuthorizationUrlParams): string {
    const u = new URL(`${ALLEGRO_ENDPOINTS[this.env].auth}/authorize`);
    u.searchParams.set("response_type", params.responseType ?? "code");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", params.redirectUri);
    if (params.scope) {
      u.searchParams.set("scope", params.scope);
    }
    if (params.state) {
      u.searchParams.set("state", params.state);
    }
    if (params.prompt) {
      u.searchParams.set("prompt", params.prompt);
    }
    return u.toString();
  }

  /** Exchange `code` for tokens (Authorization Code grant). */
  exchangeCode(code: string, redirectUri: string): Promise<AllegroTokenResponse> {
    return this.tokenRequest({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
  }

  /** Refresh an access token using a refresh token. */
  refresh(refreshToken: string, redirectUri?: string): Promise<AllegroTokenResponse> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    };
    if (redirectUri) {
      body.redirect_uri = redirectUri;
    }
    return this.tokenRequest(body);
  }

  /** Client Credentials grant (app-only). */
  clientCredentials(scope?: string): Promise<AllegroTokenResponse> {
    const body: Record<string, string> = { grant_type: "client_credentials" };
    if (scope) {
      body.scope = scope;
    }
    return this.tokenRequest(body);
  }

  /** Revoke an access or refresh token. */
  async revoke(token: string, hint?: "access_token" | "refresh_token"): Promise<void> {
    const body = new URLSearchParams({ token });
    if (hint) {
      body.set("token_type_hint", hint);
    }
    const res = await this.fetchImpl(`${ALLEGRO_ENDPOINTS[this.env].auth}/revoke`, {
      body,
      headers: {
        Authorization: basicAuth(this.clientId, this.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      method: "POST",
      // `AbortSignal.timeout` rather than a manual controller plus
      // `clearTimeout`: the timer it arms is unref'd, so it never holds the
      // process open, and there is nothing to clean up on the success path.
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new AllegroAuthError(
        `Allegro token revoke failed: HTTP ${res.status}`,
        "revoke_failed",
        res.status,
      );
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<AllegroTokenResponse> {
    const form = new URLSearchParams(body);
    const res = await this.fetchImpl(`${ALLEGRO_ENDPOINTS[this.env].auth}/token`, {
      body: form,
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(this.clientId, this.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      method: "POST",
      // See `revoke` for why this is `AbortSignal.timeout`.
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new AllegroAuthError("Allegro: invalid token response", "invalid_response", res.status);
    }

    if (!res.ok) {
      const e = parsed as { error?: string; error_description?: string };
      throw new AllegroAuthError(
        e?.error_description ?? e?.error ?? `Token request failed (HTTP ${res.status})`,
        e?.error ?? "token_request_failed",
        res.status,
      );
    }
    return parsed as AllegroTokenResponse;
  }
}
