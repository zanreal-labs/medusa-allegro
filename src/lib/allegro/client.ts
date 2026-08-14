import { setTimeout as delay } from "node:timers/promises";
import { AllegroAuthError } from "./auth-error";
import { AllegroApiError } from "./errors";
import { AllegroOAuth } from "./oauth";
import { ALLEGRO_DEFAULT_MARKETPLACE_ID, ALLEGRO_ENDPOINTS, ALLEGRO_MEDIA_TYPE } from "./types";
import type {
  AllegroCategory,
  AllegroCheckoutForm,
  AllegroClientOptions,
  AllegroEnvironment,
  AllegroOffer,
  AllegroOrderEvent,
  AllegroOrderEventStats,
  AllegroSettableFulfillmentStatus,
  AssignOfferPriceAutomationParams,
  ChangeOfferPriceParams,
  ChangeOfferQuantityParams,
  CheckoutFormInvoices,
  CreatedCheckoutFormInvoice,
  ListCheckoutFormsParams,
  ListOffersParams,
  ListOrderEventsParams,
  ListPriceAutomationRulesResponse,
  NewCheckoutFormInvoice,
  OfferFeePreviewResponse,
  OfferPriceAutomationCommandReport,
  OfferPriceAutomationState,
  OfferPriceAutomationTaskCount,
  OfferPriceAutomationTaskReport,
  OfferPriceChangeCommandReport,
  OfferPriceChangeTaskReport,
  OfferQuantityCommandReport,
  OfferQuantityTaskReport,
  OfferPromoOptions,
  PersistedToken,
  RemoveOfferPriceAutomationParams,
} from "./types";
import { buildAllegroUserAgent } from "./user-agent";

const DEFAULT_TIMEOUT_MS = 60_000;
const REFRESH_LEEWAY_MS = 30_000;

interface RequestOptions {
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  /**
   * Raw (non-JSON) request body, sent verbatim. Takes precedence over `body`.
   *
   * The one escape hatch from "every request is JSON", and it exists for exactly
   * one endpoint: Allegro takes an invoice PDF as the whole request body. Keeping
   * it separate from `body` is what stops a binary from reaching
   * `JSON.stringify`, which would upload the string `{}` and be accepted.
   */
  rawBody?: BodyInit;
  /** Content-Type for the request body. Defaults to the media type. */
  contentType?: string;
  /** Override Accept/Content-Type, e.g. for beta endpoints. */
  mediaType?: string;
  /** Bypass auto-auth (used by internals only). */
  skipAuth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * A completed HTTP exchange, before success/failure is interpreted. Keeping the
 * raw status around is what lets `request` see a 401 and retry it once with a
 * refreshed token instead of throwing immediately.
 */
interface RawResponse {
  ok: boolean;
  status: number;
  statusText: string;
  parsed?: unknown;
  requestId?: string;
}

const buildQuery = (q: RequestOptions["query"]): string => {
  if (!q) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) {
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        params.append(k, String(item));
      }
    } else {
      params.append(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
};

/**
 * Compose the SDK's timeout signal with an optional caller-provided one.
 *
 * Uses `AbortSignal.any` (Node ≥ 20.3, available in all browsers we target)
 * - which both registers and tears down internal listeners automatically,
 * so callers can reuse a long-lived signal across many requests without
 * leaking listeners on the source.
 */
const composeSignals = (signals: AbortSignal[]): AbortSignal => AbortSignal.any(signals);

export class AllegroClient {
  readonly oauth: AllegroOAuth;
  private readonly env: AllegroEnvironment;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly onTokenRefresh: AllegroClientOptions["onTokenRefresh"];

  private accessToken?: string;
  private refreshToken?: string;
  private accessTokenExpiresAt = 0;
  private readonly useClientCredentials: boolean;
  private refreshing?: Promise<void>;

  constructor(opts: AllegroClientOptions) {
    if (!(opts.clientId && opts.clientSecret)) {
      throw new Error("AllegroClient: clientId and clientSecret are required.");
    }
    this.userAgent = buildAllegroUserAgent(opts, "AllegroClient");
    this.env = opts.environment ?? "production";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.onTokenRefresh = opts.onTokenRefresh;
    this.useClientCredentials = opts.useClientCredentials ?? true;
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken;
    this.accessTokenExpiresAt = opts.accessTokenExpiresAt ?? 0;

    this.oauth = new AllegroOAuth({
      appName: opts.appName,
      appVersion: opts.appVersion,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      docsUrl: opts.docsUrl,
      environment: this.env,
      fetch: this.fetchImpl,
      // The token endpoint gets the same budget as an API call, so a
      // black-holed /token cannot outlast the request that triggered it.
      timeoutMs: this.timeoutMs,
    });
  }

  /** Composed User-Agent header value (read-only). */
  getUserAgent(): string {
    return this.userAgent;
  }

  /** Current token snapshot. Useful for persisting between runs. */
  getToken(): PersistedToken | undefined {
    if (!this.accessToken) {
      return;
    }
    return {
      accessToken: this.accessToken,
      expiresAt: this.accessTokenExpiresAt,
      refreshToken: this.refreshToken,
    };
  }

  /** Replace the in-memory token (e.g. after loading from storage). */
  setToken(token: PersistedToken): void {
    this.accessToken = token.accessToken;
    this.refreshToken = token.refreshToken ?? this.refreshToken;
    this.accessTokenExpiresAt = token.expiresAt;
  }

  // ---------- Typed convenience methods ----------

  /** GET /sale/offers */
  listOffers(params: ListOffersParams = {}): Promise<{
    offers: AllegroOffer[];
    count: number;
    totalCount: number;
  }> {
    return this.request("GET", "/sale/offers", {
      query: {
        ean: params.ean,
        external_id: params.externalId,
        limit: params.limit,
        name: params.name,
        offer_id: params.offerId,
        offset: params.offset,
        "publication.status": params.publication_status,
        "sellingMode.format": params.sellingMode_format,
      },
    });
  }

  /**
   * GET /sale/product-offers/{offerId}.
   *
   * Allegro disabled the legacy GET /sale/offers/{offerId} for reading offers in 2024
   * (https://developer.allegro.pl/news/at-the-beginning-of-2024-we-will-disable-the-sale-offers-resources-for-creating-and-editing-offers-k1dG88KlxHv).
   * /sale/product-offers/{offerId} returns the same name/category/sellingMode shape we use.
   */
  getOffer(offerId: string): Promise<AllegroOffer> {
    return this.request("GET", `/sale/product-offers/${encodeURIComponent(offerId)}`);
  }

  /**
   * GET /sale/offers/{offerId}/promo-options - the promotion packages assigned
   * to an offer. The offer object itself does not carry promotion state, so this is
   * the authoritative source for "Wyróżnienie" (emphasized). Unlike offer reads,
   * promo-options was NOT moved to /sale/product-offers in the 2024 deprecation -
   * it only exists under /sale/offers (product-offers answers "Feature unavailable").
   */
  getOfferPromoOptions(offerId: string): Promise<OfferPromoOptions> {
    return this.request("GET", `/sale/offers/${encodeURIComponent(offerId)}/promo-options`);
  }

  /**
   * GET /sale/offers/promo-options - promo options for ALL of the seller's
   * offers, paginated (limit ≤ 5000, default 5000). One page usually covers the
   * whole catalog, so prefer this over per-offer getOfferPromoOptions when
   * resolving promotion state in bulk.
   */
  listSellerPromoOptions(params: { limit?: number; offset?: number } = {}): Promise<{
    promoOptions: OfferPromoOptions[];
    count: number;
    totalCount: number;
  }> {
    return this.request("GET", "/sale/offers/promo-options", {
      query: params as RequestOptions["query"],
    });
  }

  /**
   * GET /sale/price-automation/rules - every price-automation rule configured on
   * the seller account. This is the authoritative source for a rule's name; the
   * per-offer read only carries the rule id (Allegro removed the rule type from
   * several read resources on 8 July 2025, so name/type must be resolved here).
   *
   * Read-only monitor use (Phase 1). Rule assignment is a separate write path
   * (POST /sale/offer-price-automation-commands), out of scope here.
   * Docs: developer.allegro.pl/news/reguly-cenowe-udostepnilismy-nowe-opcje-automatycznego-przeliczania-cen-aMenAZD9Ef6
   */
  listPriceAutomationRules(): Promise<ListPriceAutomationRulesResponse> {
    return this.request("GET", "/sale/price-automation/rules");
  }

  /**
   * The price-automation rule attached to a single offer.
   *
   * Allegro exposes the attached rule on the offer itself under
   * `sellingMode.priceAutomation.rule` (there is no dedicated per-offer
   * automation resource), so this reads `GET /sale/product-offers/{offerId}`
   * and distils the relevant fields. Resolve `rule.id` against
   * `listPriceAutomationRules()` for the rule name. The monitor normally reads
   * this state in bulk off `listOffers`, which carries the same field; this
   * per-offer helper covers targeted re-checks (e.g. a shadow-preview refresh).
   * Docs: developer.allegro.pl/news/get-sale-offers-dodalismy-informacje-o-regulach-cenowych-oraz-parametry-wyszukiwania-g0a2ZwyZVsB
   */
  async getOfferPriceAutomation(offerId: string): Promise<OfferPriceAutomationState> {
    const offer = await this.getOffer(offerId);
    return {
      offerId: offer.id,
      rule: offer.sellingMode?.priceAutomation?.rule,
      status: offer.publication?.status,
    };
  }

  /**
   * POST /sale/offer-price-automation-commands - attach (or switch) a named
   * price-automation rule on one offer, optionally with a [min, max] price
   * range.
   *
   * This is the async batch resource: Allegro answers 201 with a `GeneralReport`
   * (the command id + an initially-null `completedAt`) and processes the change
   * in the background. Resolve the outcome with
   * `pollOfferPriceAutomationCommand`. Requires the
   * `allegro:api:sale:offers:write` scope - a read-only token gets HTTP 403 here
   * (see `AllegroApiError.isForbidden`), which callers treat as the write-scope
   * gap rather than a per-offer failure.
   *
   * Body shape (a single-offer CONTAINS_OFFERS criterium + a `set` modification)
   * is expanded from `AssignOfferPriceAutomationParams`.
   * Docs: developer.allegro.pl/documentation swagger `OfferAutomaticPricingCommand`
   * (operationId offerAutomaticPricingModificationCommandUsingPOST).
   */
  assignOfferPriceAutomation(
    params: AssignOfferPriceAutomationParams,
  ): Promise<OfferPriceAutomationCommandReport> {
    const marketplaceId = params.marketplaceId ?? ALLEGRO_DEFAULT_MARKETPLACE_ID;
    const id = params.commandId ?? crypto.randomUUID();
    // `configuration` (the price range) is a sibling of `marketplace` and `rule`
    // on each set item, NOT a property of the rule. Verified against Allegro's
    // official machine-readable OpenAPI document,
    // https://developer.allegro.pl/swagger.yaml, schema
    // `OfferAutomaticPricingModificationSet` (verbatim fragment):
    //
    //   OfferAutomaticPricingModificationSet:
    //     type: object
    //     properties:
    //       set:
    //         type: array
    //         items:
    //           type: object
    //           required: [marketplace, rule]
    //           properties:
    //             marketplace:
    //               type: object
    //               required: [id]
    //               properties:
    //                 id: { $ref: '#/components/schemas/MarketplaceId' }
    //             rule:
    //               type: object
    //               required: [id]
    //               properties:
    //                 id: { $ref: '#/components/schemas/AutomaticPricingRuleId' }
    //             configuration:
    //               $ref: '#/components/schemas/AutomaticPricingOfferRuleConfiguration'
    //
    // `AutomaticPricingOfferRuleConfiguration.priceRange` requires
    // { type, minPrice, maxPrice } with Price = { amount: string, currency }.
    const setItem: {
      marketplace: { id: string };
      rule: { id: string };
      configuration?: { priceRange: Record<string, unknown> };
    } = { marketplace: { id: marketplaceId }, rule: { id: params.ruleId } };
    if (params.bounds) {
      setItem.configuration = {
        priceRange: {
          maxPrice: params.bounds.max,
          minPrice: params.bounds.min,
          type: params.bounds.type ?? "MARKETPLACE_CURRENCY",
        },
      };
    }
    return this.request("POST", "/sale/offer-price-automation-commands", {
      body: {
        id,
        modification: { set: [setItem] },
        offerCriteria: [{ offers: [{ id: params.offerId }], type: "CONTAINS_OFFERS" }],
      },
    });
  }

  /**
   * POST /sale/offer-price-automation-commands with a `remove` modification -
   * take the price-automation rule OFF one offer, for one marketplace.
   *
   * The same async batch resource as `assignOfferPriceAutomation`, with the other
   * arm of the `modification` union, and the same 403-on-missing-write-scope
   * behaviour. No rule id is sent, because an offer carries at most one rule per
   * marketplace and Allegro removes whichever it is.
   *
   * Fixed-price mode is the only caller: a Buy Now price written to an offer that
   * still has a rule attached does not survive the rule's next recalculation, so
   * the rule has to come off before the price goes on. Verified against Allegro's
   * OpenAPI document, https://developer.allegro.pl/swagger.yaml, schema
   * `OfferAutomaticPricingModificationRemove` (verbatim fragment):
   *
   *   OfferAutomaticPricingModificationRemove:
   *     type: object
   *     properties:
   *       remove:
   *         type: array
   *         items:
   *           type: object
   *           required: [marketplace]
   *           properties:
   *             marketplace:
   *               type: object
   *               required: [id]
   *               properties:
   *                 id: { $ref: '#/components/schemas/MarketplaceId' }
   */
  removeOfferPriceAutomation(
    params: RemoveOfferPriceAutomationParams,
  ): Promise<OfferPriceAutomationCommandReport> {
    const marketplaceId = params.marketplaceId ?? ALLEGRO_DEFAULT_MARKETPLACE_ID;
    const id = params.commandId ?? crypto.randomUUID();
    return this.request("POST", "/sale/offer-price-automation-commands", {
      body: {
        id,
        modification: { remove: [{ marketplace: { id: marketplaceId } }] },
        offerCriteria: [{ offers: [{ id: params.offerId }], type: "CONTAINS_OFFERS" }],
      },
    });
  }

  /**
   * PUT /sale/offer-price-change-commands/{commandId} - set one offer's Buy Now
   * price to an exact amount.
   *
   * The write behind fixed-price mode. Async and batch-shaped like its siblings:
   * Allegro answers 201 with a `GeneralReport` and processes the change in the
   * background, so resolve the outcome with `pollOfferPriceChangeCommand`.
   * Requires `allegro:api:sale:offers:write` - the same scope the rule assignment
   * needs, and already part of this plugin's default scope string, so no
   * reconnect is needed to move a store to this mode.
   *
   * Only `FIXED_PRICE` is sent. Verified against
   * https://developer.allegro.pl/swagger.yaml, schemas `OfferPriceChangeCommand`
   * and `PriceModificationFixedPrice`: `modification.type` is the discriminator,
   * `price` is a `Price` ({ amount: string, currency }), and `marketplaceId` is a
   * property of the modification (omitted means the offer's base marketplace).
   */
  changeOfferPrice(params: ChangeOfferPriceParams): Promise<OfferPriceChangeCommandReport> {
    return this.request(
      "PUT",
      `/sale/offer-price-change-commands/${encodeURIComponent(params.commandId)}`,
      {
        body: {
          modification: {
            ...(params.marketplaceId ? { marketplaceId: params.marketplaceId } : {}),
            price: params.price,
            type: "FIXED_PRICE",
          },
          offerCriteria: [{ offers: [{ id: params.offerId }], type: "CONTAINS_OFFERS" }],
        },
      },
    );
  }

  /**
   * GET /sale/offer-price-change-commands/{commandId} - status + summary of a
   * submitted price-change command. Same `GeneralReport` shape, and therefore the
   * same terminal test, as the automation command.
   */
  getOfferPriceChangeCommand(commandId: string): Promise<OfferPriceChangeCommandReport> {
    return this.request("GET", `/sale/offer-price-change-commands/${encodeURIComponent(commandId)}`);
  }

  /**
   * GET /sale/offer-price-change-commands/{commandId}/tasks - the per-offer task
   * results, used to surface why one offer's price change failed.
   */
  getOfferPriceChangeCommandTasks(
    commandId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<OfferPriceChangeTaskReport> {
    return this.request(
      "GET",
      `/sale/offer-price-change-commands/${encodeURIComponent(commandId)}/tasks`,
      { query: { limit: params.limit, offset: params.offset } },
    );
  }

  /**
   * Poll `getOfferPriceChangeCommand` to terminal, or to the budget. Same
   * contract and same defaults as `pollOfferPriceAutomationCommand`: the returned
   * report failing `isCommandTerminal` means the caller timed out and must treat
   * the command as still pending rather than as a failure.
   */
  async pollOfferPriceChangeCommand(
    commandId: string,
    opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<OfferPriceChangeCommandReport> {
    const intervalMs = opts.intervalMs ?? 750;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const sleep = opts.sleep ?? ((ms: number) => delay(ms));
    const deadline = Date.now() + timeoutMs;
    let report = await this.getOfferPriceChangeCommand(commandId);
    // Bounded status poll; the awaits are deliberately sequential.
    while (!AllegroClient.isCommandTerminal(report) && Date.now() < deadline) {
      await sleep(intervalMs);
      report = await this.getOfferPriceChangeCommand(commandId);
    }
    return report;
  }

  /**
   * GET /sale/offer-price-automation-commands/{commandId} - status + summary of
   * a submitted rule-assignment command. `completedAt` is null until the command
   * is terminal; `taskCount` tallies failed/success/total. Read-only scope.
   * Docs: swagger operationId getofferAutomaticPricingModificationCommandStatusUsingGET.
   */
  getOfferPriceAutomationCommand(commandId: string): Promise<OfferPriceAutomationCommandReport> {
    return this.request(
      "GET",
      `/sale/offer-price-automation-commands/${encodeURIComponent(commandId)}`,
    );
  }

  /**
   * GET /sale/offer-price-automation-commands/{commandId}/tasks - the per-offer
   * task results (status NEW | SUCCESS | FAIL and any error messages). Used to
   * surface why a command's single offer failed. Read-only scope.
   * Docs: swagger operationId getofferAutomaticPricingModificationCommandTasksStatusesUsingGET.
   */
  getOfferPriceAutomationCommandTasks(commandId: string): Promise<OfferPriceAutomationTaskReport> {
    return this.request(
      "GET",
      `/sale/offer-price-automation-commands/${encodeURIComponent(commandId)}/tasks`,
    );
  }

  /**
   * Poll `getOfferPriceAutomationCommand` until the command reaches a terminal
   * state (`completedAt` set, or every scheduled task accounted for) or the
   * budget is exhausted. Returns the last report seen; `completedAt` being unset
   * on the returned report means the caller timed out and should treat the
   * command as still pending rather than as a failure.
   *
   * `sleep` is injectable so tests drive the loop without real timers. Defaults
   * are conservative (the command is usually terminal within a second or two for
   * a single offer, but Allegro makes no latency guarantee).
   */
  async pollOfferPriceAutomationCommand(
    commandId: string,
    opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<OfferPriceAutomationCommandReport> {
    const intervalMs = opts.intervalMs ?? 750;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const sleep = opts.sleep ?? ((ms: number) => delay(ms));
    const deadline = Date.now() + timeoutMs;
    let report = await this.getOfferPriceAutomationCommand(commandId);
    // Bounded status poll: each read depends on the previous one not having
    // been terminal yet, so the awaits are deliberately sequential.
    while (!AllegroClient.isCommandTerminal(report) && Date.now() < deadline) {
      await sleep(intervalMs);
      report = await this.getOfferPriceAutomationCommand(commandId);
    }
    return report;
  }

  /**
   * A command report is terminal when Allegro stamps `completedAt`, or when the
   * task tally shows every scheduled offer accounted for (a defensive fallback
   * in case `completedAt` lags the counts).
   *
   * PUBLIC on purpose, and it is the ONLY terminality test in the plugin. Both
   * command loops poll to a budget and then have to decide whether the last report
   * they hold is a verdict or a timeout, and re-deriving that decision at the call
   * site is how a weaker test creeps in: `taskCount.total > 0` alone is true of a
   * command that has scheduled one task and finished none, so an in-progress
   * command would be read as a confirmed success. That mattered most for price
   * sync, where a "success" stamps `price_synced_at` and writes the only bounds
   * memory this plugin has - poisoning it means the offer is never re-pushed.
   *
   * Structurally typed rather than taking one of the two report interfaces, because
   * the price-automation and quantity reports carry the same two fields and both
   * need the same answer.
   */
  static isCommandTerminal(report: {
    completedAt?: string | null;
    taskCount?: OfferPriceAutomationTaskCount;
  }): boolean {
    if (report.completedAt) {
      return true;
    }
    const tally = report.taskCount;
    return Boolean(tally && tally.total > 0 && tally.success + tally.failed >= tally.total);
  }

  /**
   * PUT /sale/offer-quantity-change-commands/{commandId} - set one exact stock
   * quantity on up to 1,000 offers. The caller groups mismatches by target
   * quantity before invoking this stable public endpoint.
   */
  async changeOfferQuantity(
    params: ChangeOfferQuantityParams,
  ): Promise<OfferQuantityCommandReport> {
    if (!Number.isInteger(params.value) || params.value < 0) {
      throw new Error("Offer quantity must be a non-negative integer.");
    }
    if (params.offerIds.length === 0 || params.offerIds.length > 1000) {
      throw new Error("Offer quantity commands require between 1 and 1,000 offer ids.");
    }
    return await this.request(
      "PUT",
      `/sale/offer-quantity-change-commands/${encodeURIComponent(params.commandId)}`,
      {
        body: {
          modification: { changeType: "FIXED", value: params.value },
          offerCriteria: [
            {
              offers: params.offerIds.map((id) => ({ id })),
              type: "CONTAINS_OFFERS",
            },
          ],
        },
      },
    );
  }

  getOfferQuantityCommand(commandId: string): Promise<OfferQuantityCommandReport> {
    return this.request(
      "GET",
      `/sale/offer-quantity-change-commands/${encodeURIComponent(commandId)}`,
    );
  }

  getOfferQuantityCommandTasks(
    commandId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<OfferQuantityTaskReport> {
    return this.request(
      "GET",
      `/sale/offer-quantity-change-commands/${encodeURIComponent(commandId)}/tasks`,
      { query: { limit: params.limit, offset: params.offset } },
    );
  }

  async pollOfferQuantityCommand(
    commandId: string,
    opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<OfferQuantityCommandReport> {
    const intervalMs = opts.intervalMs ?? 750;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const sleep = opts.sleep ?? ((ms: number) => delay(ms));
    const deadline = Date.now() + timeoutMs;
    let report = await this.getOfferQuantityCommand(commandId);
    // Bounded status poll; the awaits are deliberately sequential.
    while (!AllegroClient.isCommandTerminal(report) && Date.now() < deadline) {
      await sleep(intervalMs);
      report = await this.getOfferQuantityCommand(commandId);
    }
    return report;
  }

  /**
   * GET /order/checkout-forms - Allegro orders.
   *
   * A continuous orders sync is best driven by `listOrderEvents`, but Allegro
   * retains only about 60 days of events, so this resource is the sole route to
   * an order the journal never named: a fresh or restored database, a drain
   * disabled longer than the retention window, or a lost event cursor. Keep it
   * for the operator-invoked backfill path.
   */
  listCheckoutForms(params: ListCheckoutFormsParams = {}): Promise<{
    checkoutForms: AllegroCheckoutForm[];
    count: number;
    totalCount: number;
  }> {
    return this.request("GET", "/order/checkout-forms", {
      query: params as RequestOptions["query"],
    });
  }

  /** GET /order/checkout-forms/{id} */
  getCheckoutForm(id: string): Promise<AllegroCheckoutForm> {
    return this.request("GET", `/order/checkout-forms/${encodeURIComponent(id)}`);
  }

  /**
   * GET /order/checkout-forms/{id}/invoices - invoice documents attached to an
   * order on Allegro (plus whether one was marked as sent outside the platform).
   */
  getCheckoutFormInvoices(id: string): Promise<CheckoutFormInvoices> {
    return this.request("GET", `/order/checkout-forms/${encodeURIComponent(id)}/invoices`);
  }

  /**
   * POST /order/checkout-forms/{id}/invoices - register an invoice document on an
   * order. Returns the attachment id; the PDF is uploaded afterwards via
   * `uploadCheckoutFormInvoiceFile`. At most 10 invoices per order
   * (`ALLEGRO_MAX_INVOICES_PER_ORDER`).
   *
   * SANCTIONED EXTENSION of the ported SDK: this and the file upload below are the
   * two write methods the reference client carries that the initial port left out,
   * brought over verbatim for the invoice chain. They keep the SDK's conventions -
   * the vendor media type for the JSON call, the shared User-Agent, and
   * `AllegroApiError` classification through `request`.
   *
   * THERE IS NO IDEMPOTENCY KEY. A second call with the same `invoiceNumber`
   * creates a second document rather than returning the first, so a caller that
   * crashed between a successful create and persisting the returned id must look
   * the existing document up (`getCheckoutFormInvoices`, matched on
   * `invoiceNumber`) before creating another. That guard is the caller's, not the
   * client's, because only the caller knows which number it issued.
   */
  createCheckoutFormInvoice(
    id: string,
    invoice: NewCheckoutFormInvoice,
  ): Promise<CreatedCheckoutFormInvoice> {
    return this.request("POST", `/order/checkout-forms/${encodeURIComponent(id)}/invoices`, {
      body: invoice,
    });
  }

  /**
   * PUT /order/checkout-forms/{id}/invoices/{invoiceId}/file - upload the invoice
   * file as a raw PDF binary. Allegro answers with an empty success status.
   *
   * The body is the PDF itself, not a JSON envelope and not multipart, which is why
   * `request` grew `rawBody`: handing the bytes to `JSON.stringify` produces `{}`
   * and Allegro accepts it, so the order ends up carrying an invoice document with
   * a two-byte file. Max `ALLEGRO_INVOICE_MAX_BYTES`; check the size before calling
   * rather than after, since a rejected upload leaves the registered document in
   * place and it still counts against the per-order limit.
   */
  uploadCheckoutFormInvoiceFile(id: string, invoiceId: string, pdf: Uint8Array): Promise<void> {
    return this.request(
      "PUT",
      `/order/checkout-forms/${encodeURIComponent(id)}/invoices/${encodeURIComponent(invoiceId)}/file`,
      // `Uint8Array<ArrayBufferLike>` narrows outside lib.dom's `BodyInit` union,
      // but fetch accepts any ArrayBufferView at runtime.
      { contentType: "application/pdf", rawBody: pdf as BodyInit },
    );
  }

  /**
   * GET /order/events - the seller's order event journal.
   *
   * The authoritative feed for order state changes. A fulfillment update does
   * not reliably bump the parent checkout form's `updatedAt`, so polling
   * `listCheckoutForms({ "updatedAt.gte": … })` on its own cannot see it.
   *
   * Paged with `from` (an event id, exclusive); Allegro retains 60 days.
   */
  listOrderEvents(params: ListOrderEventsParams = {}): Promise<{ events: AllegroOrderEvent[] }> {
    return this.request("GET", "/order/events", {
      query: { from: params.from, limit: params.limit, type: params.type },
    });
  }

  /**
   * GET /order/event-stats - id and timestamp of the newest event for the
   * authenticated seller. Lets a consumer start at "now" without replaying the
   * whole 60-day journal.
   */
  getOrderEventStats(): Promise<AllegroOrderEventStats> {
    return this.request("GET", "/order/event-stats");
  }

  /**
   * PUT /order/checkout-forms/{id}/fulfillment - update the seller-managed
   * processing status of an order. Allegro responds 204 on success.
   */
  updateCheckoutFormFulfillment(
    id: string,
    status: AllegroSettableFulfillmentStatus,
  ): Promise<void> {
    return this.request("PUT", `/order/checkout-forms/${encodeURIComponent(id)}/fulfillment`, {
      body: { status },
    });
  }

  /** GET /sale/categories - top level when `parentId` omitted. */
  getCategories(parentId?: string): Promise<{ categories: AllegroCategory[] }> {
    return this.request("GET", "/sale/categories", {
      query: parentId ? { "parent.id": parentId } : undefined,
    });
  }

  /** GET /sale/categories/{id} */
  getCategory(id: string): Promise<AllegroCategory> {
    return this.request("GET", `/sale/categories/${encodeURIComponent(id)}`);
  }

  /** GET /sale/categories/{id}/parameters */
  getCategoryParameters(id: string): Promise<{ parameters: unknown[] }> {
    return this.request("GET", `/sale/categories/${encodeURIComponent(id)}/parameters`);
  }

  /**
   * POST /pricing/offer-fee-preview - calculate the fees and sale commission
   * for an offer. Pass an offer model (e.g. the result of `getOffer`); the
   * `promotion` it carries determines the commission rate, so promoted and
   * non-promoted offers price correctly.
   */
  offerFeePreview(
    offer: unknown,
    opts?: { marketplaceId?: string },
  ): Promise<OfferFeePreviewResponse> {
    const body = opts?.marketplaceId ? { marketplaceId: opts.marketplaceId, offer } : { offer };
    return this.request("POST", "/pricing/offer-fee-preview", { body });
  }

  /** GET /me - currently authenticated user (Authorization Code only). */
  me(): Promise<{
    id: string;
    login: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    company?: { name?: string; taxId?: string };
  }> {
    return this.request("GET", "/me");
  }

  // ---------- Generic methods ----------

  get<T = unknown>(path: string, opts?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("GET", path, opts);
  }

  post<T = unknown>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  put<T = unknown>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, "body">,
  ): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }

  delete<T = unknown>(path: string, opts?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  // ---------- Core ----------

  private async fetchFreshToken(): Promise<void> {
    let fresh;
    if (this.refreshToken) {
      fresh = await this.oauth.refresh(this.refreshToken);
    } else if (this.useClientCredentials) {
      fresh = await this.oauth.clientCredentials();
    } else {
      throw new AllegroAuthError(
        "No accessToken, refreshToken, or client-credentials fallback available.",
        "no_credentials",
      );
    }
    // Held in locals as well as on the instance: the persistence hook must be
    // handed the tokens this refresh produced, not whatever the instance happens
    // to hold by the time the hook runs.
    //
    // DIVERGENCE FROM THE REFERENCE SDK: upstream localises only the access
    // token and the expiry, then reads `this.refreshToken` back off the instance
    // when calling the hook. Allegro rotates the refresh token on every use, so
    // a concurrent refresh landing between the assignment and the hook would
    // make the hook persist the *other* refresh of the pair - the stored token
    // and the live one drift apart and the next exchange gets `invalid_grant`.
    // All three values are localised, and the hook is handed the locals.
    const accessToken = fresh.access_token;
    const refreshToken = fresh.refresh_token ?? this.refreshToken;
    const expiresAt = Date.now() + fresh.expires_in * 1000;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accessTokenExpiresAt = expiresAt;
    if (this.onTokenRefresh) {
      await this.onTokenRefresh({
        accessToken,
        expiresAt,
        refreshToken,
        scope: fresh.scope,
      });
    }
  }

  private async ensureToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessTokenExpiresAt - now > REFRESH_LEEWAY_MS) {
      return this.accessToken;
    }
    if (this.refreshing) {
      await this.refreshing;
      if (!this.accessToken) {
        throw new AllegroAuthError("No access token after refresh.", "no_token");
      }
      return this.accessToken;
    }
    this.refreshing = (async () => {
      try {
        await this.fetchFreshToken();
      } finally {
        this.refreshing = undefined;
      }
    })();
    await this.refreshing;
    if (!this.accessToken) {
      throw new AllegroAuthError("Failed to acquire Allegro access token.", "no_token");
    }
    return this.accessToken;
  }

  /**
   * Force a token refresh even though the current one has not expired yet.
   *
   * Used for the single 401 retry: Allegro can invalidate a still-unexpired
   * access token (consent withdrawn, password change, token rotated by another
   * process), and without this the caller would fail forever on a token the SDK
   * believes is fine.
   */
  private async forceRefresh(): Promise<void> {
    this.accessTokenExpiresAt = 0;
    await this.ensureToken();
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const first = await this.send(method, path, opts);
    // Only a bearer-authenticated request with a refresh token can recover; an
    // app (client-credentials) token that gets a 401 is missing scope, and
    // retrying it would just burn another call.
    if (first.status !== 401 || opts.skipAuth || !this.refreshToken) {
      return AllegroClient.unwrap<T>(first);
    }
    try {
      await this.forceRefresh();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AllegroAuthError(
        `Allegro rejected the access token (401) and the refresh token could not be exchanged: ${reason}. The Allegro account has to be reconnected.`,
        "refresh_rejected",
        401,
      );
    }
    return AllegroClient.unwrap<T>(await this.send(method, path, opts));
  }

  /** Turn a raw response into the parsed body, or throw `AllegroApiError`. */
  private static unwrap<T>(res: RawResponse): T {
    if (res.status === 204) {
      return undefined as T;
    }
    if (res.ok) {
      return res.parsed as T;
    }
    const body =
      typeof res.parsed === "object" && res.parsed !== null
        ? (res.parsed as Record<string, unknown>)
        : (res.parsed as string | undefined);
    const message =
      (typeof body === "object" && Array.isArray(body?.errors) && body.errors[0]?.userMessage) ||
      (typeof body === "object" && Array.isArray(body?.errors) && body.errors[0]?.message) ||
      (typeof body === "object" && (body as { error_description?: string }).error_description) ||
      `Allegro HTTP ${res.status} ${res.statusText}`;
    throw new AllegroApiError({
      body:
        typeof body === "object" || typeof body === "string"
          ? (body as object | string)
          : undefined,
      httpStatus: res.status,
      message: String(message),
      requestId: res.requestId,
    });
  }

  private async send(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions,
  ): Promise<RawResponse> {
    const url = `${ALLEGRO_ENDPOINTS[this.env].api}${path}${buildQuery(opts.query)}`;
    const media = opts.mediaType ?? ALLEGRO_MEDIA_TYPE;
    const headers: Record<string, string> = {
      Accept: media,
      "User-Agent": this.userAgent,
      ...opts.headers,
    };
    // `rawBody` counts as a body: the invoice-file upload sends no JSON at all, and
    // a PUT with no Content-Type is rejected by Allegro rather than sniffed.
    const hasBody = opts.rawBody !== undefined || opts.body !== undefined;
    if (hasBody && method !== "GET" && method !== "DELETE") {
      headers["Content-Type"] = opts.contentType ?? media;
    }

    // DIVERGENCE FROM THE REFERENCE SDK: the timer is armed BEFORE
    // `ensureToken()`, not after it. Upstream starts the clock once the token is
    // in hand, so a slow or hung token refresh sits outside the timeout budget
    // entirely and a "60 second" call could take arbitrarily long. Arming it
    // first makes `timeoutMs` mean what it says: the whole exchange, refresh
    // included. The trade-off is deliberate - a request that spends most of its
    // budget refreshing has less left for the call itself, and should fail
    // rather than silently extend.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = opts.signal
      ? composeSignals([controller.signal, opts.signal])
      : controller.signal;

    // Verbatim when raw, stringified otherwise. Resolved before the request rather
    // than inline so the precedence is stated once: a caller that passes both gets
    // the raw bytes, never a JSON envelope around them.
    let requestBody: BodyInit | undefined = opts.rawBody;
    if (requestBody === undefined && opts.body !== undefined) {
      requestBody = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      if (!opts.skipAuth) {
        headers.Authorization = `Bearer ${await this.ensureToken()}`;
      }
      res = await this.fetchImpl(url, {
        body: requestBody,
        headers,
        method,
        signal,
      });
    } catch (error) {
      // An auth failure has to keep its own type: `request` maps a rejected
      // refresh onto `refresh_rejected`, and callers distinguish "reconnect the
      // account" from "Allegro is unreachable".
      if (error instanceof AllegroAuthError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new AllegroApiError({
        httpStatus: 0,
        message: `Allegro request failed: ${reason}`,
      });
    } finally {
      clearTimeout(timeout);
    }

    const requestId = res.headers.get("x-request-id") ?? undefined;

    if (res.status === 204) {
      return { ok: true, requestId, status: 204, statusText: res.statusText };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    let parsed: unknown;
    if (isJson) {
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
    } else {
      try {
        parsed = await res.text();
      } catch {
        parsed = undefined;
      }
    }

    return { ok: res.ok, parsed, requestId, status: res.status, statusText: res.statusText };
  }
}

/**
 * Convenience factory for the common case where credentials live in env.
 *
 * App identity (`appName`, `appVersion`, `docsUrl`) MUST be passed by the
 * caller - these are code-level constants that must match the registered
 * Allegro app 1:1, so they belong in source where reviewers can see them,
 * not in environment configuration.
 *
 * Env vars consulted as fallbacks for secrets only:
 *   - ALLEGRO_CLIENT_ID
 *   - ALLEGRO_CLIENT_SECRET
 *   - ALLEGRO_ENVIRONMENT  ("production" | "sandbox", optional)
 */
export const createAllegroClient = (
  opts: Omit<AllegroClientOptions, "clientId" | "clientSecret" | "environment"> & {
    clientId?: string;
    clientSecret?: string;
    environment?: AllegroEnvironment;
  },
): AllegroClient => {
  const clientId = opts.clientId ?? process.env.ALLEGRO_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.ALLEGRO_CLIENT_SECRET;
  const envName =
    opts.environment ?? ((process.env.ALLEGRO_ENVIRONMENT as AllegroEnvironment) || "production");
  if (!(clientId && clientSecret)) {
    throw new Error(
      "createAllegroClient: ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET must be set, or passed.",
    );
  }
  return new AllegroClient({
    ...opts,
    clientId,
    clientSecret,
    environment: envName,
  });
};
