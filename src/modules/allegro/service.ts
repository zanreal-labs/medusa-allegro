import type { Context } from "@medusajs/framework/types";
import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from "@medusajs/framework/utils";
import { AllegroClient } from "../../lib/allegro/client";
import { AllegroOAuth } from "../../lib/allegro/oauth";
import type { PersistedToken } from "../../lib/allegro/types";
import { decryptValue, encryptValue } from "../../lib/crypto";
import {
  isPriceSyncDisabledByEnv,
  resolveAllegroOptions,
  toPublicAllegroOptions,
} from "../../lib/options";
import type {
  AllegroPluginOptions,
  AllegroPublicOptions,
  ResolvedAllegroOptions,
} from "../../lib/options";
import { mintOAuthState, verifyOAuthState } from "../../lib/oauth-state";
import type { OAuthStateVerification } from "../../lib/oauth-state";
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
  /**
   * True when a row exists but its token envelope will not open with the
   * configured `encryptionKey`.
   *
   * The usual cause is a rotated or mistyped key, and the connection is dead in
   * a way no retry fixes: reconnecting is the only route back. Without this the
   * admin reported a healthy "Connected" while every Allegro call failed.
   */
  credentialsUnreadable?: boolean;
  /** Effective kill-switch state (plugin option OR the env override). */
  priceSyncDisabled: boolean;
  scopesRequested: string;
}

/**
 * The slice of Medusa's logger this service uses.
 *
 * Duck-typed rather than imported: the module container registers `logger` with
 * `allowUnregistered`, so it can legitimately be absent (a bare unit test, a
 * migration-only boot), and a hard dependency would turn that into a crash.
 */
interface AllegroServiceLogger {
  warn: (message: string) => void;
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
  protected readonly logger_?: AllegroServiceLogger;

  /**
   * Memoized authenticated client. See `getClient` for why it exists and when it
   * is dropped.
   */
  protected client_?: AllegroClient;

  constructor(container: Record<string, unknown>, options: AllegroPluginOptions) {
    super(container, options);
    this.options_ = resolveAllegroOptions(options);
    const logger = container.logger as AllegroServiceLogger | undefined;
    this.logger_ = typeof logger?.warn === "function" ? logger : undefined;
  }

  /**
   * Validated, defaulted plugin options - including `clientSecret` and
   * `encryptionKey`.
   *
   * Protected on purpose. A public accessor returning this object is one
   * careless `res.json({ options })` away from publishing the plugin's
   * credentials, and there is no caller outside the service that needs them.
   * Callers that want configuration read `getPublicOptions()`.
   *
   * Async purely to satisfy Medusa's service contract - every public method on a
   * module service is awaited by convention, so the shape stays uniform whether
   * a method touches the database or not.
   */
  protected getOptions(): Promise<ResolvedAllegroOptions> {
    return Promise.resolve(this.options_);
  }

  /** Configuration that is safe to return to a caller. No secret material. */
  getPublicOptions(): Promise<AllegroPublicOptions> {
    return Promise.resolve(toPublicAllegroOptions(this.options_));
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

  /**
   * Mint the signed OAuth `state` for an admin user.
   *
   * The signing key is the plugin's `encryptionKey`, which is why minting and
   * verification live on the service rather than in the route: the routes never
   * see the key. `actorId` is `req.auth_context.actor_id`, the authenticated
   * admin user.
   */
  mintOAuthState(actorId: string): Promise<string> {
    return Promise.resolve(mintOAuthState(actorId, this.options_.encryptionKey));
  }

  /**
   * Verify a state echoed back by Allegro against the admin completing the flow.
   *
   * Returns the rejection reason so the caller can log it; the browser only ever
   * sees the opaque `state_mismatch` code.
   */
  verifyOAuthState(
    state: string | undefined,
    actorId: string | undefined,
  ): Promise<OAuthStateVerification> {
    return Promise.resolve(verifyOAuthState(state, actorId, this.options_.encryptionKey));
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
   *
   * `async` rather than returning `Promise.resolve(...)`: the inner form throws
   * when nothing resolves, and a declared-Promise method that throws
   * synchronously breaks every caller that reaches for `.catch()`.
   */
  async getRedirectUri(requestOrigin?: string): Promise<string> {
    return await Promise.resolve(this.buildRedirectUri(requestOrigin));
  }

  /** Synchronous inner form, shared by `getRedirectUri` and the authorize URL. */
  private buildRedirectUri(requestOrigin?: string): string {
    // `|| undefined`, not `?? `: an env var that is set but blank (or all
    // whitespace) trims to "", which is not nullish, so `??` would stop the
    // precedence chain there and refuse to fall back to the request origin - a
    // deployment with an empty MEDUSA_BACKEND_URL could not start an OAuth flow
    // at all. Same idiom as the `backendUrl` option in `resolveAllegroOptions`.
    const base =
      this.options_.backendUrl ??
      (process.env.MEDUSA_BACKEND_URL?.trim() || undefined) ??
      requestOrigin;

    if (!base) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "medusa-allegro: cannot determine the OAuth redirect URI. Set the `backendUrl` plugin option or MEDUSA_BACKEND_URL.",
      );
    }

    return new URL(this.options_.redirectPath, base).toString();
  }

  /**
   * Authorization URL for the Allegro consent screen.
   *
   * `async` for the same reason as `getRedirectUri`: it can fail on an
   * unresolvable redirect URI, and that has to arrive as a rejection.
   */
  async buildAuthorizationUrl(state: string, requestOrigin?: string): Promise<string> {
    return await Promise.resolve(
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
   * Protected: the row carries the raw `*_encrypted` columns, and no caller
   * outside the service has a use for them. `loadToken` and
   * `getConnectionStatus` are the two ways out of here, and neither returns an
   * envelope.
   *
   * Ordered NEWEST first. A second row is only reachable by writing to the table
   * directly, or by a `persistToken` whose insert landed and whose delete did
   * not - and in exactly that case the new row is the live connection and the
   * old one is the stale credential. Preferring the oldest, as this used to,
   * made a half-completed reconnect win every subsequent read.
   *
   * `take: 2` rather than 1 so the extra row can be reported instead of hidden.
   */
  protected async getStoredAuth(): Promise<Record<string, unknown> | undefined> {
    const rows = await this.listAllegroAuths({}, { order: { created_at: "DESC" }, take: 2 });

    if (rows.length > 1) {
      this.logger_?.warn(
        "[medusa-allegro] more than one allegro_auth row is present; using the newest. A previous reconnect may have failed to clean up, or the table was written to directly. Disconnect and reconnect to collapse it back to one row.",
      );
    }

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

    // Opening the access-token envelope is the only way to know the stored
    // credential is actually usable. A rotated or mistyped `encryptionKey`
    // leaves a perfectly well-formed row that no Allegro call can use, and
    // reporting that as a healthy "Connected" sends the operator looking at
    // Allegro instead of at their own configuration.
    let credentialsUnreadable = false;
    try {
      decryptValue(row.access_token_encrypted as string, this.options_.encryptionKey);
    } catch {
      credentialsUnreadable = true;
    }

    const expiresAt = row.expires_at ? new Date(row.expires_at as string) : undefined;
    return {
      ...base,
      accountLogin: (row.account_login as string | null) ?? undefined,
      connected: true,
      connectedAt: row.connected_at ? new Date(row.connected_at as string) : undefined,
      credentialsUnreadable,
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
   *
   * Insert and delete run in one transaction. Without it, a failure between the
   * two left two rows behind: one live connection and one stale credential, with
   * every later read having to guess which is which. Inside a transaction the
   * table only ever holds the row that belongs to the connection that completed.
   *
   * Split into a public entry point and a protected worker, which is Medusa's
   * convention: `@InjectManager` on the public method supplies a manager to a
   * caller that passed no context, `@InjectTransactionManager` on the worker
   * opens the transaction the two writes share.
   */
  @InjectManager()
  async persistToken(
    token: PersistedToken,
    meta: { accountLogin?: string } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    await this.persistToken_(token, meta, sharedContext);
  }

  @InjectTransactionManager()
  protected async persistToken_(
    token: PersistedToken,
    meta: { accountLogin?: string } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const existing = await this.listAllegroAuths({}, {}, sharedContext);
    const key = this.options_.encryptionKey;

    // The new row goes in before the old one comes out. If the insert fails the
    // transaction rolls back and the previous working connection is untouched.
    await this.createAllegroAuths(
      [
        {
          access_token_encrypted: encryptValue(token.accessToken, key),
          account_login: meta.accountLogin ?? null,
          connected_at: new Date(),
          expires_at: new Date(token.expiresAt),
          refresh_token_encrypted: token.refreshToken
            ? encryptValue(token.refreshToken, key)
            : null,
          scope: token.scope ?? null,
        },
      ],
      sharedContext,
    );

    if (existing.length > 0) {
      await this.deleteAllegroAuths(
        existing.map((row) => (row as { id: string }).id),
        sharedContext,
      );
    }

    // The memoized client still holds the tokens of the connection that was just
    // replaced.
    this.invalidateClient();
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
    // Invalidate first: the client is dead either way, and dropping it before
    // the delete means a caller cannot get a live client back for a connection
    // that is already on its way out.
    this.invalidateClient();

    const rows = await this.listAllegroAuths({});
    if (rows.length === 0) {
      return;
    }
    await this.deleteAllegroAuths(rows.map((row) => (row as { id: string }).id));
  }

  /** Drop the memoized client, so the next `getClient` reads storage again. */
  protected invalidateClient(): void {
    this.client_ = undefined;
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
   * The client is memoized for the life of the service instance, and that is
   * what makes the SDK's refresh de-duplication mean anything: building a fresh
   * client per call gave every caller its own `refreshing` promise, so two
   * concurrent callers each exchanged the refresh token and the second burned the
   * token the first had just rotated. `persistToken` and `deleteConnection` drop
   * the memo, because both change which credential is live.
   *
   * NOTE: de-duplication is still per process. Two Medusa instances (server plus
   * worker, or several replicas) can each hold their own memoized client and
   * still race on a rotation. A cross-process lock belongs with the worker mode
   * work in a later wave; until then run the sync loops in one instance.
   */
  async getClient(): Promise<AllegroClient | null> {
    if (this.client_) {
      return this.client_;
    }

    const token = await this.loadToken();
    if (!token) {
      // Deliberately not memoized: "not connected" is a state a connect flow
      // changes from outside this method, and caching it would need an
      // invalidation hook on a path that has nothing to invalidate yet.
      return null;
    }

    const o = this.options_;
    // `??=`, not `=`: a concurrent caller may have finished building one while
    // the `loadToken` above was awaiting, and both callers must get the same
    // instance or the refresh de-duplication is defeated again.
    this.client_ ??= new AllegroClient({
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
    return this.client_;
  }
}

export default AllegroModuleService;
