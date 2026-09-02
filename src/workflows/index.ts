/**
 * Public workflow surface of the plugin.
 *
 * Exposed through the `./workflows` package export so a host project can run any
 * loop on its own schedule, or from its own admin action, without reaching into
 * the plugin's internals. Each engine is exported as both a workflow (for
 * `.run({ container })`) and a plain function (so a caller chaining several loops
 * can pass one offer listing through all of them instead of paying for three).
 */

export {
  attachAllegroInvoice,
  emptyInvoiceSweepResult,
  INVOICE_SWEEP_BATCH,
  sweepUnattachedInvoices,
} from "./attach-allegro-invoice";
export type {
  AttachInvoiceInput,
  AttachInvoiceResult,
  InvoiceSweepResult,
} from "./attach-allegro-invoice";
export {
  discoverAllegroOffersWorkflow,
  emptyDiscoverOffersResult,
  runOfferDiscovery,
} from "./discover-allegro-offers";
export type { DiscoverOffersOutput, DiscoverOffersResult } from "./discover-allegro-offers";
export {
  emptyPriceAutomationMonitorResult,
  runPriceAutomationMonitor,
  runPriceAutomationMonitorWorkflow,
} from "./run-price-automation-monitor";
export type { PriceAutomationMonitorResult } from "./run-price-automation-monitor";
export {
  drainAllegroOrders,
  drainAllegroOrdersWorkflow,
  emptyOrdersSyncResult,
  repairAllegroOrder,
} from "./drain-allegro-orders";
export type { OrdersSyncResult, RepairOrderResult } from "./drain-allegro-orders";
export {
  importAllegroOrdersWindow,
  importAllegroOrdersWindowWorkflow,
} from "./import-allegro-orders-window";
export type {
  ImportOrdersWindowInput,
  ImportOrdersWindowResult,
} from "./import-allegro-orders-window";
/**
 * The billing-data event, exported so a host subscriber can name it rather than
 * retyping the string.
 *
 * `order.placed` needs no export - it is core's own name, and a subscriber already has
 * it from `OrderWorkflowEvents`. This one is this plugin's, so the constant is the
 * contract.
 */
export {
  ORDER_BILLING_READY_EVENT,
  orderBillingReadyMessage,
} from "./lib/order-billing-ready-event";
export { pushAllegroFulfillment } from "./push-allegro-fulfillment";
export type { PushFulfillmentResult } from "./push-allegro-fulfillment";
export {
  emptyStockSyncResult,
  pushAllegroStock,
  pushAllegroStockWorkflow,
} from "./push-allegro-stock";
export type { StockSyncResult } from "./push-allegro-stock";
export {
  emptyPriceSyncSummary,
  pushSingleAllegroOffer,
  syncAllegroPrices,
  syncAllegroPricesWorkflow,
} from "./sync-allegro-prices";
export type { PriceSyncSummary, SingleOfferPushResult } from "./sync-allegro-prices";
