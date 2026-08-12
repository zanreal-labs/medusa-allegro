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
  /** Kill-switch for every quantity write. See `priceSyncDisabled`. */
  stockSyncDisabled?: boolean;
  /**
   * Kill-switch for the order event drain. Set it and the journal is not
   * consumed at all, so the cursor holds and no order is imported or updated.
   */
  ordersSyncDisabled?: boolean;
  /**
   * Kill-switch for attaching invoice PDFs to Allegro orders.
   *
   * Deliberately NOT folded into `ordersSyncDisabled`. That switch stops the drain
   * from CONSUMING the journal, and an operator reaches for it to stop a runaway
   * import. Delivering an invoice the marketplace order needs is a different
   * decision with different consequences, and one switch covering both would mean
   * pausing an import silently stops issued invoices reaching buyers.
   *
   * Defaults to enabled (`false`) for the same reason: by the time this plugin
   * hears about an invoice it already exists as a legal document, so the only
   * sensible default is to deliver it.
   */
  invoiceAttachDisabled?: boolean;
  /**
   * Container key of the invoicing module that issues the documents, resolved
   * lazily and optionally. Defaults to `"infakt"`
   * (`@zanreal/medusa-infakt`).
   *
   * A SOFT dependency, duck-typed on the two reads the attach path makes, so a
   * store that invoices somewhere else - or nowhere - is a supported configuration
   * rather than a boot failure. Without the module the invoice chain is simply
   * inert: nothing subscribes usefully and the sweep finds nothing to do.
   */
  invoiceModuleKey?: string;
  /**
   * The two named price-automation rules this plugin attaches, by promotion
   * state. These MUST already exist on the Allegro account: the plugin resolves
   * them by name on every run and refuses to write anything when a name is
   * missing or ambiguous. It never creates or edits a rule.
   *
   * Omit it and price sync stays inert with a recorded error rather than
   * guessing which rule an operator meant.
   */
  automationRules?: { promoted: string; standard: string };
  /**
   * Commands issued per price-sync run. A bug that mislabels the whole catalogue
   * as drifting can reprice at most this many offers before a human sees the run
   * and can flip the kill-switch; the rest waits for the next tick.
   */
  changeCap?: number;
  /**
   * The sales channel that scopes which products are sync-eligible. Only
   * variants of products in this channel are matched against Allegro offers, so
   * a store can sell a subset of its catalogue on Allegro.
   *
   * `salesChannelId` is exact; `salesChannelName` is resolved by name at run
   * time (handy when the id differs per environment). With neither set the whole
   * catalogue is eligible.
   */
  salesChannelId?: string;
  salesChannelName?: string;
  /**
   * Stock locations whose available quantity is summed into the quantity pushed
   * to Allegro. Empty means every location Medusa knows about.
   */
  stockLocationIds?: string[];
  /**
   * Where the SRP (the price-range ceiling) comes from. Exactly one of the two
   * is used, `srpMetadataKey` first:
   *
   * - `srpMetadataKey` - a numeric value under that key in the variant's
   *   `metadata` (or, failing that, the product's).
   * - `srpPriceListId` - the variant's price in that price list.
   *
   * With neither configured - or with no value for a given variant - the offer
   * is skipped with reason `missing-srp`. There is deliberately no fallback to
   * the variant's regular price: a ceiling guessed from the current selling
   * price would let an automation rule ratchet a price down indefinitely.
   */
  srpMetadataKey?: string;
  srpPriceListId?: string;
  /**
   * Container key of the `@zanreal/medusa-product-costs` module, resolved
   * lazily and optionally: without it (or without a cost for a given SKU) the
   * break-even floor is unresolvable and the offer is skipped with reason
   * `missing-break-even`. There is no default floor, ever.
   */
  costsModuleKey?: string;
  /** Marketplace the rule assignment targets. Single-account PL sellers: `allegro-pl`. */
  marketplaceId?: string;
  /**
   * Region that Allegro-sourced orders are created in. Medusa needs one to
   * price an order; with none configured the plugin uses the first region whose
   * currency matches the checkout form (then the first region at all).
   */
  regionId?: string;
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
  stockSyncDisabled: boolean;
  ordersSyncDisabled: boolean;
  invoiceAttachDisabled: boolean;
  automationRules?: { promoted: string; standard: string };
  changeCap: number;
  salesChannelId?: string;
  salesChannelName?: string;
  stockLocationIds: string[];
  srpMetadataKey?: string;
  srpPriceListId?: string;
  costsModuleKey: string;
  invoiceModuleKey: string;
  marketplaceId: string;
  regionId?: string;
  backendUrl?: string;
}

/**
 * The subset of the resolved options that is safe to hand to a caller.
 *
 * `ResolvedAllegroOptions` carries `clientSecret` and `encryptionKey`, so any
 * accessor that returns it is one careless `res.json()` away from publishing the
 * plugin's credentials. This shape exists so the module service can answer "how
 * am I configured?" without that risk: every field here is already visible in
 * the admin UI or in an outbound Allegro request.
 *
 * Deliberately NOT here: `clientId` (half of a credential pair and not needed by
 * any caller), `clientSecret`, `encryptionKey`, `backendUrl` and `docsUrl`.
 */
export interface AllegroPublicOptions {
  environment: AllegroEnvironment;
  appName: string;
  appVersion: string;
  redirectPath: string;
  scopes: string;
  priceSyncDisabled: boolean;
  stockSyncDisabled: boolean;
  ordersSyncDisabled: boolean;
  invoiceAttachDisabled: boolean;
  /**
   * The configured rule names, so the admin can say which two rules the account
   * must carry. Names, not ids - a name is what an operator sees in the seller
   * panel, and the ids are resolved from it on every run.
   */
  automationRules?: { promoted: string; standard: string };
  changeCap: number;
  salesChannelId?: string;
  salesChannelName?: string;
  stockLocationIds: string[];
  srpMetadataKey?: string;
  srpPriceListId?: string;
  marketplaceId: string;
}

/** Narrow the resolved options to the fields that may leave the service. */
export const toPublicAllegroOptions = (options: ResolvedAllegroOptions): AllegroPublicOptions => ({
  appName: options.appName,
  appVersion: options.appVersion,
  automationRules: options.automationRules,
  changeCap: options.changeCap,
  environment: options.environment,
  invoiceAttachDisabled: options.invoiceAttachDisabled,
  marketplaceId: options.marketplaceId,
  ordersSyncDisabled: options.ordersSyncDisabled,
  priceSyncDisabled: options.priceSyncDisabled,
  redirectPath: options.redirectPath,
  salesChannelId: options.salesChannelId,
  salesChannelName: options.salesChannelName,
  scopes: options.scopes,
  srpMetadataKey: options.srpMetadataKey,
  srpPriceListId: options.srpPriceListId,
  stockLocationIds: options.stockLocationIds,
  stockSyncDisabled: options.stockSyncDisabled,
});

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
/** Same contract as `ALLEGRO_PRICE_SYNC_DISABLED`, for the quantity writes. */
const STOCK_SYNC_DISABLED_ENV = "ALLEGRO_STOCK_SYNC_DISABLED";
/** Same contract again, for the order event drain. */
const ORDERS_SYNC_DISABLED_ENV = "ALLEGRO_ORDERS_SYNC_DISABLED";
/** Same contract again, for attaching invoice PDFs to Allegro orders. */
const INVOICE_ATTACH_DISABLED_ENV = "ALLEGRO_INVOICE_ATTACH_DISABLED";
/** Comma-separated stock location ids, overriding `stockLocationIds`. */
const STOCK_LOCATION_IDS_ENV = "ALLEGRO_STOCK_LOCATION_IDS";

const truthyEnv = (value: string | undefined): boolean => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const isPriceSyncDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  truthyEnv(env[PRICE_SYNC_DISABLED_ENV]);

export const isStockSyncDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  truthyEnv(env[STOCK_SYNC_DISABLED_ENV]);

export const isOrdersSyncDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  truthyEnv(env[ORDERS_SYNC_DISABLED_ENV]);

export const isInvoiceAttachDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  truthyEnv(env[INVOICE_ATTACH_DISABLED_ENV]);

/** Default price-automation marketplace: a single-account PL seller lives here. */
export const DEFAULT_MARKETPLACE_ID = "allegro-pl";
/** Default container key of the optional `@zanreal/medusa-product-costs` module. */
export const DEFAULT_COSTS_MODULE_KEY = "productCosts";
/** Default container key of the optional `@zanreal/medusa-infakt` module. */
export const DEFAULT_INVOICE_MODULE_KEY = "infakt";
/** Default per-run cap on price-automation commands. */
export const DEFAULT_CHANGE_CAP = 100;

/**
 * Reject a boolean-looking string on a kill-switch.
 *
 * `priceSyncDisabled: process.env.SOMETHING` yields "true", which a truthiness
 * test would honour but a `=== true` test silently ignores - the switch would
 * read as enabled while the operator believed it was off. Fail loudly instead,
 * and name the env var that does the job properly.
 */
const requireBooleanSwitch = (
  value: unknown,
  field: keyof AllegroPluginOptions,
  envVar: string,
): void => {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(
      `medusa-allegro: plugin option \`${field}\` must be a boolean (got ${typeof value} "${String(value)}"). To drive it from the environment, set ${envVar}=1 instead of passing a string here.`,
    );
  }
};

/** Trimmed non-empty string, or undefined. Blank strings are not configuration. */
const optionalString = (value: unknown): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
};

/**
 * Validate the two managed rule names.
 *
 * Both must be present and distinct. One name used for both promotion states
 * would make every promotion flip a no-op switch, which reads as "price sync is
 * working" while the promoted commission rate is never applied - exactly the
 * silent mispricing the fail-loud rule resolution exists to prevent.
 */
const resolveAutomationRules = (
  value: AllegroPluginOptions["automationRules"],
): { promoted: string; standard: string } | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `medusa-allegro: plugin option \`automationRules\` must be an object with \`promoted\` and \`standard\` rule names (got ${typeof value}).`,
    );
  }
  const promoted = optionalString(value.promoted);
  const standard = optionalString(value.standard);
  if (!(promoted && standard)) {
    throw new Error(
      "medusa-allegro: plugin option `automationRules` needs both `promoted` and `standard` rule names. They must match rules that already exist on the Allegro account - the plugin never creates or edits a rule.",
    );
  }
  if (promoted === standard) {
    throw new Error(
      `medusa-allegro: plugin option \`automationRules\` uses the same rule name ("${promoted}") for both promotion states. A promotion flip would then be a no-op switch, so the promoted commission rate would never reach the price floor. Use two distinct rules.`,
    );
  }
  return { promoted, standard };
};

/** Locations from the env var when set, otherwise from the option. */
const resolveStockLocationIds = (
  value: AllegroPluginOptions["stockLocationIds"],
  env: NodeJS.ProcessEnv,
): string[] => {
  const fromEnv = (env[STOCK_LOCATION_IDS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) {
    return [...new Set(fromEnv)];
  }
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `medusa-allegro: plugin option \`stockLocationIds\` must be an array of stock location ids (got ${typeof value}).`,
    );
  }
  const ids = value
    .map((entry) => optionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(ids)];
};

/**
 * The per-run command cap.
 *
 * Rejects 0 and negatives rather than treating them as "no writes": a cap is a
 * blast-radius limit, and an operator who wants no writes has three kill
 * switches to reach for. A silently inert loop that still reports "ok" is the
 * failure mode this refuses to have.
 */
const resolveChangeCap = (value: AllegroPluginOptions["changeCap"]): number => {
  if (value === undefined) {
    return DEFAULT_CHANGE_CAP;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `medusa-allegro: plugin option \`changeCap\` must be a positive integer (got ${typeof value} "${String(value)}"). To stop price writes entirely, use \`priceSyncDisabled\` or ALLEGRO_PRICE_SYNC_DISABLED.`,
    );
  }
  return value;
};

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
  options?: Partial<AllegroPluginOptions>,
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

  // A boolean-looking string is the mistake this catches: `priceSyncDisabled:
  // process.env.SOMETHING` yields "true", which a truthiness test would honour
  // but a `=== true` test silently ignores - the kill-switch would read as
  // enabled while the operator believed it was off. Fail loudly instead.
  requireBooleanSwitch(options.priceSyncDisabled, "priceSyncDisabled", PRICE_SYNC_DISABLED_ENV);
  requireBooleanSwitch(options.stockSyncDisabled, "stockSyncDisabled", STOCK_SYNC_DISABLED_ENV);
  requireBooleanSwitch(options.ordersSyncDisabled, "ordersSyncDisabled", ORDERS_SYNC_DISABLED_ENV);
  requireBooleanSwitch(
    options.invoiceAttachDisabled,
    "invoiceAttachDisabled",
    INVOICE_ATTACH_DISABLED_ENV,
  );

  const redirectPath = (options.redirectPath ?? DEFAULT_REDIRECT_PATH).trim();
  if (!redirectPath.startsWith("/")) {
    throw new Error(
      `medusa-allegro: plugin option \`redirectPath\` must start with "/" (got "${redirectPath}").`,
    );
  }
  // "//host/cb" starts with "/" but is a protocol-relative URL: `new
  // URL("//evil.example/cb", "https://shop.example")` resolves to
  // https://evil.example/cb, so this would silently move the OAuth redirect_uri
  // to another origin.
  if (redirectPath.startsWith("//")) {
    throw new Error(
      `medusa-allegro: plugin option \`redirectPath\` must be a path on this backend, not a protocol-relative URL (got "${redirectPath}").`,
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

  const srpMetadataKey = optionalString(options.srpMetadataKey);
  const srpPriceListId = optionalString(options.srpPriceListId);
  // Not an error, but the one misconfiguration that silently produces a
  // catalogue-wide `missing-srp` skip: both sources absent means no offer can
  // ever resolve a ceiling, so price sync would report itself healthy while
  // writing nothing. The admin surfaces the same fact from `srpMetadataKey` /
  // `srpPriceListId` being empty; this is only reachable at boot.
  if (srpMetadataKey && srpPriceListId) {
    throw new Error(
      "medusa-allegro: plugin options `srpMetadataKey` and `srpPriceListId` are mutually exclusive - configure exactly one source for the SRP ceiling.",
    );
  }

  return {
    appName,
    appVersion,
    automationRules: resolveAutomationRules(options.automationRules),
    backendUrl: backendUrl || undefined,
    changeCap: resolveChangeCap(options.changeCap),
    clientId,
    clientSecret,
    costsModuleKey: optionalString(options.costsModuleKey) ?? DEFAULT_COSTS_MODULE_KEY,
    docsUrl,
    encryptionKey,
    environment,
    invoiceAttachDisabled: options.invoiceAttachDisabled === true || isInvoiceAttachDisabledByEnv(),
    invoiceModuleKey: optionalString(options.invoiceModuleKey) ?? DEFAULT_INVOICE_MODULE_KEY,
    marketplaceId: optionalString(options.marketplaceId) ?? DEFAULT_MARKETPLACE_ID,
    ordersSyncDisabled: options.ordersSyncDisabled === true || isOrdersSyncDisabledByEnv(),
    priceSyncDisabled: options.priceSyncDisabled === true || isPriceSyncDisabledByEnv(),
    redirectPath,
    regionId: optionalString(options.regionId),
    salesChannelId: optionalString(options.salesChannelId),
    salesChannelName: optionalString(options.salesChannelName),
    scopes: (options.scopes ?? DEFAULT_SCOPES).trim() || DEFAULT_SCOPES,
    srpMetadataKey,
    srpPriceListId,
    stockLocationIds: resolveStockLocationIds(options.stockLocationIds, process.env),
    stockSyncDisabled: options.stockSyncDisabled === true || isStockSyncDisabledByEnv(),
  };
};
