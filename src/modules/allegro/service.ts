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
  isInvoiceAttachDisabledByEnv,
  isOrdersSyncDisabledByEnv,
  isPriceSyncDisabledByEnv,
  isStockSyncDisabledByEnv,
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
import type { FailureState } from "../../lib/sync/failure-state";
import AllegroAuth from "./models/allegro-auth";
import AllegroCategoryRate from "./models/allegro-category-rate";
import AllegroOffer from "./models/allegro-offer";
import AllegroOrder from "./models/allegro-order";
import AllegroPricePush from "./models/allegro-price-push";
import AllegroSyncState from "./models/allegro-sync-state";

/** The distinct sync loops, each with its own state row, claim and kill switch. */
export const ALLEGRO_SYNC_PROVIDERS = {
  OFFERS: "offers",
  ORDERS: "orders",
  PRICES: "prices",
  PRICE_AUTOMATION: "price-automation",
  STOCK: "stock",
} as const;

export type AllegroSyncProvider =
  (typeof ALLEGRO_SYNC_PROVIDERS)[keyof typeof ALLEGRO_SYNC_PROVIDERS];

/**
 * A `running` claim whose last heartbeat is older than this is treated as crashed
 * and taken over.
 *
 * Short enough that a process killed mid-run only blocks its loop for a few ticks;
 * without a staleness window one crash wedges the loop until somebody edits the row
 * by hand.
 *
 * It is safe to keep it this short ONLY because a live run now heartbeats (see
 * `touchSyncClaim`). Before that, the window was measured from the moment the claim
 * was taken, so anything slower than six minutes was taken over MID-FLIGHT and two
 * runs pushed to Allegro at once - and the slow cases are routine, not exotic: the
 * orders drain refreshes up to 100 forms sequentially, the stock loop polls each
 * command for up to 120 seconds, and a manual full-catalogue price run is minutes of
 * sequential commands.
 */
export const STALE_CLAIM_MS = 6 * 60_000;

/**
 * How often a long run re-asserts its claim.
 *
 * Comfortably inside `STALE_CLAIM_MS` so a run is never taken over while it is making
 * progress, and far enough apart that a per-item heartbeat is one cheap update every
 * minute rather than one per item. Callers may call the heartbeat as often as they
 * like; it throttles itself to this interval.
 */
export const SYNC_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * The single message every entry point returns when a claim is held.
 *
 * A named constant rather than three literals, because the admin has to recognise
 * this case by identity: colliding with a scheduled run is RETRYABLE (try again in
 * a minute and it succeeds), not a failure of the thing the operator asked for.
 * Substring-matching a message would start reporting collisions as hard failures
 * the day the wording changes.
 */
export const SYNC_CLAIM_HELD = "a sync run is already in progress for this provider";

/** The sync-state row, as the loops read it. */
export interface AllegroSyncStateRow {
  id: string;
  provider: string;
  status: "idle" | "running" | "ok" | "error";
  cursor: string | null;
  counts: unknown;
  failures: unknown;
  last_error: string | null;
  last_synced_at: Date | null;
  write_scope_missing: boolean;
  updated_at: Date;
  /** Fencing token of the run holding the claim, when one does. */
  claim_token?: string | null;
  /** When the claim holder last proved it was alive. */
  claim_heartbeat_at?: Date | null;
}

/**
 * The configuration the sync engines read.
 *
 * A structural subset of the resolved options, carrying no credential and no OAuth
 * surface. It lives here rather than in `lib/options` because it is defined by what
 * the engines need, and that is a property of this module.
 */
export interface AllegroSyncOptions {
  automationRules?: { promoted: string; standard: string };
  changeCap: number;
  costsModuleKey: string;
  invoiceModuleKey: string;
  marketplaceId: string;
  regionId?: string;
  salesChannelId?: string;
  salesChannelName?: string;
  srpMetadataKey?: string;
  srpPriceListId?: string;
  stockLocationIds: string[];
}

/**
 * What a loop persists at the end of a run.
 *
 * `counts` is `Record<string, unknown>` rather than a union of the per-provider
 * summary types: the summaries are the providers' own shapes, and pulling them
 * into the service would make every loop's counters part of the module's public
 * contract for no gain. The admin reads them structurally.
 */
export interface AllegroSyncStatePatch {
  status?: "idle" | "running" | "ok" | "error";
  cursor?: string | null;
  counts?: Record<string, unknown> | null;
  failures?: FailureState | null;
  last_error?: string | null;
  last_synced_at?: Date | null;
  write_scope_missing?: boolean;
  claim_token?: string | null;
  claim_heartbeat_at?: Date | null;
}

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
  AllegroOrder,
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
   * The configuration the sync engines read.
   *
   * Distinct from `getPublicOptions` because the engines need fields the admin has
   * no business seeing (`costsModuleKey`, `regionId`) and none of the OAuth surface
   * (`redirectPath`, `scopes`). Both are narrowings of the resolved options, and
   * neither carries the client secret or the encryption key - `getOptions` stays
   * protected precisely so nothing outside the service can reach those.
   */
  getSyncOptions(): Promise<AllegroSyncOptions> {
    const o = this.options_;
    return Promise.resolve({
      automationRules: o.automationRules,
      changeCap: o.changeCap,
      costsModuleKey: o.costsModuleKey,
      invoiceModuleKey: o.invoiceModuleKey,
      marketplaceId: o.marketplaceId,
      regionId: o.regionId,
      salesChannelId: o.salesChannelId,
      salesChannelName: o.salesChannelName,
      srpMetadataKey: o.srpMetadataKey,
      srpPriceListId: o.srpPriceListId,
      stockLocationIds: o.stockLocationIds,
    });
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

  /** Effective quantity-write kill-switch. Same env-wins contract as prices. */
  isStockSyncDisabled(): Promise<boolean> {
    return Promise.resolve(this.options_.stockSyncDisabled || isStockSyncDisabledByEnv());
  }

  /** Effective order-drain kill-switch. Same env-wins contract as prices. */
  isOrdersSyncDisabled(): Promise<boolean> {
    return Promise.resolve(this.options_.ordersSyncDisabled || isOrdersSyncDisabledByEnv());
  }

  /**
   * Effective invoice-attach kill-switch. Same env-wins contract as prices.
   *
   * Its own switch rather than a reading of `ordersSyncDisabled`: pausing the import
   * of orders and refusing to deliver an already-issued invoice are different
   * decisions, and conflating them means one incident response silently causes the
   * other problem.
   */
  isInvoiceAttachDisabled(): Promise<boolean> {
    return Promise.resolve(this.options_.invoiceAttachDisabled || isInvoiceAttachDisabledByEnv());
  }

  /**
   * Every kill switch in one read, for the admin.
   *
   * One method rather than four calls from the route because they are only ever
   * meaningful together: "price sync is off" reads as "nothing is written", which is
   * wrong while stock sync is on.
   */
  async getKillSwitches(): Promise<{
    priceSyncDisabled: boolean;
    stockSyncDisabled: boolean;
    ordersSyncDisabled: boolean;
    invoiceAttachDisabled: boolean;
  }> {
    const [priceSyncDisabled, stockSyncDisabled, ordersSyncDisabled, invoiceAttachDisabled] =
      await Promise.all([
        this.isPriceSyncDisabled(),
        this.isStockSyncDisabled(),
        this.isOrdersSyncDisabled(),
        this.isInvoiceAttachDisabled(),
      ]);
    return {
      invoiceAttachDisabled,
      ordersSyncDisabled,
      priceSyncDisabled,
      stockSyncDisabled,
    };
  }

  // ─── Sync-state: single-flight claim and health ───

  /** The provider's state row, or undefined before its first run. */
  async getSyncState(provider: AllegroSyncProvider): Promise<AllegroSyncStateRow | undefined> {
    const [row] = await this.listAllegroSyncStates({ provider }, { take: 1 });
    return row as AllegroSyncStateRow | undefined;
  }

  /**
   * Create the provider's state row if it does not exist yet, and return it.
   *
   * Separate from the claim so the claim can be a pure compare-and-set: a claim
   * that also had to handle "no row yet" would need an insert path whose
   * concurrency story is different from its update path.
   */
  async ensureSyncState(provider: AllegroSyncProvider): Promise<AllegroSyncStateRow> {
    const existing = await this.getSyncState(provider);
    if (existing) {
      return existing;
    }
    const [created] = await this.createAllegroSyncStates([{ provider, status: "idle" }]);
    return created as unknown as AllegroSyncStateRow;
  }

  /**
   * Atomically claim a run for one provider.
   *
   * Two loops must never overlap. Price sync would double-push commands; the
   * orders drain would interleave two full item replacements on the same order.
   * A scheduled job and an operator pressing "run now" are exactly the collision
   * this prevents.
   *
   * Shape: read the row, decide LOCALLY whether a non-stale run holds the claim,
   * then update conditioned on `updated_at` still being the value that was read.
   * A concurrent claimant bumps `updated_at`, which invalidates the match, so the
   * loser's update affects zero rows. That count is the answer -
   * `updateAllegroSyncStates` with a selector returns the rows it touched, so an
   * empty result means somebody else won.
   *
   * The bump is ORM-managed, and it is worth naming precisely because the whole
   * claim rests on it: Medusa's DML declares `updated_at` with
   * `onUpdate: () => new Date()` (see `@medusajs/utils`,
   * `dml/helpers/entity-builder/define-property.js`), so Mikro-ORM writes a fresh
   * value on every update flush. The `default now()` in the DDL is NOT what does
   * it - a column default only applies on insert - so a future change that
   * replaced the DML-defined timestamp with a plain column would silently break
   * single-flight while every test that fakes the table still passed.
   *
   * This is the Medusa equivalent of the trigger-plus-optimistic-filter pattern
   * used against Postgres directly. There is no trigger to write here; the ORM's
   * own `updated_at` maintenance plays that role, the `WHERE updated_at = X` is
   * what makes it atomic at the database, and the verification is on affected rows
   * rather than on trusting the filter.
   */
  async claimSyncRun(provider: AllegroSyncProvider): Promise<{
    acquired: boolean;
    state?: AllegroSyncStateRow;
    reason?: string;
    /** Fencing token to pass to every later write. Present only when acquired. */
    token?: string;
  }> {
    const state = await this.ensureSyncState(provider);

    // Staleness is measured from the last HEARTBEAT, falling back to `updated_at` for a
    // row written before the column existed. Measuring from `updated_at` alone was the
    // bug: it is bumped when the claim is taken and then not again until the run ends, so
    // any run slower than the window was taken over mid-flight.
    const lastAlive = new Date(state.claim_heartbeat_at ?? state.updated_at).getTime();
    const isRunning = state.status === "running";
    const isStale = !Number.isFinite(lastAlive) || Date.now() - lastAlive > STALE_CLAIM_MS;
    if (isRunning && !isStale) {
      return { acquired: false, reason: SYNC_CLAIM_HELD, state };
    }
    if (isRunning && isStale) {
      this.logger_?.warn(
        `[medusa-allegro] taking over a stale "${provider}" sync claim last alive at ${new Date(lastAlive).toISOString()}; the previous run appears to have crashed.`,
      );
    }

    const token = crypto.randomUUID();
    const claimed = await this.updateAllegroSyncStates({
      data: { claim_heartbeat_at: new Date(), claim_token: token, status: "running" },
      selector: { provider, updated_at: state.updated_at },
    });
    if ((claimed as unknown[]).length === 0) {
      return { acquired: false, reason: SYNC_CLAIM_HELD, state };
    }
    // The PRE-claim row is returned on purpose: the cursor and failure state a run
    // needs are the ones from before it took the claim, and reading them again
    // afterwards is a second round trip for the same values.
    return { acquired: true, state, token };
  }

  /**
   * Re-assert an existing claim, proving the run is still alive.
   *
   * Returns false when the claim has been LOST - taken over as stale, or released by
   * something else - and a false answer means the caller must stop writing immediately.
   * It no longer owns the provider, so anything further it wrote would be trampling the
   * run that replaced it, and any Allegro command it issued would be concurrent with that
   * run's commands.
   *
   * The write has to change a value, which is why `claim_heartbeat_at` exists: an update
   * whose fields all already match may not flush, and then the ORM's `onUpdate` would not
   * bump `updated_at` either, so the heartbeat would be a silent no-op reported as
   * success.
   */
  async touchSyncClaim(provider: AllegroSyncProvider, token: string): Promise<boolean> {
    const touched = await this.updateAllegroSyncStates({
      data: { claim_heartbeat_at: new Date() },
      selector: { claim_token: token, provider },
    });
    return (touched as unknown[]).length > 0;
  }

  /**
   * Persist a run's outcome.
   *
   * `token` is the fencing token from `claimSyncRun`. With it, the write only lands while
   * this run still holds the claim, and the return value says whether it did. Without it
   * the write is unconditional, which is only appropriate for a caller that is not
   * operating under a claim at all.
   *
   * `failures: null` clears the column, which is what an empty failure state must
   * write - a `{}`-shaped json blob reads as "some bookkeeping exists" in every
   * later query and in the admin.
   */
  async writeSyncState(
    provider: AllegroSyncProvider,
    patch: AllegroSyncStatePatch,
    opts: { token?: string } = {},
  ): Promise<boolean> {
    await this.ensureSyncState(provider);
    // Spread into a fresh literal: the generated CRUD signature wants an
    // index-signature shape, and `FailureState` is a closed interface on purpose -
    // an index signature on it would let a typo through at every call site that
    // builds one.
    const data: Record<string, unknown> = { ...patch };
    const written = await this.updateAllegroSyncStates({
      data,
      selector: opts.token === undefined ? { provider } : { claim_token: opts.token, provider },
    });
    return (written as unknown[]).length > 0;
  }

  /**
   * Write state from a caller that does NOT hold the claim, without disturbing a live run.
   *
   * For the pre-claim early exits: a kill switch or a missing connection has to be recorded
   * ("disabled" and "broken" both look like "nothing happened" from outside), but the row
   * may belong to a run that is currently in flight. Writing unconditionally was a real
   * hazard rather than a cosmetic one: `status: "idle"` on a row held by a live run makes
   * the NEXT tick's claim succeed, so two runs execute concurrently - which is precisely
   * what the claim exists to prevent.
   *
   * So a live, non-stale `running` row is left completely alone and the caller is told the
   * write was skipped. The check is a read-then-write rather than one atomic statement, and
   * that is acceptable here in a way it would not be for the claim itself: the worst
   * outcome of losing this race is a status field briefly disagreeing, whereas the claim
   * being wrong means two concurrent writers on a live marketplace.
   */
  async writeSyncStateIfUnclaimed(
    provider: AllegroSyncProvider,
    patch: AllegroSyncStatePatch,
  ): Promise<boolean> {
    const state = await this.ensureSyncState(provider);
    const lastAlive = new Date(state.claim_heartbeat_at ?? state.updated_at).getTime();
    const isStale = !Number.isFinite(lastAlive) || Date.now() - lastAlive > STALE_CLAIM_MS;
    if (state.status === "running" && !isStale) {
      return false;
    }
    const data: Record<string, unknown> = { ...patch };
    await this.updateAllegroSyncStates({ data, selector: { provider } });
    return true;
  }

  /**
   * Release a claim without recording an outcome.
   *
   * For the caller that could not even start - a kill switch, a missing
   * connection - where leaving the row `running` would make the next tick take it
   * over as stale instead of simply skipping again.
   *
   * Takes the fencing token, so a run that has already lost its claim cannot release
   * somebody else's.
   */
  async releaseSyncRun(
    provider: AllegroSyncProvider,
    opts: { token?: string; lastError?: string | null } = {},
  ): Promise<boolean> {
    return await this.writeSyncState(
      provider,
      {
        ...(opts.lastError === undefined ? {} : { last_error: opts.lastError }),
        // Cleared together with the status: a released row holds no claim, and leaving a
        // stale token behind would let a dead run's heartbeat resurrect it.
        claim_token: null,
        status: opts.lastError ? "error" : "idle",
      },
      { token: opts.token },
    );
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
