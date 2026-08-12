/**
 * Response shapes the admin pages read.
 *
 * Hand-written rather than imported from the server: the admin bundle is compiled
 * with its own tsconfig and must not pull in server code (Medusa's model
 * definitions, the module service, `node:crypto`). These mirror the routes under
 * `src/api/admin/allegro`, and the routes' own tests are what keep them honest.
 */

export type SyncProvider = "offers" | "price-automation" | "prices" | "stock" | "orders";

export type SyncStatus = "idle" | "running" | "ok" | "error";

export interface Connection {
  connected: boolean;
  environment: string;
  accountLogin?: string;
  scope?: string;
  expiresAt?: string;
  connectedAt?: string;
  expired?: boolean;
  refreshTokenMissing?: boolean;
  credentialsUnreadable?: boolean;
  priceSyncDisabled: boolean;
  scopesRequested: string;
}

export interface SyncStateRow {
  id: string;
  provider: SyncProvider | string;
  status: SyncStatus;
  last_synced_at?: string | null;
  last_error?: string | null;
  cursor?: string | null;
  counts?: Record<string, unknown> | null;
  write_scope_missing?: boolean;
}

export type RuntimeToggleKey =
  | "priceSync"
  | "stockSync"
  | "ordersSync"
  | "fulfillmentWriteback"
  | "invoiceAttach";

/**
 * One runtime writer as the settings page renders it.
 *
 * The switch binds to `persistedEnabled`; when `forceDisabled` is set the environment is
 * holding the writer off whatever is persisted, so the UI locks the switch and says
 * "forced off by environment" instead of showing an armed writer that never runs.
 */
export interface RuntimeToggle {
  key: RuntimeToggleKey;
  column: string;
  label: string;
  description: string;
  envVar: string;
  persistedEnabled: boolean;
  forceDisabled: boolean;
  effectiveEnabled: boolean;
}

export interface PublicOptions {
  environment: string;
  automationRules?: { promoted: string; standard: string };
  changeCap: number;
  salesChannelId?: string;
  salesChannelName?: string;
  stockLocationIds: string[];
  srpMetadataKey?: string;
  srpPriceListId?: string;
  marketplaceId: string;
  scopes: string;
}

export interface OverviewResponse {
  connection: Connection;
  sync_state: SyncStateRow[];
  toggles: RuntimeToggle[];
  options: PublicOptions;
}

/** The settings CRUD route's response, and the shape a toggle write returns. */
export interface RuntimeTogglesResponse {
  toggles: RuntimeToggle[];
}

export type OfferConflict = "missing-external-id" | "duplicate-sku" | "no-variant" | "no-offer";

export interface OfferRow {
  id: string;
  sku: string;
  offer_id?: string | null;
  variant_id?: string | null;
  name?: string | null;
  status?: string | null;
  category_id?: string | null;
  ean?: string | null;
  price_amount?: string | null;
  price_currency?: string | null;
  available_quantity?: number | null;
  /** Three-state: true / false / null meaning the promo sweep has not resolved it. */
  promoted?: boolean | null;
  price_sync_enabled?: boolean;
  price_mode?: string | null;
  automation_rule?: string | null;
  automation_rule_id?: string | null;
  automation_synced_at?: string | null;
  price_automation_drift?: boolean;
  price_synced_at?: string | null;
  stock_synced_at?: string | null;
  conflict?: OfferConflict | null;
  conflict_detail?: string | null;
  last_error?: string | null;
}

export interface OffersResponse {
  offers: OfferRow[];
  count: number;
  limit: number;
  offset: number;
}

export interface PricePushRow {
  id: string;
  sku: string;
  offer_id?: string | null;
  result: "observed" | "success" | "failed" | "skipped";
  bound_floor?: string | null;
  bound_ceiling?: string | null;
  price_mode_old?: string | null;
  price_mode_new?: string | null;
  rule_name_old?: string | null;
  rule_name_new?: string | null;
  promotion_state?: string | null;
  pushed_at?: string | null;
  pushed_by?: string | null;
  allegro_command_id?: string | null;
  error?: string | null;
}

export interface OfferDetailResponse {
  offer: OfferRow;
  pushes: PricePushRow[];
}

export interface CategoryRateRow {
  id: string;
  category_id: string;
  name?: string | null;
  commission_rate?: number | string | null;
  promoted_commission_rate?: number | string | null;
}

export interface CategoryRatesResponse {
  category_rates: CategoryRateRow[];
}

/** Roll-up of the offer table for the product-list status widget. */
export interface AllegroSummary {
  total: number;
  linked: number;
  unlinked: number;
  drifting: number;
  conflicts: number;
}

export interface SummaryResponse {
  summary: AllegroSummary;
}

export interface AllegroOrderRow {
  id: string;
  checkout_form_id: string;
  medusa_order_id?: string | null;
  allegro_status?: string | null;
  fulfillment_status?: string | null;
  derived_status?: string | null;
  buyer_login?: string | null;
  total_to_pay?: string | null;
  currency?: string | null;
  last_event_at?: string | null;
  synced_at?: string | null;
  last_error?: string | null;
  line_conflicts?:
    | { sku: string | null; offerId: string | null; name: string; quantity: number }[]
    | null;
  /** `total-mismatch` when the Medusa total disagrees with what Allegro says was paid. */
  conflict?: string | null;
  conflict_detail?: string | null;
}

export interface QuarantineEntry {
  key: string;
  error: string;
  since: string;
}

export interface OrdersResponse {
  orders: AllegroOrderRow[];
  /** Orders whose total disagrees with Allegro, across the whole table, not just this page. */
  totalMismatchCount?: number;
  count: number;
  limit: number;
  offset: number;
  quarantined: QuarantineEntry[];
  cursor: string | null;
  status: SyncStatus;
  last_error: string | null;
  last_synced_at: string | null;
}

export interface SinglePushResult {
  ok: boolean;
  status: "synced" | "noop" | "skipped" | "pending" | "error";
  message: string;
}

export interface RepairResult {
  ok: boolean;
  statusChanged?: boolean;
  created?: boolean;
  error?: string;
}

export interface ImportResult {
  skipped?: string;
  fetched: number;
  imported: number;
  created: number;
  failed: number;
  truncated: boolean;
  failedFormIds: string[];
  error?: string;
}

/** Every loop's summary carries these two, whatever else it carries. */
export interface SyncRunResponse {
  provider: string;
  result: { skipped?: string; error?: string } & Record<string, unknown>;
}
