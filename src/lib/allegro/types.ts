/**
 * Allegro REST API
 * Docs: https://developer.allegro.pl/documentation
 *
 * Environments:
 *   - Production: https://api.allegro.pl  (auth: https://allegro.pl/auth/oauth)
 *   - Sandbox:    https://api.allegro.pl.allegrosandbox.pl
 *                 (auth: https://allegro.pl.allegrosandbox.pl/auth/oauth)
 *
 * Auth: OAuth2.
 *   - Authorization Code: act on behalf of an Allegro user (offers, orders).
 *   - Client Credentials: app-only (public categories, parameters).
 *
 * Required headers on most resources:
 *   - Authorization: Bearer <token>
 *   - Accept:        application/vnd.allegro.public.v1+json
 *   - Content-Type:  application/vnd.allegro.public.v1+json (for write requests)
 *
 * Allegro returns `application/vnd.allegro.public.v1+json` content.
 * Beta endpoints use `application/vnd.allegro.beta.v1+json`.
 */

export type AllegroEnvironment = "production" | "sandbox";

export interface AllegroEndpoints {
  api: string;
  auth: string;
}

export const ALLEGRO_ENDPOINTS: Record<AllegroEnvironment, AllegroEndpoints> = {
  production: {
    api: "https://api.allegro.pl",
    auth: "https://allegro.pl/auth/oauth",
  },
  sandbox: {
    api: "https://api.allegro.pl.allegrosandbox.pl",
    auth: "https://allegro.pl.allegrosandbox.pl/auth/oauth",
  },
};

export const ALLEGRO_MEDIA_TYPE = "application/vnd.allegro.public.v1+json";
export const ALLEGRO_BETA_MEDIA_TYPE = "application/vnd.allegro.beta.v1+json";

export interface AllegroTokenResponse {
  access_token: string;
  token_type: "bearer" | "Bearer";
  /** Lifetime in seconds. */
  expires_in: number;
  /** Refresh token (only for Authorization Code grant). */
  refresh_token?: string;
  scope?: string;
  /** Set by Allegro when allegro_api scope present. */
  allegro_api?: boolean;
  jti?: string;
}

export interface AllegroErrorBody {
  errors?: {
    code?: string;
    message?: string;
    details?: string;
    path?: string;
    userMessage?: string;
  }[];
  /** Sometimes Allegro returns OAuth-style { error, error_description }. */
  error?: string;
  error_description?: string;
}

/**
 * Required app identification used to build the mandatory Allegro User-Agent header.
 *
 * Allegro requires every API/OAuth request to carry a custom User-Agent identifying
 * the integration 1:1 with the registered app - enforced by end of June 2026
 * (developer.allegro.pl news).
 *
 * The SDK composes the User-Agent as:
 *   `${appName}/${appVersion} (+${docsUrl})`
 */
export interface AllegroAppIdentity {
  /** App name. MUST match the name of the app registered in the Allegro Developer Portal. */
  appName: string;
  /** App version (e.g. "1.0.0"). */
  appVersion: string;
  /** Public URL to the integration documentation or contact page (https). */
  docsUrl: string;
}

export interface AllegroClientOptions extends AllegroAppIdentity {
  clientId: string;
  clientSecret: string;
  environment?: AllegroEnvironment;
  /** Provide a pre-issued token (Authorization Code flow). The SDK will refresh it if `refreshToken` is set. */
  accessToken?: string;
  refreshToken?: string;
  /** Absolute UNIX timestamp (ms) when `accessToken` expires. Triggers refresh when within 30s. */
  accessTokenExpiresAt?: number;
  /** If true and no accessToken provided, use Client Credentials grant. Default true. */
  useClientCredentials?: boolean;
  /** Default request timeout (ms). Default 60_000. */
  timeoutMs?: number;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
  /** Hook called after token refresh - persist the new tokens for later runs. */
  onTokenRefresh?: (token: PersistedToken) => void | Promise<void>;
}

export interface PersistedToken {
  accessToken: string;
  refreshToken?: string;
  /** Absolute UNIX timestamp (ms). */
  expiresAt: number;
  scope?: string;
}

export type AllegroGrantType = "authorization_code" | "refresh_token" | "client_credentials";

export interface AuthorizationUrlParams {
  /** Same as the URI registered for the app in Allegro Developer Portal. */
  redirectUri: string;
  /** Space-separated scopes. Common: "allegro:api:sale:offers:read allegro:api:sale:offers:write allegro:api:orders:read". */
  scope?: string;
  /** CSRF / round-trip state. Strongly recommended. */
  state?: string;
  /** "code" (default) or "device". */
  responseType?: "code";
  /** When true, force consent prompt. */
  prompt?: "confirm";
}

// ---------- Minimal resource types (a tiny subset; extend as needed) ----------

export interface AllegroOffer {
  id: string;
  name?: string;
  category?: { id: string };
  sellingMode?: {
    format?: "BUYING" | "BUY_NOW" | "ENGLISH" | "ADVERTISEMENT";
    price?: { amount: string; currency: string };
    /**
     * Price-automation rule attached to the offer, when one is assigned.
     * `GET /sale/offers` and `GET /sale/product-offers/{offerId}` expose the
     * attached rule under `sellingMode.priceAutomation.rule`.
     * Docs: developer.allegro.pl/news/get-sale-offers-dodalismy-informacje-o-regulach-cenowych-oraz-parametry-wyszukiwania-g0a2ZwyZVsB
     *
     * Allegro removed the rule `type` from several read resources on 8 July 2025
     * (developer.allegro.pl/news/reguly-cenowe-8-lipca-2025-usuniemy-informacje-o-typie-reguly-z-czesci-zasobow-lLYgYoKnDSe),
     * so `type` may be absent here - resolve the rule `id` against
     * `GET /sale/price-automation/rules` for the authoritative name/type.
     */
    priceAutomation?: {
      rule?: { id?: string; type?: PriceAutomationRuleType };
    };
  };
  stock?: { available?: number; sold?: number };
  publication?: {
    status?: "ACTIVE" | "INACTIVE" | "ENDED" | "GOING_TO_BE_ACTIVATED" | "GOING_TO_BE_ENDED";
    startedAt?: string;
    endedAt?: string;
  };
  /** Promotion options. `emphasized` = "Wyróżnienie" - drives the promoted commission rate. */
  promotion?: {
    emphasized?: boolean;
    bold?: boolean;
    highlight?: boolean;
    departmentPage?: boolean;
  };
  ean?: string;
  external?: { id?: string };
}

export interface ListOffersParams {
  name?: string;
  offerId?: string;
  ean?: string;
  externalId?: string;
  publication_status?: string[];
  sellingMode_format?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Seller-managed processing status of a checkout form.
 *
 * `RETURNED` (added by Allegro in March 2025) is read-only: it appears once the
 * buyer returns every unit of the order and the seller refunds all of them, and
 * it cannot be set through `PUT /order/checkout-forms/{id}/fulfillment`.
 */
export type AllegroFulfillmentStatus =
  | "NEW"
  | "PROCESSING"
  | "READY_FOR_SHIPMENT"
  | "READY_FOR_PICKUP"
  | "SENT"
  | "PICKED_UP"
  | "CANCELLED"
  | "SUSPENDED"
  | "RETURNED";

/** The fulfillment statuses a seller may actually set; `RETURNED` is Allegro-managed. */
export type AllegroSettableFulfillmentStatus = Exclude<AllegroFulfillmentStatus, "RETURNED">;

export interface AllegroCheckoutForm {
  id: string;
  status?: "BOUGHT" | "FILLED_IN" | "READY_FOR_PROCESSING" | "CANCELLED";
  /** Message from the buyer to the seller, entered at checkout (GET /order/checkout-forms/{id}). */
  messageToSeller?: string;
  fulfillment?: {
    status?: AllegroFulfillmentStatus;
    shipmentSummary?: { lineItemsSent?: "NONE" | "SOME" | "ALL" };
  };
  updatedAt?: string;
  payment?: {
    id?: string;
    type?: "ONLINE" | "CASH_ON_DELIVERY";
    paidAmount?: { amount: string; currency: string };
    finishedAt?: string;
  };
  /**
   * The Allegro ACCOUNT holder (`CheckoutFormBuyerReference`) - the person the
   * account is registered to, which is not necessarily the person the order is
   * for. Allegro sellers never see these names in the seller UI; what they see
   * is `delivery.address` and `invoice.address`. Treat this block as
   * registration data, not as "who bought this".
   */
  buyer?: {
    id?: string;
    email?: string;
    login?: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
    address?: AllegroBuyerAddress;
    phoneNumber?: string;
  };
  delivery?: {
    method?: { id?: string; name?: string };
    cost?: { amount: string; currency: string };
    address?: AllegroDeliveryAddress;
    pickupPoint?: { id?: string; name?: string; address?: AllegroAddress };
    smart?: boolean;
  };
  invoice?: {
    required?: boolean;
    address?: AllegroInvoiceAddress;
  };
  lineItems?: {
    id?: string;
    offer?: { id?: string; name?: string; external?: { id?: string } };
    quantity?: number;
    price?: { amount: string; currency: string };
    reconciliation?: {
      amount?: { amount: string; currency: string };
      quantity?: number;
      type?: string;
    };
    boughtAt?: string;
  }[];
  summary?: { totalToPay?: { amount: string; currency: string } };
}

export interface AllegroAddress {
  street?: string;
  city?: string;
  zipCode?: string;
  countryCode?: string;
}

/**
 * The account holder's registration address (`CheckoutFormBuyerAddressReference`).
 *
 * Spelled `postCode`, NOT `zipCode` - Allegro uses `zipCode` on every other
 * address in the checkout form and `postCode` on this one alone (verified
 * against the published OpenAPI document, `CheckoutFormBuyerAddressReference`).
 * Typing it as the common `AllegroAddress` silently dropped the postal code,
 * which is why it gets its own interface.
 */
export interface AllegroBuyerAddress {
  street?: string;
  city?: string;
  /** Postal code. Allegro spells it `postCode` on the buyer block only. */
  postCode?: string;
  countryCode?: string;
}

/**
 * The delivery address of a checkout form (`CheckoutFormDeliveryAddress`).
 *
 * This is the buyer-entered SHIPPING recipient, and it is what the seller sees
 * as the order's addressee in the Allegro seller UI - it is not the account
 * holder from `buyer`. `firstName` and `lastName` are required by the schema
 * whenever the block is present; they are optional here only because every
 * field the SDK reads back is optional by convention.
 */
export interface AllegroDeliveryAddress extends AllegroAddress {
  /** Receiver's first name. */
  firstName?: string;
  /** Receiver's last name. */
  lastName?: string;
  /** Receiver's company name, when the parcel goes to a company. */
  companyName?: string;
  phoneNumber?: string;
  /** ISO timestamp of the last buyer edit to the address. */
  modifiedAt?: string;
}

/**
 * One typed tax id on an invoice company (`CheckoutFormInvoiceAddressCompanyId`).
 *
 * `type` is `PL_NIP` for a Polish NIP; `VAT_EU` appears for verified
 * intra-community transactions. This array is the non-deprecated source of the
 * company's tax id - see the note on `AllegroInvoiceCompany.taxId`.
 */
export interface AllegroInvoiceCompanyId {
  type?:
    | "PL_NIP"
    | "CZ_ICO"
    | "CZ_DIC"
    | "HU_ADOSZAM"
    | "SK_ICO"
    | "SK_IC_DPH"
    | "VAT_EU"
    | "OTHER";
  value?: string;
}

/**
 * The company an invoice is to be issued to (`CheckoutFormInvoiceAddressCompany`).
 * Present only for a corporate purchase; absent means a private purchase.
 */
export interface AllegroInvoiceCompany {
  name?: string;
  /** Typed tax ids. The current source of the NIP; prefer this over `taxId`. */
  ids?: AllegroInvoiceCompanyId[];
  vatPayerStatus?: "ACTIVE" | "NON_ACTIVE" | "NOT_APPLICABLE";
  /**
   * Flat tax id. Allegro marks this DEPRECATED in favour of `ids`; it is still
   * returned by the API, so it stays modelled here.
   */
  taxId?: string;
}

/**
 * The natural person an invoice is to be issued to
 * (`CheckoutFormInvoiceAddressNaturalPerson`).
 *
 * This is the buyer-entered invoice recipient of a B2C purchase, and it can
 * name someone other than the account holder - a buyer may order from their own
 * account and ask for the invoice in a relative's name. Both fields are required
 * by the schema whenever the block is present.
 */
export interface AllegroInvoiceNaturalPerson {
  firstName?: string;
  lastName?: string;
}

/** The invoice address of a checkout form (`CheckoutFormInvoiceAddress`). */
export interface AllegroInvoiceAddress {
  street?: string;
  city?: string;
  zipCode?: string;
  countryCode?: string;
  /** Set for a corporate purchase; mutually exclusive with `naturalPerson`. */
  company?: AllegroInvoiceCompany;
  /** Set for a private purchase that named an invoice recipient. */
  naturalPerson?: AllegroInvoiceNaturalPerson;
}

/** One invoice document attached to an order on Allegro. */
export interface CheckoutFormInvoice {
  id: string;
  invoiceNumber?: string;
  createdAt?: string;
}

/** Response of `GET /order/checkout-forms/{id}/invoices`. */
export interface CheckoutFormInvoices {
  invoices?: CheckoutFormInvoice[];
  /** True when an invoice/proof-of-purchase was marked as sent outside Allegro. */
  hasExternalInvoices?: boolean;
}

/**
 * Query parameters of `GET /order/checkout-forms`.
 *
 * Allegro spells its filters with dots (`fulfillment.status`, `buyer.login`,
 * `marketplace.id`); the underscore spellings this interface used to carry were
 * silently ignored by the API, so they are gone.
 */
export interface ListCheckoutFormsParams {
  offset?: number;
  limit?: number;
  /** Result ordering; prefix with "-" for descending. */
  sort?: "updatedAt" | "-updatedAt" | "lineItems.boughtAt" | "-lineItems.boughtAt";
  status?: NonNullable<AllegroCheckoutForm["status"]>;
  "fulfillment.status"?: AllegroFulfillmentStatus;
  "fulfillment.shipmentSummary.lineItemsSent"?: "NONE" | "SOME" | "ALL";
  "lineItems.boughtAt.gte"?: string;
  "lineItems.boughtAt.lte"?: string;
  "updatedAt.gte"?: string;
  "updatedAt.lte"?: string;
  "buyer.login"?: string;
  "marketplace.id"?: string;
}

/**
 * Order event types of `GET /order/events`.
 *
 * - `BOUGHT` - bought, not yet paid.
 * - `FILLED_IN` - buyer submitted the delivery form; can repeat per order.
 * - `READY_FOR_PROCESSING` - payment finalized (or cash-on-delivery / pickup
 *   chosen): the order is actionable and its address data is final.
 * - `BUYER_CANCELLED` - the buyer cancelled the order.
 * - `AUTO_CANCELLED` - Allegro cancelled an unpaid order on its own.
 * - `FULFILLMENT_STATUS_CHANGED` - the seller-managed fulfillment status moved.
 */
export type AllegroOrderEventType =
  | "BOUGHT"
  | "FILLED_IN"
  | "READY_FOR_PROCESSING"
  | "BUYER_CANCELLED"
  | "AUTO_CANCELLED"
  | "FULFILLMENT_STATUS_CHANGED";

/** One entry of the seller's order event journal (`GET /order/events`). */
export interface AllegroOrderEvent {
  /** Event id; also the `from` cursor value for the next page. */
  id: string;
  type?: AllegroOrderEventType;
  occurredAt?: string;
  order?: {
    /** The checkout form (order) the event is about. */
    checkoutForm?: { id?: string; revision?: string };
    seller?: { id?: string };
    buyer?: { id?: string; email?: string; login?: string; guest?: boolean };
    marketplace?: { id?: string };
    lineItems?: {
      id?: string;
      offer?: { id?: string; name?: string; external?: { id?: string } };
      quantity?: number;
      price?: AllegroMoney;
      originalPrice?: AllegroMoney;
      boughtAt?: string;
    }[];
  };
}

export interface ListOrderEventsParams {
  /**
   * Id of the last seen event; only events that occurred after it are returned.
   * Omit to start from the oldest retained event (Allegro keeps 60 days).
   */
  from?: string;
  /** 1-1000, default 100. */
  limit?: number;
  /** Restrict the journal to these event types. */
  type?: AllegroOrderEventType[];
}

/** Response of `GET /order/event-stats`. */
export interface AllegroOrderEventStats {
  latestEvent?: { id?: string; occurredAt?: string };
}

export interface AllegroCategory {
  id: string;
  name: string;
  parent?: { id: string };
  leaf: boolean;
  options?: { variantsByColor?: boolean; ambiguousCharCidsAllowed?: boolean };
}

export interface AllegroMoney {
  amount: string;
  currency: string;
}

/** A single fee or commission line returned by the fee calculator. */
export interface AllegroFeeItem {
  /** e.g. "commissionFee", "listingFee". */
  type?: string;
  /** Localized name, e.g. "Prowizja od sprzedaży". */
  name?: string;
  fee?: AllegroMoney;
  /** Billing cycle for periodic (listing) fees, e.g. "PT240H". */
  cycleDuration?: string;
}

/**
 * Response of `POST /pricing/offer-fee-preview`. `commissions` holds per-sale
 * charges (the sale commission is `type: "commissionFee"`); `quotes` holds
 * periodic listing/promotion fees.
 */
export interface OfferFeePreviewResponse {
  commissions?: AllegroFeeItem[];
  quotes?: AllegroFeeItem[];
}

/**
 * Promotion flags accepted in the offer body of `POST /pricing/offer-fee-preview`.
 * These drive the *promoted* sale commission rate. The legacy `emphasized`/
 * `bold`/`highlight` flags were removed by Allegro; only these remain.
 */
export interface OfferPromotion {
  emphasized1d?: boolean;
  emphasized10d?: boolean;
  departmentPage?: boolean;
}

/** A single promotion package assigned to an offer. */
export interface OfferPromoOption {
  /** Package id, e.g. "emphasized1d", "emphasized10d", "promoPackage". */
  id?: string;
  validFrom?: string;
  validTo?: string;
  nextCycleDate?: string;
}

/**
 * Response of `GET /sale/offers/{offerId}/promo-options` - the promotion
 * packages currently assigned to an offer. An offer carries "Wyróżnienie" when
 * its base or an extra package is an emphasized/promo type.
 */
export interface OfferPromoOptions {
  offerId?: string;
  marketplaceId?: string;
  basePackage?: OfferPromoOption;
  extraPackages?: OfferPromoOption[];
}

// ---------- Price automation (rules + per-offer attached state) ----------

/**
 * Allegro price-automation rule categories.
 * Docs: developer.allegro.pl/news/reguly-cenowe-udostepnilismy-nowe-opcje-automatycznego-przeliczania-cen-aMenAZD9Ef6
 */
export type PriceAutomationRuleType =
  | "FOLLOW_BY_MARKET_MIN_PRICE"
  | "EXCHANGE_RATE"
  | "FOLLOW_BY_ALLEGRO_MIN_PRICE";

/**
 * A named price-automation rule configured on the seller account.
 *
 * `GET /sale/price-automation/rules` is the authoritative source for the rule
 * `name` (the per-offer read only carries the rule `id`). `default` is true for
 * rules Allegro created automatically (e.g. the EXCHANGE_RATE converter), false
 * for seller-defined rules.
 * Docs: developer.allegro.pl/news/reguly-cenowe-udostepnilismy-nowe-opcje-automatycznego-przeliczania-cen-aMenAZD9Ef6
 */
export interface PriceAutomationRule {
  id: string;
  /** Human-readable rule name shown in the seller panel (e.g. "Bitdefender"). */
  name?: string;
  type?: PriceAutomationRuleType;
  /** True when Allegro created the rule automatically rather than the seller. */
  default?: boolean;
}

/** Response of `GET /sale/price-automation/rules`. */
export interface ListPriceAutomationRulesResponse {
  rules: PriceAutomationRule[];
}

/**
 * Per-offer attached price-automation state, distilled from the offer's
 * `sellingMode.priceAutomation`. `rule` is undefined when no rule is attached
 * (a fixed-price offer). `status` mirrors the offer publication status so the
 * monitor can distinguish an active offer from an ended one.
 */
export interface OfferPriceAutomationState {
  offerId: string;
  rule?: { id?: string; type?: PriceAutomationRuleType };
  status?: NonNullable<AllegroOffer["publication"]>["status"];
}

// ---------- Offer price-automation commands (write) ----------

/**
 * Default marketplace for a single-account PL seller. `offerCriteria` + the
 * rule assignment are per marketplace; a single-account PL seller lives on
 * allegro-pl.
 * Docs: developer.allegro.pl/documentation swagger MarketplaceId (example
 * `allegro-pl`).
 */
export const ALLEGRO_DEFAULT_MARKETPLACE_ID = "allegro-pl";

/**
 * Price bounds for an automated offer, in the marketplace currency. Maps to the
 * command's `configuration.priceRange`; both bounds are required by Allegro when
 * a range is supplied.
 * Docs: swagger `AutomaticPricingOfferRuleConfiguration.priceRange`.
 */
export interface OfferPriceAutomationBounds {
  /** Floor; a common choice is the break-even price. */
  min: AllegroMoney;
  /** Ceiling; a common choice is the recommended retail price. */
  max: AllegroMoney;
  /** Range currency scope. Base marketplace only accepts MARKETPLACE_CURRENCY. */
  type?: "MARKETPLACE_CURRENCY" | "BASE_MARKETPLACE_CURRENCY";
}

/**
 * One offer's rule assignment request, distilled to the fields a caller sets. The
 * SDK expands this into the full `OfferAutomaticPricingCommand` body (a `set`
 * modification scoped to a single-offer `CONTAINS_OFFERS` criterium).
 * Docs: POST /sale/offer-price-automation-commands
 * (developer.allegro.pl/documentation swagger `OfferAutomaticPricingCommand`).
 */
export interface AssignOfferPriceAutomationParams {
  /** Target offer id. */
  offerId: string;
  /** Rule id to attach (resolve the name via listPriceAutomationRules first). */
  ruleId: string;
  /** Optional price range [min, max]; omitted = attach the rule without bounds. */
  bounds?: OfferPriceAutomationBounds;
  /** Marketplace to assign on; defaults to `allegro-pl`. */
  marketplaceId?: string;
  /**
   * Idempotency key. When omitted the SDK generates one and returns it in the
   * report; supplying your own makes a retried POST a no-op on Allegro's side
   * (a reused id answers HTTP 409, which the caller can treat as "already
   * registered").
   */
  commandId?: string;
}

/** Per-marketplace failed/success/total tally on a command report. */
export interface OfferPriceAutomationTaskCount {
  failed: number;
  success: number;
  total: number;
}

/**
 * `GeneralReport` for an offer-price-automation command. `completedAt` is null
 * until the async command reaches a terminal state; `taskCount` tallies the
 * per-offer outcomes. Poll `getOfferPriceAutomationCommand` until `completedAt`
 * is set (see `pollOfferPriceAutomationCommand`).
 * Docs: GET /sale/offer-price-automation-commands/{commandId} (swagger
 * `GeneralReport`).
 */
export interface OfferPriceAutomationCommandReport {
  id: string;
  createdAt?: string;
  /** Null/absent while the command is still running; set once terminal. */
  completedAt?: string | null;
  taskCount?: OfferPriceAutomationTaskCount;
}

/**
 * Per-offer task result on a command (`GET .../{commandId}/tasks`). `status` is
 * one of NEW | SUCCESS | FAIL; `message` carries the fail reason.
 * Docs: swagger `CommandTask`.
 */
export interface OfferPriceAutomationTask {
  field?: string;
  message?: string;
  offer?: { id?: string };
  status?: "NEW" | "SUCCESS" | "FAIL";
  errors?: { code?: string; message?: string; userMessage?: string }[];
}

/** Response of `GET /sale/offer-price-automation-commands/{commandId}/tasks`. */
export interface OfferPriceAutomationTaskReport {
  tasks?: OfferPriceAutomationTask[];
}

/** One stable bulk quantity command. Every offer in the command gets the same FIXED value. */
export interface ChangeOfferQuantityParams {
  /** Caller-generated idempotency key. */
  commandId: string;
  /** Target offer ids. Allegro accepts at most 1,000 offers per command. */
  offerIds: string[];
  /** Exact available quantity to set. */
  value: number;
}

/** Summary returned by the quantity command and its status endpoint. */
export interface OfferQuantityCommandReport {
  id: string;
  createdAt?: string;
  completedAt?: string | null;
  taskCount?: OfferPriceAutomationTaskCount;
}

/** One offer result returned by the quantity command tasks endpoint. */
export interface OfferQuantityTask {
  errors?: { code?: string; message?: string; userMessage?: string }[];
  field?: string;
  message?: string;
  offer?: { id?: string };
  status?: "NEW" | "SUCCESS" | "FAIL";
}

/**
 * Response of `GET /sale/offer-quantity-change-commands/{commandId}/tasks`.
 *
 * PAGINATED, and that is load-bearing. A command naming 1,000 offers can emit more
 * than 1,000 tasks - the `field` discriminator on a task exists precisely because
 * Allegro reports tasks for fields other than `quantity` - so one page is not the
 * whole report. Reading a single page and classifying every unseen offer as failed
 * reports a healthy push as broken on every subsequent run, so the caller pages to
 * exhaustion (`readAllQuantityTasks`).
 *
 * `count` / `totalCount` are optional because the plugin must not depend on Allegro
 * populating them; a short page is the fallback signal that the report is complete.
 */
export interface OfferQuantityTaskReport {
  tasks?: OfferQuantityTask[];
  /** Tasks in this page. */
  count?: number;
  /** Tasks across every page of this command. */
  totalCount?: number;
}
