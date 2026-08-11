import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import { AllegroClient } from "../../lib/allegro/client";
import { AllegroOAuth } from "../../lib/allegro/oauth";
import type { PersistedToken } from "../../lib/allegro/types";
import { decryptValue, encryptValue } from "../../lib/crypto";
import { isPriceSyncDisabledByEnv, resolveAllegroOptions } from "../../lib/options";
import type { AllegroPluginOptions, ResolvedAllegroOptions } from "../../lib/options";
import AllegroAuth from "./models/allegro-auth";
import AllegroCategoryRate from "./models/allegro-category-rate";
import AllegroOffer from "./models/allegro-offer";
import AllegroPricePush from "./models/allegro-price-push";
import AllegroSyncState from "./models/allegro-sync-state";

/** Shape of a stored connection as the admin surfaces it. */
export interface AllegroConnectionStatus {
  connected: boolean;
  environment: string;
  accountLogin?: string;
  scope?: string;
  expiresAt?: Date;
  connectedAt?: Date;
  /** True when the stored access token is already past its expiry. */
  expired?: boolean;
  /** True when the row exists but has no refresh token: reconnect required. */
  refreshTokenMissing?: boolean;
  /** Effective kill-switch state (plugin option OR the env override). */
  priceSyncDisabled: boolean;
  scopesRequested: string;
}

/**
 * Allegro module service.
 *
 * `MedusaService` supplies the CRUD surface for the five models
 * (`listAllegroOffers`, `createAllegroSyncStates`, and so on). Everything added
 * on top is the part that cannot be generated: the OAuth token lifecycle, and
 * the construction of an authenticated SDK client whose refreshes land back in
 * the database.
 */
class AllegroModuleService extends MedusaService({
  AllegroAuth,
  AllegroCategoryRate,
  AllegroOffer,
  AllegroPricePush,
  AllegroSyncState,
}) {
  protected readonly options_: ResolvedAllegroOptions;

  constructor(container: Record<string, unknown>, options: AllegroPluginOptions) {
    super(container, options);
    this.options_ = resolveAllegroOptions(options);
  }

  /**
   * Validated, defaulted plugin options.
   *
   * Async purely to satisfy Medusa's service contract - every public method on a
   * module service is awaited by convention, so the shape stays uniform whether
   * a method touches the database or not.
   */
  getOptions(): Promise<ResolvedAllegroOptions> {
    return Promise.resolve(this.options_);
  }

  /**
   * Effective price-sync kill-switch.
   *
   * Re-reads the environment on every call rather than trusting the value
   * captured at boot, so `ALLEGRO_PRICE_SYNC_DISABLED=1` takes effect on a
   * restart-free redeploy of the process environment as well.
   */
  isPriceSyncDisabled(): Promise<boolean> {
    return Promise.resolve(this.options_.priceSyncDisabled || isPriceSyncDisabledByEnv());
  }

  /** An unauthenticated OAuth helper for the connect/callback/revoke flow. */
  getOAuth(): Promise<AllegroOAuth> {
    return Promise.resolve(this.buildOAuth());
  }

  /** Synchronous inner form, so the service can use it without awaiting itself. */
  private buildOAuth(): AllegroOAuth {
    const o = this.options_;
    return new AllegroOAuth({
      appName: o.appName,
      appVersion: o.appVersion,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      docsUrl: o.docsUrl,
      environment: o.environment,
    });
  }

  /**
   * The OAuth `redirect_uri`.
   *
   * Allegro compares this string byte for byte against the URI registered for
   * the app, and against the one used to start the flow, so the same value must
   * come out of both the start and the callback route. Precedence: the pinned
   * `backendUrl` option, then `MEDUSA_BACKEND_URL`, then the origin the request
   * arrived on.
   */
  getRedirectUri(requestOrigin?: string): Promise<string> {
    return Promise.resolve(this.buildRedirectUri(requestOrigin));
  }

  /** Synchronous inner form, shared by `getRedirectUri` and the authorize URL. */
  private buildRedirectUri(requestOrigin?: string): string {
    const base =
      this.options_.backendUrl ?? process.env.MEDUSA_BACKEND_URL?.trim() ?? requestOrigin;

    if (!base) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "medusa-allegro: cannot determine the OAuth redirect URI. Set the `backendUrl` plugin option or MEDUSA_BACKEND_URL.",
      );
    }

    return new URL(this.options_.redirectPath, base).toString();
  }

  /** Authorization URL for the Allegro consent screen. */
  buildAuthorizationUrl(state: string, requestOrigin?: string): Promise<string> {
    return Promise.resolve(
      this.buildOAuth().buildAuthorizationUrl({
        redirectUri: this.buildRedirectUri(requestOrigin),
        scope: this.options_.scopes,
        state,
      }),
    );
  }

  /**
   * The stored connection row, or undefined when not connected.
   *
   * Reads the single row this plugin maintains. `listAllegroAuths` is ordered by
   * creation so a stray second row (only reachable by writing to the table
   * directly) resolves deterministically to the oldest rather than at random.
   */
  async getStoredAuth(): Promise<Record<string, unknown> | undefined> {
    const rows = await this.listAllegroAuths({}, { order: { created_at: "ASC" }, take: 1 });
    return rows[0] as Record<string, unknown> | undefined;
  }

  /** Connection status for the admin, with no secret material in it. */
  async getConnectionStatus(): Promise<AllegroConnectionStatus> {
    const row = await this.getStoredAuth();
    const base = {
      environment: this.options_.environment,
      priceSyncDisabled: await this.isPriceSyncDisabled(),
      scopesRequested: this.options_.scopes,
    };

    if (!row) {
      return { ...base, connected: false };
    }

    const expiresAt = row.expires_at ? new Date(row.expires_at as string) : undefined;
    return {
      ...base,
      accountLogin: (row.account_login as string | null) ?? undefined,
      connected: true,
      connectedAt: row.connected_at ? new Date(row.connected_at as string) : undefined,
      expired: expiresAt ? expiresAt.getTime() <= Date.now() : undefined,
      expiresAt,
      refreshTokenMissing: !row.refresh_token_encrypted,
      scope: (row.scope as string | null) ?? undefined,
    };
  }

  /**
   * Complete the authorization-code flow: exchange, identify, store.
   *
   * The seller login is resolved before the row is written so the connection is
   * persisted exactly once. `GET /me` is best-effort - it needs no scope beyond
   * the grant itself, but if it fails the connection is still valid and gets
   * stored unnamed rather than being thrown away over a display field.
   *
   * `redirectUri` must be the same string that was sent to `authorize`; Allegro
   * validates it during the exchange.
   */
  async connectWithCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accountLogin?: string; scope?: string }> {
    const response = await this.buildOAuth().exchangeCode(code, redirectUri);

    const token: PersistedToken = {
      accessToken: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token,
      scope: response.scope,
    };

    const o = this.options_;
    let accountLogin: string | undefined;
    try {
      const probe = new AllegroClient({
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.expiresAt,
        appName: o.appName,
        appVersion: o.appVersion,
        clientId: o.clientId,
        clientSecret: o.clientSecret,
        docsUrl: o.docsUrl,
        environment: o.environment,
        useClientCredentials: false,
      });
      accountLogin = (await probe.me()).login;
    } catch {
      accountLogin = undefined;
    }

    await this.persistToken(token, { accountLogin });
    return { accountLogin, scope: token.scope };
  }

  /**
   * Write (or replace) the stored connection.
   *
   * Replace rather than update, because a reconnect can legitimately arrive for
   * a different Allegro account, and carrying the previous row's `account_login`
   * or `scope` forward would misreport what the plugin is actually connected to.
   */
  async persistToken(token: PersistedToken, meta: { accountLogin?: string } = {}): Promise<void> {
    const existing = await this.listAllegroAuths({});
    const key = this.options_.encryptionKey;

    // Write the new row before dropping the old one: if the insert fails, the
    // previous working connection is still there.
    await this.createAllegroAuths([
      {
        access_token_encrypted: encryptValue(token.accessToken, key),
        account_login: meta.accountLogin ?? null,
        connected_at: new Date(),
        expires_at: new Date(token.expiresAt),
        refresh_token_encrypted: token.refreshToken ? encryptValue(token.refreshToken, key) : null,
        scope: token.scope ?? null,
      },
    ]);

    if (existing.length > 0) {
      await this.deleteAllegroAuths(existing.map((row) => (row as { id: string }).id));
    }
  }

  /**
   * Update the stored row in place after a token refresh.
   *
   * Distinct from `persistToken`: a refresh is the same connection continuing,
   * so `connected_at` and `account_login` must survive it. When no row exists
   * the refreshed token is dropped on purpose - it belongs to a connection that
   * was disconnected mid-flight, and recreating it would resurrect access the
   * operator just revoked.
   */
  async persistRefreshedToken(token: PersistedToken): Promise<void> {
    const row = await this.getStoredAuth();
    if (!row) {
      return;
    }

    const key = this.options_.encryptionKey;
    await this.updateAllegroAuths([
      {
        id: row.id as string,
        access_token_encrypted: encryptValue(token.accessToken, key),
        ...(token.refreshToken
          ? { refresh_token_encrypted: encryptValue(token.refreshToken, key) }
          : {}),
        expires_at: new Date(token.expiresAt),
        ...(token.scope ? { scope: token.scope } : {}),
      },
    ]);
  }

  /** Decrypt the stored token set, or undefined when not connected. */
  async loadToken(): Promise<PersistedToken | undefined> {
    const row = await this.getStoredAuth();
    if (!row?.access_token_encrypted) {
      return undefined;
    }

    const key = this.options_.encryptionKey;
    return {
      accessToken: decryptValue(row.access_token_encrypted as string, key),
      expiresAt: new Date(row.expires_at as string).getTime(),
      refreshToken: row.refresh_token_encrypted
        ? decryptValue(row.refresh_token_encrypted as string, key)
        : undefined,
      scope: (row.scope as string | null) ?? undefined,
    };
  }

  /** Drop the stored connection. Idempotent. */
  async deleteConnection(): Promise<void> {
    const rows = await this.listAllegroAuths({});
    if (rows.length === 0) {
      return;
    }
    await this.deleteAllegroAuths(rows.map((row) => (row as { id: string }).id));
  }

  /**
   * An authenticated Allegro client, or null when nothing is connected.
   *
   * Two deliberate choices:
   *
   * `onTokenRefresh` writes the refreshed pair straight back to the database.
   * Allegro rotates the refresh token on every use, so a refresh that is not
   * persisted leaves the stored token permanently stale and the next process to
   * try it gets `invalid_grant`.
   *
   * `useClientCredentials: false` disables the SDK's app-token fallback. Every
   * call this plugin makes is seller-scoped - offers, orders, promo options -
   * and an app-only token cannot see any of it. With the fallback on, a broken
   * connection degrades into a stream of empty result sets that read as "the
   * seller has no offers"; with it off, it fails visibly.
   *
   * NOTE: the SDK's refresh de-duplication is per process. Two Medusa instances
   * (server plus worker, or several replicas) can still race and each burn the
   * other's rotated refresh token. A cross-process lock belongs with the worker
   * mode work in a later wave; until then run the sync loops in one instance.
   */
  async getClient(): Promise<AllegroClient | null> {
    const token = await this.loadToken();
    if (!token) {
      return null;
    }

    const o = this.options_;
    return new AllegroClient({
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.expiresAt,
      appName: o.appName,
      appVersion: o.appVersion,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      docsUrl: o.docsUrl,
      environment: o.environment,
      onTokenRefresh: (refreshed) => this.persistRefreshedToken(refreshed),
      refreshToken: token.refreshToken,
      useClientCredentials: false,
    });
  }
}

export default AllegroModuleService;
