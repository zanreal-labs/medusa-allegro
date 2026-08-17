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
import {
  CONFIG_FIELDS,
  resolveEffectiveConfigValue,
} from "../../lib/config-fields";
import type {
  ConfigFieldColumn,
  ConfigFieldKey,
} from "../../lib/config-fields";
import { decryptValue, encryptValue } from "../../lib/crypto";
import {
  automationRulePromotedEnvOverride,
  automationRuleStandardEnvOverride,
  changeCapEnvOverride,
  isFulfillmentWritebackDisabledByEnv,
  isInvoiceAttachDisabledByEnv,
  isOrdersSyncDisabledByEnv,
  isPriceSyncDisabledByEnv,
  isStockSyncDisabledByEnv,
  marketplaceIdEnvOverride,
  pricingModeEnvOverride,
  resolveAllegroOptions,
  salesChannelIdEnvOverride,
  salesChannelNameEnvOverride,
  srpMetadataKeyEnvOverride,
  srpPriceListIdEnvOverride,
  toPublicAllegroOptions,
} from "../../lib/options";
import type {
  AllegroPluginOptions,
  AllegroPublicOptions,
  ResolvedAllegroOptions,
} from "../../lib/options";
import { mintOAuthState, verifyOAuthState } from "../../lib/oauth-state";
import {
  coercePricingMode,
  DEFAULT_PRICING_MODE,
  isPricingMode,
  PRICING_MODE_VALUES,
} from "../../lib/pricing-mode";
import type { PricingMode } from "../../lib/pricing-mode";
import type { OAuthStateVerification } from "../../lib/oauth-state";
import {
  FRESH_INSTALL_SETTINGS,
  resolveEffectiveEnabled,
  RUNTIME_TOGGLES,
} from "../../lib/runtime-toggles";
import type {
  RuntimeToggleColumn,
  RuntimeToggleKey,
} from "../../lib/runtime-toggles";
import type { FailureState } from "../../lib/sync/failure-state";
import AllegroAuth from "./models/allegro-auth";
import AllegroCategoryRate from "./models/allegro-category-rate";
import AllegroOffer from "./models/allegro-offer";
import AllegroOrder from "./models/allegro-order";
import AllegroPricePush from "./models/allegro-price-push";
import AllegroSettings from "./models/allegro-settings";
import AllegroSyncState from "./models/allegro-sync-state";

/**
 * The fixed primary key of the settings singleton.
 *
 * A constant id rather than a generated one makes the row a genuine singleton: a
 * second insert collides on the primary key, so concurrent first-reads cannot leave
 * two rows behind, and every read targets the same key.
 */
export const ALLEGRO_SETTINGS_ID = "algset_singleton";

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
export const SYNC_CLAIM_HELD =
  "a sync run is already in progress for this provider";

/**
 * The persisted settings singleton, as callers read it.
 *
 * The five `*_enabled` columns are the runtime toggles; the rest are the editable
 * sync-configuration fields (see `src/lib/config-fields.ts`). Every configuration
 * column is nullable with no persisted default - `null` means "nothing entered in
 * the admin, fall back to the `medusa-config.ts` option".
 */
export interface AllegroSettingsRow {
  id: string;
  pricing_mode: string | null;
  price_sync_enabled: boolean;
  stock_sync_enabled: boolean;
  orders_sync_enabled: boolean;
  fulfillment_writeback_enabled: boolean;
  invoice_attach_enabled: boolean;
  automation_rule_standard: string | null;
  automation_rule_promoted: string | null;
  srp_metadata_key: string | null;
  srp_price_list_id: string | null;
  change_cap: number | null;
  marketplace_id: string | null;
  sales_channel_id: string | null;
  sales_channel_name: string | null;
}

/**
 * A runtime toggle as the admin renders it.
 *
 * `persistedEnabled` is the stored arming; `forceDisabled` is the environment (or
 * boot-option) override that can only force off; `effectiveEnabled` is what the
 * runtime paths actually honour. The UI binds the switch to `persistedEnabled` and
 * locks it, showing "forced off by environment", whenever `forceDisabled` is set -
 * so it never reports an armed writer that the environment is silently holding off.
 */
export interface AllegroRuntimeToggleState {
  key: RuntimeToggleKey;
  column: RuntimeToggleColumn;
  label: string;
  description: string;
  envVar: string;
  persistedEnabled: boolean;
  forceDisabled: boolean;
  effectiveEnabled: boolean;
}

/**
 * A configuration field as the admin renders it.
 *
 * `persistedValue` is what an operator entered (or `null` if nothing was);
 * `envOverride` is the environment lock, which can only be a value or absent -
 * unlike a toggle's force-disable, there is no "off" for a string or a number, so
 * a set override wins outright; `effectiveValue` is what `getSyncOptions()`
 * actually resolves. `locked` mirrors a toggle's `forceDisabled`: the admin
 * disables the input and explains why, exactly like a writer forced off by the
 * environment.
 */
export interface AllegroConfigFieldState {
  key: ConfigFieldKey;
  column: ConfigFieldColumn;
  label: string;
  description: string;
  envVar: string;
  kind: "text" | "number" | "choice";
  choices?: readonly { value: string; label: string; description: string }[];
  wiringCritical: boolean;
  persistedValue: string | number | null;
  envOverride: string | number | null;
  configDefault: string | number | null;
  effectiveValue: string | number | null;
  locked: boolean;
}

/**
 * The columns an admin write may set on the settings singleton.
 *
 * The configuration half is spelled out column-by-column, rather than
 * `Record<ConfigFieldColumn, string | number | null>`, because the columns are NOT
 * interchangeably typed: `change_cap` is a number, the rest are text. A blanket
 * `string | number` would let a number through for a text column, and it would
 * make this type structurally incompatible with the generated model row type -
 * which is exactly the shape `updateAllegroSettings` demands - and turn every
 * write into a "no overload matches" compile error instead of the one bad field
 * actually being rejected.
 */
export type AllegroSettingsPatch = Partial<
  Record<RuntimeToggleColumn, boolean>
> & {
  pricing_mode?: string | null;
  automation_rule_standard?: string | null;
  automation_rule_promoted?: string | null;
  srp_metadata_key?: string | null;
  srp_price_list_id?: string | null;
  change_cap?: number | null;
  marketplace_id?: string | null;
  sales_channel_id?: string | null;
  sales_channel_name?: string | null;
};

/** The sync-state row, as the loops read it. */
export interface AllegroSyncStateRow {
  id: string;
  provider: string;
  status: "idle" | "running" | "ok" | "error" | "disabled";
  cursor: string | null;
  counts: unknown;
  failures: unknown;
  last_error: string | null;
  last_finding: string | null;
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
  /** The chosen pricing strategy, and therefore what the price loop may write. */
  pricingMode: PricingMode;
  automationRules?: { promoted: string; standard: string };
  changeCap: number;
  costsModuleKey: string;
  invoiceModuleKey: string;
  marketplaceId: string;
  regionId?: string;
  salesChannelId?: string;
  salesChannelName?: string;
  srpFallbackMarkupPercent?: number;
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
  status?: "idle" | "running" | "ok" | "error" | "disabled";
  cursor?: string | null;
  counts?: Record<string, unknown> | null;
  failures?: FailureState | null;
  last_error?: string | null;
  last_finding?: string | null;
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
  AllegroSettings,
  AllegroSyncState,
}) {
  protected readonly options_: ResolvedAllegroOptions;
  protected readonly logger_?: AllegroServiceLogger;

  /**
   * Memoized authenticated client. See `getClient` for why it exists and when it
   * is dropped.
   */
  protected client_?: AllegroClient;

  constructor(
    container: Record<string, unknown>,
    options: AllegroPluginOptions,
  ) {
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
   *
   * Eight of these fields used to be read straight off `this.options_` - the
   * `medusa-config.ts` constructor options, fixed until a redeploy. They are now
   * resolved through `resolveAllConfigFields()`: the environment lock if an
   * operator set one, else the persisted admin value if one was entered, else the
   * same `medusa-config.ts` default as before. A store that never touches the new
   * admin fields gets exactly the old behaviour, because every persisted column
   * starts `null`.
   */
  async getSyncOptions(): Promise<AllegroSyncOptions> {
    const o = this.options_;
    const resolved = await this.resolveAllConfigFields();

    const standard = resolved.automationRuleStandard.effectiveValue;
    const promoted = resolved.automationRulePromoted.effectiveValue;
    const srpMetadataKey = resolved.srpMetadataKey.effectiveValue;
    const srpPriceListId = resolved.srpPriceListId.effectiveValue;
    const salesChannelId = resolved.salesChannelId.effectiveValue;
    const salesChannelName = resolved.salesChannelName.effectiveValue;

    return {
      // Both names are required for a real automation rule assignment - see
      // `resolveAutomationRules` - so a mix where only one resolves to a value is
      // read the same way that plugin option always was: inert, not half-applied.
      automationRules:
        typeof standard === "string" &&
        standard &&
        typeof promoted === "string" &&
        promoted
          ? { promoted, standard }
          : undefined,
      changeCap:
        (resolved.changeCap.effectiveValue as number | null) ?? o.changeCap,
      costsModuleKey: o.costsModuleKey,
      invoiceModuleKey: o.invoiceModuleKey,
      marketplaceId:
        (resolved.marketplaceId.effectiveValue as string | null) ??
        o.marketplaceId,
      // Coerced rather than cast: the column is free text, so a row written by an
      // older build, by hand, or by a future mode this build does not know about
      // must read as the default instead of steering the loop with a value it
      // cannot honour.
      pricingMode: coercePricingMode(resolved.pricingMode.effectiveValue),
      regionId: o.regionId,
      salesChannelId:
        typeof salesChannelId === "string" && salesChannelId
          ? salesChannelId
          : undefined,
      salesChannelName:
        typeof salesChannelName === "string" && salesChannelName
          ? salesChannelName
          : undefined,
      srpMetadataKey:
        typeof srpMetadataKey === "string" && srpMetadataKey
          ? srpMetadataKey
          : undefined,
      srpPriceListId:
        typeof srpPriceListId === "string" && srpPriceListId
          ? srpPriceListId
          : undefined,
      stockLocationIds: o.stockLocationIds,
    };
  }

  /**
   * The pricing strategy in force right now.
   *
   * Its own accessor because the price loop has to know the mode BEFORE it takes
   * the sync claim: `monitor` is not a run that writes nothing, it is a run that
   * must not be allowed to write, and the loop reports that the same way it
   * reports a kill switch rather than by taking a claim and then doing nothing.
   */
  async getPricingMode(): Promise<PricingMode> {
    const resolved = await this.resolveAllConfigFields();
    return coercePricingMode(resolved.pricingMode.effectiveValue);
  }

  // ─── Runtime toggles: the persisted, operator-flippable arming ───

  /**
   * The settings singleton, created with the fresh-install defaults on first read.
   *
   * Every runtime path resolves its effective arming from this row at the top of its
   * tick/handler, so an operator flipping a toggle in the admin takes effect on the
   * next run without a redeploy. The fixed id makes it a true singleton: a concurrent
   * first-read that loses the insert re-reads the winner's row rather than duplicating
   * it, and a config singleton written this rarely never contends in practice.
   */
  async getSettings(): Promise<AllegroSettingsRow> {
    const existing = await this.readSettingsRow();
    if (existing) {
      return existing;
    }
    try {
      const [created] = await this.createAllegroSettings([
        { id: ALLEGRO_SETTINGS_ID, ...FRESH_INSTALL_SETTINGS },
      ]);
      return created as unknown as AllegroSettingsRow;
    } catch (error) {
      // A concurrent first-read won the insert under the fixed id. The row exists now.
      const row = await this.readSettingsRow();
      if (row) {
        return row;
      }
      throw error;
    }
  }

  /** The stored singleton row, or undefined before its first read created it. */
  protected async readSettingsRow(): Promise<AllegroSettingsRow | undefined> {
    const [row] = await this.listAllegroSettings(
      { id: ALLEGRO_SETTINGS_ID },
      { take: 1 },
    );
    return row as unknown as AllegroSettingsRow | undefined;
  }

  /**
   * Arm or disarm writers, and/or edit sync-configuration fields, by writing the
   * persisted singleton.
   *
   * Only the columns present in `patch` are written, so arming one writer - or
   * editing one configuration field - does not disturb another. A toggle write the
   * environment force-disables is accepted and stored - the operator is recording
   * intent for when the override is lifted - and the returned effective state still
   * shows it held off, never a lie. `null` on a configuration column clears it back
   * to its `medusa-config.ts` fallback, the same "clear" contract the category-rate
   * route already uses.
   *
   * Rejects a configuration write that would newly collide the two automation rule
   * names, or newly set both SRP sources, once resolved against whatever governs
   * the OTHER half of the pair (persisted, env-locked, or configured). Those two
   * pairs have a boot-time uniqueness check when both come from
   * `medusa-config.ts` (`resolveAutomationRules`, `resolveAllegroOptions`) - this is
   * the same invariant, extended to the case an admin edit newly creates.
   */
  async updateSettings(
    patch: AllegroSettingsPatch,
  ): Promise<AllegroSettingsRow> {
    // Ensure the singleton exists before the conditional update, so a first-ever write
    // through the admin has a row to land on.
    await this.getSettings();
    await this.assertConfigWriteIsSafe(patch);
    await this.updateAllegroSettings([{ id: ALLEGRO_SETTINGS_ID, ...patch }]);
    const row = await this.readSettingsRow();
    if (!row) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "medusa-allegro: the settings singleton disappeared between write and read.",
      );
    }
    return row;
  }

  /**
   * The environment/boot-option force-disable for every writer, by key.
   *
   * Re-reads the environment on every call rather than trusting the value captured at
   * boot, so `ALLEGRO_PRICE_SYNC_DISABLED=1` and its siblings take effect on a
   * restart-free redeploy of the process environment too. The environment (and a
   * boot-time plugin option) can ONLY force a writer off; a set override beats a
   * persisted `true`.
   */
  private forceDisabledByKey(): Record<RuntimeToggleKey, boolean> {
    const o = this.options_;
    return {
      fulfillmentWriteback:
        o.fulfillmentWritebackDisabled || isFulfillmentWritebackDisabledByEnv(),
      invoiceAttach: o.invoiceAttachDisabled || isInvoiceAttachDisabledByEnv(),
      ordersSync: o.ordersSyncDisabled || isOrdersSyncDisabledByEnv(),
      priceSync: o.priceSyncDisabled || isPriceSyncDisabledByEnv(),
      stockSync: o.stockSyncDisabled || isStockSyncDisabledByEnv(),
    };
  }

  /** effectiveEnabled for one writer: persisted arming, unless an override forces off. */
  private async resolveWriterEnabled(
    key: RuntimeToggleKey,
    column: RuntimeToggleColumn,
  ): Promise<boolean> {
    const settings = await this.getSettings();
    return resolveEffectiveEnabled(
      settings[column] === true,
      this.forceDisabledByKey()[key],
    );
  }

  /**
   * Effective price-sync kill-switch: disabled unless the persisted toggle is armed
   * and no override forces it off. Read at the top of every price run and re-read
   * per item, so flipping the toggle stops an in-flight run without a restart.
   */
  async isPriceSyncDisabled(): Promise<boolean> {
    return !(await this.resolveWriterEnabled(
      "priceSync",
      "price_sync_enabled",
    ));
  }

  /** Effective quantity-write kill-switch. Same persisted-plus-override contract. */
  async isStockSyncDisabled(): Promise<boolean> {
    return !(await this.resolveWriterEnabled(
      "stockSync",
      "stock_sync_enabled",
    ));
  }

  /** Effective order-drain kill-switch. Same persisted-plus-override contract. */
  async isOrdersSyncDisabled(): Promise<boolean> {
    return !(await this.resolveWriterEnabled(
      "ordersSync",
      "orders_sync_enabled",
    ));
  }

  /**
   * Effective fulfillment-write-back kill-switch.
   *
   * NEW: this event-driven write had no kill switch at all before, so a store could
   * not stop it reaching the marketplace short of pulling the subscriber. Defaults
   * OFF like every other writer, resolved from the persisted toggle at the top of
   * each fulfillment event.
   */
  async isFulfillmentWritebackDisabled(): Promise<boolean> {
    return !(await this.resolveWriterEnabled(
      "fulfillmentWriteback",
      "fulfillment_writeback_enabled",
    ));
  }

  /**
   * Effective invoice-attach kill-switch.
   *
   * Its own switch rather than a reading of `ordersSyncDisabled`: pausing the import
   * of orders and refusing to deliver an already-issued invoice are different
   * decisions, and conflating them means one incident response silently causes the
   * other problem. Defaults ON (enabled-but-inert until an invoicing module is wired).
   */
  async isInvoiceAttachDisabled(): Promise<boolean> {
    return !(await this.resolveWriterEnabled(
      "invoiceAttach",
      "invoice_attach_enabled",
    ));
  }

  /**
   * Every runtime toggle, resolved for the admin.
   *
   * One method rather than five calls from the route because the writers are only
   * meaningful together, and each entry carries what the UI needs to render an honest
   * switch: the persisted arming it binds to, the environment override that locks it,
   * and the effective state that results. Reads the singleton once and reuses it.
   */
  async getRuntimeToggleStates(): Promise<AllegroRuntimeToggleState[]> {
    const settings = await this.getSettings();
    const forced = this.forceDisabledByKey();
    return RUNTIME_TOGGLES.map((meta) => {
      const persistedEnabled = settings[meta.column] === true;
      const forceDisabled = forced[meta.key];
      return {
        column: meta.column,
        description: meta.description,
        effectiveEnabled: resolveEffectiveEnabled(
          persistedEnabled,
          forceDisabled,
        ),
        envVar: meta.envVar,
        forceDisabled,
        key: meta.key,
        label: meta.label,
        persistedEnabled,
      };
    });
  }

  // ─── Sync configuration: the persisted, operator-editable fields ───

  /**
   * The environment lock for every editable configuration field, by key.
   *
   * Re-read on every call rather than trusting a value captured at boot, matching
   * the toggle overrides: an operator setting `ALLEGRO_MARKETPLACE_ID` or
   * `ALLEGRO_SALES_CHANNEL_ID` is pinning a wiring-critical value against an admin
   * mistake, and that has to take effect without a restart.
   */
  private configFieldEnvOverrides(): Record<
    ConfigFieldKey,
    string | number | undefined
  > {
    return {
      automationRulePromoted: automationRulePromotedEnvOverride(),
      automationRuleStandard: automationRuleStandardEnvOverride(),
      changeCap: changeCapEnvOverride(),
      marketplaceId: marketplaceIdEnvOverride(),
      pricingMode: pricingModeEnvOverride(),
      salesChannelId: salesChannelIdEnvOverride(),
      salesChannelName: salesChannelNameEnvOverride(),
      srpMetadataKey: srpMetadataKeyEnvOverride(),
      srpPriceListId: srpPriceListIdEnvOverride(),
    };
  }

  /**
   * The `medusa-config.ts` default for every editable configuration field, by key.
   *
   * The fallback of last resort - what `getSyncOptions` returned for these fields
   * before any of them were persisted, so an unedited field behaves exactly as it
   * always did.
   */
  private configFieldDefaults(): Record<
    ConfigFieldKey,
    string | number | null
  > {
    const o = this.options_;
    return {
      automationRulePromoted: o.automationRules?.promoted ?? null,
      automationRuleStandard: o.automationRules?.standard ?? null,
      changeCap: o.changeCap,
      marketplaceId: o.marketplaceId,
      pricingMode: o.pricingMode ?? DEFAULT_PRICING_MODE,
      salesChannelId: o.salesChannelId ?? null,
      salesChannelName: o.salesChannelName ?? null,
      srpMetadataKey: o.srpMetadataKey ?? null,
      srpPriceListId: o.srpPriceListId ?? null,
    };
  }

  /**
   * Every editable configuration field, resolved: persisted value, environment
   * lock, `medusa-config.ts` default, and the effective value that wins.
   *
   * One method rather than eight separate lookups because `getSyncOptions` and
   * `getConfigFieldStates` both need every field, and this reads the settings
   * singleton exactly once for all of them.
   */
  private async resolveAllConfigFields(): Promise<
    Record<
      ConfigFieldKey,
      {
        persistedValue: string | number | null;
        envOverride: string | number | null;
        configDefault: string | number | null;
        effectiveValue: string | number | null;
        locked: boolean;
      }
    >
  > {
    const settings = await this.getSettings();
    const overrides = this.configFieldEnvOverrides();
    const defaults = this.configFieldDefaults();

    const result = {} as Record<
      ConfigFieldKey,
      {
        persistedValue: string | number | null;
        envOverride: string | number | null;
        configDefault: string | number | null;
        effectiveValue: string | number | null;
        locked: boolean;
      }
    >;
    for (const meta of CONFIG_FIELDS) {
      const persistedValue = settings[meta.column] ?? null;
      const envOverride = overrides[meta.key] ?? null;
      const configDefault = defaults[meta.key] ?? null;
      result[meta.key] = {
        configDefault,
        effectiveValue: resolveEffectiveConfigValue(
          envOverride,
          persistedValue,
          configDefault,
        ),
        envOverride,
        locked: envOverride !== null,
        persistedValue,
      };
    }
    return result;
  }

  /**
   * Every configuration field, resolved for the admin.
   *
   * Mirrors `getRuntimeToggleStates`: each entry carries what the UI needs to
   * render an honest input - the persisted value it binds to, the environment
   * lock that disables it, and the effective value `getSyncOptions` actually uses.
   */
  async getConfigFieldStates(): Promise<AllegroConfigFieldState[]> {
    const resolved = await this.resolveAllConfigFields();
    return CONFIG_FIELDS.map((meta) => ({
      ...meta,
      ...resolved[meta.key],
    }));
  }

  /**
   * Reject a configuration write that would newly collide the two automation
   * rule names, or newly set both SRP sources.
   *
   * Resolves what EACH half of the pair would be after this patch - using the
   * patched value where the patch touches that column, the already-effective
   * value otherwise - so a collision is caught whatever mix of persisted,
   * env-locked or configured values produces it. A no-op write (neither column in
   * the pair is touched) can never newly collide anything, so this only does work
   * when the patch actually carries a configuration column.
   */
  private async assertConfigWriteIsSafe(
    patch: AllegroSettingsPatch,
  ): Promise<void> {
    const touchesConfig = CONFIG_FIELDS.some((field) => field.column in patch);
    if (!touchesConfig) {
      return;
    }

    // Checked here as well as in the write route, because the service is the
    // module's public surface: a workflow or another plugin calling
    // `updateSettings` directly must not be able to persist a mode the loop
    // cannot honour, and "unknown mode silently means automation_rule" is a much
    // worse answer at the moment of the write than it is at read time.
    if ("pricing_mode" in patch && patch.pricing_mode !== null) {
      if (!isPricingMode(patch.pricing_mode)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `\`pricing_mode\` must be one of ${PRICING_MODE_VALUES.join(", ")}, or null to fall back to the configured default (got "${String(patch.pricing_mode)}").`,
        );
      }
    }

    const current = await this.resolveAllConfigFields();
    const effectiveAfterPatch = (
      key: ConfigFieldKey,
      column: ConfigFieldColumn,
    ): string | number | null => {
      if (!(column in patch)) {
        return current[key].effectiveValue;
      }
      return resolveEffectiveConfigValue(
        current[key].envOverride,
        patch[column] ?? null,
        current[key].configDefault,
      );
    };

    const standard = effectiveAfterPatch(
      "automationRuleStandard",
      "automation_rule_standard",
    );
    const promoted = effectiveAfterPatch(
      "automationRulePromoted",
      "automation_rule_promoted",
    );
    if (
      typeof standard === "string" &&
      standard !== "" &&
      standard === promoted
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `This write would make the standard and promoted automation rule both resolve to "${standard}". A promotion flip would then be a no-op switch, so the promoted commission rate would never reach the price floor. Use two distinct rules.`,
      );
    }

    const srpMetadataKey = effectiveAfterPatch(
      "srpMetadataKey",
      "srp_metadata_key",
    );
    const srpPriceListId = effectiveAfterPatch(
      "srpPriceListId",
      "srp_price_list_id",
    );
    if (srpMetadataKey && srpPriceListId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "`srp_metadata_key` and `srp_price_list_id` would both resolve to a value. They are mutually exclusive - configure exactly one source for the SRP ceiling.",
      );
    }
  }

  // ─── Sync-state: single-flight claim and health ───

  /** The provider's state row, or undefined before its first run. */
  async getSyncState(
    provider: AllegroSyncProvider,
  ): Promise<AllegroSyncStateRow | undefined> {
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
  async ensureSyncState(
    provider: AllegroSyncProvider,
  ): Promise<AllegroSyncStateRow> {
    const existing = await this.getSyncState(provider);
    if (existing) {
      return existing;
    }
    const [created] = await this.createAllegroSyncStates([
      { provider, status: "idle" },
    ]);
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
    const lastAlive = new Date(
      state.claim_heartbeat_at ?? state.updated_at,
    ).getTime();
    const isRunning = state.status === "running";
    const isStale =
      !Number.isFinite(lastAlive) || Date.now() - lastAlive > STALE_CLAIM_MS;
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
      data: {
        claim_heartbeat_at: new Date(),
        claim_token: token,
        status: "running",
      },
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
  async touchSyncClaim(
    provider: AllegroSyncProvider,
    token: string,
  ): Promise<boolean> {
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
      selector:
        opts.token === undefined
          ? { provider }
          : { claim_token: opts.token, provider },
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
    const lastAlive = new Date(
      state.claim_heartbeat_at ?? state.updated_at,
    ).getTime();
    const isStale =
      !Number.isFinite(lastAlive) || Date.now() - lastAlive > STALE_CLAIM_MS;
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
    opts: {
      token?: string;
      lastError?: string | null;
      finding?: string | null;
    } = {},
  ): Promise<boolean> {
    return await this.writeSyncState(
      provider,
      {
        ...(opts.lastError === undefined ? {} : { last_error: opts.lastError }),
        ...(opts.finding === undefined ? {} : { last_finding: opts.finding }),
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
    return Promise.resolve(
      mintOAuthState(actorId, this.options_.encryptionKey),
    );
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
    return Promise.resolve(
      verifyOAuthState(state, actorId, this.options_.encryptionKey),
    );
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
  async buildAuthorizationUrl(
    state: string,
    requestOrigin?: string,
  ): Promise<string> {
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
  protected async getStoredAuth(): Promise<
    Record<string, unknown> | undefined
  > {
    const rows = await this.listAllegroAuths(
      {},
      { order: { created_at: "DESC" }, take: 2 },
    );

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
      decryptValue(
        row.access_token_encrypted as string,
        this.options_.encryptionKey,
      );
    } catch {
      credentialsUnreadable = true;
    }

    const expiresAt = row.expires_at
      ? new Date(row.expires_at as string)
      : undefined;
    return {
      ...base,
      accountLogin: (row.account_login as string | null) ?? undefined,
      connected: true,
      connectedAt: row.connected_at
        ? new Date(row.connected_at as string)
        : undefined,
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
    await this.deleteAllegroAuths(
      rows.map((row) => (row as { id: string }).id),
    );
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
