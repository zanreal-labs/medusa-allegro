import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import {
  cancelOrderWorkflow,
  completeOrderWorkflow,
  createOrderWorkflow,
} from "@medusajs/medusa/core-flows";
import { describeError } from "../../lib/allegro/errors";
import type { AllegroCheckoutForm } from "../../lib/allegro/types";
import {
  mapCheckoutFormStatus,
  medusaActionForStatus,
  resolveStatusWrite,
} from "../../lib/sync/order-status";
import type { DerivedOrderStatus, MedusaOrderAction } from "../../lib/sync/order-status";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type AllegroModuleService from "../../modules/allegro/service";
import { planCustomerName, readBuyerIdentity } from "../../lib/sync/customer-identity";
import type { CustomerNameRow } from "../../lib/sync/customer-identity";
import { parseAmount } from "../../lib/sync/money";
import type { AmountInput } from "../../lib/sync/money";
import { planOrderPayment, readPaymentFacts } from "../../lib/sync/order-reconcile";
import { nameOrderCustomer } from "./order-customer";
import {
  isUsableAddress,
  planOrderAddressRepair,
  readAddressFields,
} from "../../lib/sync/order-address";
import { planOrderTaxIdFill } from "../../lib/sync/order-tax-id";
import { repairOrderAddresses } from "./order-address";
import { fillOrderTaxId } from "./order-tax-id";
import { emitOrderBillingReady } from "./order-billing-ready-event";
import { emitOrderPlaced } from "./order-placed-event";
import { readOrderPaymentState, registerOrderPayment } from "./order-payment";
import { ensureOrderReservations } from "./order-reservations";
import { readCheckoutForm } from "./checkout-form";
import type { CheckoutFormLine, CheckoutFormView, OrderAddress } from "./checkout-form";

/**
 * Applying one Allegro checkout form to Medusa.
 *
 * ## Crash-safe ordering
 *
 * The order of writes is the whole correctness argument, and it is:
 *
 * 1. Upsert the `allegro_order` bookkeeping row WITHOUT `synced_at`.
 * 2. Create the Medusa order, if this form has none yet.
 * 2b. Create any inventory reservations the order is missing, so it can actually be
 *    fulfilled. `createOrderWorkflow` does not reserve; see `ensureOrderReservations`.
 * 3. Act on the status (cancel / complete), writing `derived_status` in the SAME
 *    operation.
 * 4. Stamp `synced_at` LAST.
 * 5. Emit `order.placed`, but only for an order this pass actually created.
 * 6. Emit `allegro.order.billing_ready`, but only on the pass that MADE the order's
 *    billing data complete - which is almost never the pass that created it.
 *
 * A crash anywhere before step 4 leaves the row looking unfinished, so the next
 * pass repairs it. Stamping earlier would let a half-applied form read as done -
 * and the event cursor would then be free to move past it.
 *
 * ## Medusa does not announce an order it did not get from a cart
 *
 * `createOrderWorkflow` emits nothing at all. `order.placed` comes from
 * `completeCartWorkflow` and `convertDraftOrderWorkflow`, each emitting it BESIDE their
 * create rather than inside it - so an order created here was never announced to
 * anything, and every `order.placed` consumer in the store was structurally deaf to
 * marketplace sales while looking perfectly healthy. Step 5 emits the event core would
 * have emitted, with core's payload. See `lib/order-placed-event`.
 *
 * ## And nothing at all announces the billing data arriving
 *
 * The billing address and the tax id are written in steps 3e and 3f through the Order
 * MODULE SERVICE, deliberately bypassing `updateOrderWorkflow` - so they emit no event
 * either, not even `order.updated`. An invoicing plugin subscribed to `payment.captured`
 * therefore reaches an Allegro order minutes before its billing address does, fails its
 * completeness gate and parks the order. Step 6 announces the moment the data actually
 * lands. See `lib/order-billing-ready-event`.
 *
 * ## Unmatched lines do not lose the sale
 *
 * A line whose sygnatura matches no Medusa variant is carried as a title-only
 * custom line item and recorded in `line_conflicts`. Refusing the order would be
 * worse: the sale happened on Allegro whatever Medusa's catalogue says, and an order
 * nobody can see is not a safer outcome than one that is visibly half-mapped.
 *
 * ## The customer is the Allegro ACCOUNT HOLDER
 *
 * A checkout form names up to three different people, and they end up in three
 * different places: the delivery recipient on the shipping address, the invoice
 * recipient on the billing address, and the account holder on the Medusa CUSTOMER.
 * `lib/sync/customer-identity` argues that mapping in full, including why the delivery
 * name is never borrowed to fill an empty customer.
 *
 * ## Totals come from Allegro, never recomputed
 *
 * Line prices and the delivery cost are written as Allegro reported them. Any
 * recomputation would eventually disagree with the money the buyer actually paid,
 * and Allegro's figure is the one that matters for reconciliation.
 */

/** A line that could not be mapped, as stored on `allegro_order.line_conflicts`. */
export interface LineConflict {
  sku: string | null;
  offerId: string | null;
  name: string;
  quantity: number;
}

/** The bookkeeping row, as the drain reads it. */
export interface AllegroOrderRow {
  id: string;
  checkout_form_id: string;
  medusa_order_id?: string | null;
  derived_status?: DerivedOrderStatus | null;
  synced_at?: Date | null;
}

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: { skip: number; take: number };
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

/** Variant ids by SKU, for the lines this form actually needs. */
const resolveVariantIdsBySku = async (
  container: MedusaContainer,
  skus: readonly string[],
): Promise<Map<string, string>> => {
  const bySku = new Map<string, string>();
  const wanted = [...new Set(skus)];
  if (wanted.length === 0) {
    return bySku;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku: wanted },
  });
  for (const row of data) {
    const sku = (row.sku as string | null)?.trim();
    // First match wins. Two variants sharing a SKU is a catalogue problem discovery
    // already reports as a conflict; picking one here is not a decision this path
    // should make, but refusing the order over it would lose a real sale.
    if (sku && !bySku.has(sku)) {
      bySku.set(sku, row.id as string);
    }
  }
  return bySku;
};

/**
 * The region an Allegro order is created in.
 *
 * Medusa needs one to price an order. The configured region wins; failing that, the
 * first region whose currency matches the checkout form, because a currency
 * mismatch between order and region is the error that is hardest to unpick later;
 * failing that, the first region at all, with a warning.
 */
const resolveRegionId = async (
  container: MedusaContainer,
  logger: Logger,
  options: Pick<AllegroSyncOptions, "regionId">,
  currency: string,
): Promise<string | undefined> => {
  if (options.regionId) {
    return options.regionId;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "region", fields: ["id", "currency_code"] });
  const wanted = currency.toLowerCase();
  const matching = data.find((row) => (row.currency_code as string | null) === wanted);
  if (matching) {
    return matching.id as string;
  }
  const fallback = data[0]?.id as string | undefined;
  if (fallback) {
    logger.warn(
      `[allegro-orders] no region uses currency "${wanted}"; creating Allegro orders in region ${fallback}. Set the \`regionId\` option to pin this explicitly.`,
    );
  }
  return fallback;
};

/** Split the form's lines into variant-matched items and recorded conflicts. */
export const buildOrderItems = (
  lines: readonly CheckoutFormLine[],
  variantIdsBySku: Map<string, string>,
): {
  items: {
    title: string;
    quantity: number;
    unit_price: number;
    variant_id?: string;
  }[];
  conflicts: LineConflict[];
} => {
  const items: {
    title: string;
    quantity: number;
    unit_price: number;
    variant_id?: string;
  }[] = [];
  const conflicts: LineConflict[] = [];

  for (const line of lines) {
    const variantId = line.sku ? variantIdsBySku.get(line.sku) : undefined;
    if (!variantId) {
      conflicts.push({
        name: line.title,
        offerId: line.offerId ?? null,
        quantity: line.quantity,
        sku: line.sku ?? null,
      });
    }
    items.push({
      quantity: line.quantity,
      title: line.title,
      // Allegro's price, verbatim. Never recomputed: the buyer paid this.
      unit_price: line.unitPrice,
      ...(variantId ? { variant_id: variantId } : {}),
    });
  }

  return { conflicts, items };
};

/** What applying one form did. */
export interface ApplyFormResult {
  /** True when the derived status moved, which is what the summary reports. */
  statusChanged: boolean;
  /** True when this pass created the Medusa order. */
  created: boolean;
  medusaOrderId?: string;
  conflicts: LineConflict[];
  /** Set when the order's total disagrees with the money Allegro says the buyer paid. */
  totalMismatch?: boolean;
  /** True when this pass recorded the buyer's payment on the Medusa order. */
  paymentRegistered?: boolean;
  /**
   * Inventory reservations created on this pass.
   *
   * Non-zero from the reconciliation sweep means an order that could NOT have been
   * fulfilled just became fulfillable - which is every order this plugin created before
   * reservations existed. See `ensureOrderReservations`.
   */
  reservationsCreated?: number;
  /** Set when a payment was due but could not be recorded. Never fatal - see step 3c. */
  paymentError?: string;
  /**
   * True when this pass filled a name that was missing on the order's customer.
   *
   * Reported separately from `statusChanged` and never folded into it: a name backfill
   * is this plugin catching up with its own past, not evidence that an Allegro event
   * was lost, and the sweep's repair counter means the latter.
   */
  customerNamed?: boolean;
  /**
   * True when this pass filled an address the order was created without.
   *
   * Reported separately and never folded into `statusChanged`, for the same reason
   * `customerNamed` is: it is this plugin catching up with a form the buyer finished
   * after we read it, not evidence that an Allegro event was lost.
   */
  addressRepaired?: boolean;
  /**
   * True when this pass emitted `order.placed` for a newly created order.
   *
   * Reported separately so "no order was created" can be told apart from "an order was
   * created but nothing was announced" - the same silence from outside. See
   * `emitOrderPlaced`.
   */
  orderPlacedEmitted?: boolean;
  /**
   * True when this pass emitted `allegro.order.billing_ready` for the order.
   *
   * Reported separately from `addressRepaired` because they are different facts: a
   * repair that filled a shipping address changed something without making the order
   * invoiceable, and a tax-id fill on an already-addressed order made it invoiceable
   * without repairing an address. See `emitOrderBillingReady`.
   */
  billingReadyEmitted?: boolean;
}

/**
 * Create the Medusa order for a form that has none yet.
 *
 * Returns undefined - having recorded the failure on the bookkeeping row - rather
 * than throwing, when there is no region to price the order in. Throwing would hold
 * the event cursor on a condition no retry fixes, and eventually quarantine the
 * form; recording it keeps the form visible with an actionable message while the
 * drain moves on.
 */
const createMedusaOrder = async (
  container: MedusaContainer,
  logger: Logger,
  options: AllegroSyncOptions,
  view: CheckoutFormView,
  items: ReturnType<typeof buildOrderItems>["items"],
  derived: DerivedOrderStatus | undefined,
): Promise<{ id?: string; error?: string }> => {
  const regionId = await resolveRegionId(container, logger, options, view.currency);
  if (!regionId) {
    return {
      error:
        "no Medusa region exists, so the order cannot be priced. Create a region (and set the `regionId` option) and repair this order.",
    };
  }

  try {
    const { result } = await createOrderWorkflow(container).run({
      input: {
        currency_code: view.currency.toLowerCase(),
        ...(view.email ? { email: view.email } : {}),
        ...(view.billingAddress ? { billing_address: view.billingAddress } : {}),
        items,
        metadata: {
          // The link back, on the order itself, so somebody looking at the order in
          // the dashboard can find it on Allegro without joining through this
          // plugin's tables.
          allegro_checkout_form_id: view.checkoutFormId,
          ...(view.buyerLogin ? { allegro_buyer_login: view.buyerLogin } : {}),
          // The invoice recipient's tax id, as STRUCTURED data rather than folded
          // into `billing_address.company`. `nip` is the first key the inFakt
          // plugin's `defaultNipExtractor` reads, so this is the contract it
          // already publishes, not a new one invented here.
          ...(view.billingTaxId ? { nip: view.billingTaxId } : {}),
          // The pickup point's identity, as its id rather than as its name inside
          // `shipping_address.company`. See `buildShippingAddress`.
          ...(view.pickupPointId ? { allegro_pickup_point_id: view.pickupPointId } : {}),
        },
        region_id: regionId,
        ...(options.salesChannelId ? { sales_channel_id: options.salesChannelId } : {}),
        ...(view.shippingAddress ? { shipping_address: view.shippingAddress } : {}),
        // Delivery is a real cost the buyer paid, so it belongs on the order rather
        // than being silently dropped or folded into a line price.
        ...(view.deliveryCost
          ? {
              shipping_methods: [
                {
                  amount: view.deliveryCost.amount,
                  name: view.deliveryMethod ?? "Allegro delivery",
                },
              ],
            }
          : {}),
        // `pending` for anything mid-flight. The two states Medusa genuinely models
        // are reached through their own workflows below, never by writing the column.
        status: derived === "cancelled" ? "canceled" : "pending",
      },
    });
    return { id: (result as { id: string }).id };
  } catch (error) {
    return { error: describeError(error) };
  }
};

/**
 * Act on the Medusa order for a derived status Medusa can represent.
 *
 * Only `cancel` and `complete`, through their own workflows. Everything in between
 * lives on `allegro_order.derived_status`, because Medusa's order status enum has no
 * `sent` or `ready_for_shipment` and writing the column directly would fight both
 * the dashboard and the order-edit flows.
 *
 * Best-effort and never fatal. The workflows validate - cancelling an order with
 * live fulfillments throws, completing a cancelled one throws - and a staff member
 * who already did it by hand is the common case. Failing the whole form over it
 * would hold the event cursor on something that is arguably already correct.
 */
/** The Medusa `order.status` that each action is trying to reach. */
const TARGET_ORDER_STATUS: Record<Exclude<MedusaOrderAction, "none">, string> = {
  cancel: "canceled",
  complete: "completed",
};

/**
 * Whether the action has already been achieved, so attempting it is pointless.
 *
 * Read from the order's own status rather than inferred. The deterministic case is a form
 * first seen as CANCELLED: `createMedusaOrder` creates it with `status: "canceled"`, and
 * then step 3 immediately tries to cancel it - so the action could NEVER succeed for the
 * one status where it matters most.
 */
const isAlreadyAchieved = (
  orderStatus: string | undefined,
  action: Exclude<MedusaOrderAction, "none">,
): boolean => orderStatus === TARGET_ORDER_STATUS[action];

/**
 * Whether a thrown action error means "already in the target state" rather than "failed".
 *
 * Matched against what the core workflows actually throw, read from `@medusajs/core-flows`
 * rather than guessed:
 *
 * - `throwIfOrderIsCancelled` (order/utils/order-validation) throws
 *   `MedusaError(INVALID_DATA, "Order with id X has been canceled.")`, which is what a
 *   cancel of an already-cancelled order produces.
 * - `completeOrdersStep` has no equivalent validation - it calls `completeOrder` directly -
 *   so completing an already-completed order does not currently throw at all. The
 *   completed-side pattern is defensive, for the day that changes.
 *
 * Deliberately narrow. "Cannot cancel a completed order" is NOT satisfied: the order is not
 * cancelled, a retry will never fix it, and a human has to decide - so it stays a failure
 * and the quarantine machinery makes it visible, which is exactly what that machinery is
 * for.
 */
const isActionAlreadySatisfied = (
  action: Exclude<MedusaOrderAction, "none">,
  message: string,
): boolean =>
  action === "cancel"
    ? /has been canceled|already canceled|already cancelled/iu.test(message)
    : /has been completed|already completed/iu.test(message);

/** What one attempt at the status action did. */
type ActionOutcome =
  | { kind: "done" }
  /** Nothing to do, or already in the target state. Counts as LANDED. */
  | { kind: "satisfied"; note?: string }
  | { kind: "failed"; error: string };

const applyMedusaAction = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  derived: DerivedOrderStatus,
  orderStatus: string | undefined,
): Promise<ActionOutcome> => {
  const action = medusaActionForStatus(derived);
  if (action === "none") {
    return { kind: "satisfied" };
  }
  // Cheap pre-check, so the deterministic already-satisfied case costs no workflow run at
  // all rather than costing a thrown error that has to be classified.
  if (isAlreadyAchieved(orderStatus, action)) {
    return {
      kind: "satisfied",
      note: `Medusa order ${orderId} is already ${TARGET_ORDER_STATUS[action]}`,
    };
  }
  try {
    if (action === "cancel") {
      await cancelOrderWorkflow(container).run({ input: { order_id: orderId } });
    } else {
      await completeOrderWorkflow(container).run({ input: { orderIds: [orderId] } });
    }
    return { kind: "done" };
  } catch (error) {
    const message = describeError(error);
    if (isActionAlreadySatisfied(action, message)) {
      // The state Allegro is asking for already holds - a staff member cancelled by hand, or
      // our status snapshot was a moment stale. Treating this as a failure was a permanent
      // latch: `derived_status` is gated on the pass having landed, so it never advanced,
      // every subsequent pass retried the same impossible action, the form quarantined after
      // five, and `repairAllegroOrder` could not clear it either because the condition never
      // changes.
      return { kind: "satisfied", note: `${action} was already satisfied: ${message}` };
    }
    logger.warn(
      `[allegro-orders] could not ${action} Medusa order ${orderId} for Allegro status "${derived}": ${message}. The Allegro-derived status is still recorded.`,
    );
    return { error: `${action} failed: ${message}`, kind: "failed" };
  }
};

/** Orders scanned per page by the adoption fallback. */
const ADOPTION_PAGE_SIZE = 100;
/** Pages the adoption fallback scans before giving up. */
const ADOPTION_MAX_PAGES = 5;

/**
 * Find a Medusa order already created for this checkout form, so it can be adopted
 * instead of duplicated.
 *
 * The link between the two lives in `order.metadata.allegro_checkout_form_id`, written
 * when the order is created. `buildWhere` in Medusa's query layer recurses into plain
 * objects, so a nested filter reaches Mikro-ORM as a JSON property query.
 *
 * The in-memory re-check is not redundant: it is what makes this safe if the query layer
 * ever ignores or mis-translates the nested filter. A filter that silently matched
 * everything would otherwise hand back an unrelated order and this function would
 * "adopt" somebody else's sale into an Allegro form. Only an exact metadata match is
 * ever accepted, so a broken filter degrades to "not found" rather than to corruption.
 *
 * The fallback scan exists because the JSON filter is the one part of this that depends
 * on query-layer behaviour the plugin does not own. If it throws, a bounded newest-first
 * sweep still finds an order created minutes ago by a crashed pass, which is the only
 * realistic case. Both paths use the same exact-match verification.
 */
const findExistingMedusaOrder = async (
  container: MedusaContainer,
  logger: Logger,
  checkoutFormId: string,
): Promise<string | undefined> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const matches = (row: Record<string, unknown>): boolean =>
    (row.metadata as Record<string, unknown> | null)?.allegro_checkout_form_id === checkoutFormId;

  try {
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { metadata: { allegro_checkout_form_id: checkoutFormId } },
    });
    const found = data.find(matches);
    if (found) {
      return found.id as string;
    }
    // A populated response with no exact match means the filter did not do what it says.
    // Fall through to the scan rather than concluding "no order exists".
    if (data.length === 0) {
      return undefined;
    }
    logger.warn(
      `[allegro-orders] the metadata filter for checkout form ${checkoutFormId} returned ${data.length} order(s) but none carried a matching \`allegro_checkout_form_id\`; falling back to a bounded scan before creating anything.`,
    );
  } catch (error) {
    logger.warn(
      `[allegro-orders] could not query orders by \`metadata.allegro_checkout_form_id\` (${describeError(error)}); falling back to a bounded newest-first scan so a duplicate order is not created.`,
    );
  }

  for (let page = 0; page < ADOPTION_MAX_PAGES; page += 1) {
    // Offset pagination over the orders table. The comment here used to claim "newest first"
    // while passing no ordering at all, which is worth correcting rather than papering over:
    // this scan is UNORDERED, so the bound is "the first N orders the query layer returns",
    // not "the N most recent". That is still sound for its purpose - it is a fallback that
    // only runs when the metadata filter itself is unusable, and every candidate is verified
    // by exact metadata match before adoption, so an unordered scan can miss but can never
    // adopt the wrong order. A miss degrades to creating the order, which is the pre-existing
    // behaviour this fallback improves on rather than a regression.
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      pagination: { skip: page * ADOPTION_PAGE_SIZE, take: ADOPTION_PAGE_SIZE },
    });
    const found = data.find(matches);
    if (found) {
      return found.id as string;
    }
    if (data.length < ADOPTION_PAGE_SIZE) {
      return undefined;
    }
  }
  logger.warn(
    `[allegro-orders] scanned ${ADOPTION_MAX_PAGES * ADOPTION_PAGE_SIZE} order(s) without finding one for checkout form ${checkoutFormId}; proceeding to create it.`,
  );
  return undefined;
};

/**
 * Record the Medusa order id on the bookkeeping row.
 *
 * Wrapped so a failed link write cannot pass silently: the order EXISTS at this point, so
 * losing the link is what the next pass would read as "no order yet". The adoption lookup
 * above recovers from it automatically, but the id is logged loudly regardless so a
 * manual repair is possible without trawling for it.
 */
const linkMedusaOrder = async (
  allegro: AllegroModuleService,
  logger: Logger,
  rowId: string,
  medusaOrderId: string,
  checkoutFormId: string,
): Promise<void> => {
  try {
    await allegro.updateAllegroOrders([{ id: rowId, medusa_order_id: medusaOrderId }] as never);
  } catch (error) {
    logger.error(
      `[allegro-orders] created or adopted Medusa order ${medusaOrderId} for checkout form ${checkoutFormId} but FAILED to record the link on allegro_order ${rowId}: ${describeError(error)}. The next pass adopts it by \`metadata.allegro_checkout_form_id\`; set \`medusa_order_id\` by hand if that does not happen.`,
    );
  }
};

/** A recorded reconciliation problem, as written on the bookkeeping row. */
interface OrderConflict {
  conflict: "total-mismatch";
  conflict_detail: string;
}

/** Grosz-exact comparison, so a float round-trip cannot invent a mismatch. */
const toMinorUnits = (value: number): number => Math.round(value * 100);

/**
 * Compare the Medusa order's total against the `totalToPay` Allegro recorded.
 *
 * Never blocks and never rolls back. The sale happened on Allegro whatever Medusa's
 * arithmetic says, and an order nobody can see is not a safer outcome than one that is
 * visibly disputed - so a mismatch is a recorded conflict for a human to judge, exactly the
 * trade `line_conflicts` makes.
 *
 * The detail names both figures AND the number of custom lines, because that is the common
 * benign cause: a line whose sygnatura matched no variant is carried as a title-only item,
 * which can legitimately move the total. Putting the count in the message is what stops an
 * operator investigating arithmetic when the real answer is "this order is half-mapped".
 *
 * Returns undefined when the totals agree, when Allegro sent no total to compare against, or
 * when the order's total cannot be read - an unreadable total is not evidence of a mismatch,
 * and recording one on that basis would be the same fabrication this check exists to catch.
 */
/**
 * The Medusa order as this pass needs to see it: its status, for the action pre-check, and
 * its total, for reconciliation.
 *
 * One read for both. Cancel and complete do not alter a total, so the pre-action snapshot is
 * as good as a post-action one for the money comparison, and the alternative was two round
 * trips per form.
 */
const ADDRESS_FIELD_SELECTION = [
  "shipping_address.id",
  "shipping_address.first_name",
  "shipping_address.last_name",
  "shipping_address.company",
  "shipping_address.address_1",
  "shipping_address.address_2",
  "shipping_address.city",
  "shipping_address.postal_code",
  "shipping_address.country_code",
  "shipping_address.phone",
  "billing_address.id",
  "billing_address.first_name",
  "billing_address.last_name",
  "billing_address.company",
  "billing_address.address_1",
  "billing_address.address_2",
  "billing_address.city",
  "billing_address.postal_code",
  "billing_address.country_code",
  "billing_address.phone",
] as const;

interface MedusaOrderSnapshot {
  status?: string;
  total?: number;
  currency?: string;
  /**
   * The customer the order is linked to, for the name fill.
   *
   * Read here rather than in its own round trip. The fill has to know which of the
   * name columns are already populated before it can decide to write any of them, and
   * this read was already happening - so carrying four more fields on it is free,
   * whereas a second `query.graph` per form would not be.
   */
  customer?: CustomerNameRow;
  /**
   * The order's addresses as they stand, for the address fill.
   *
   * Carried on this read for the same reason the customer columns are: the fill has
   * to know what the order already holds before it can decide to write anything, and
   * a second `query.graph` per form would not be free.
   *
   * The FIELDS, not two booleans about whether a row exists. Reading only the
   * presence of a row was a latch: an order created from an unfinished checkout form
   * carries a billing address with a name and a country and no street, city or postal
   * code, and "it has a billing address" then suppressed the repair forever on exactly
   * the orders that needed it. See `planOrderAddressRepair`.
   *
   * Their contents are read to answer "is this complete" and "which fields are blank",
   * never "does this differ from Allegro's copy". A field that already has a value is
   * left alone even when Allegro disagrees, because a human may have corrected it.
   */
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  /**
   * The order's metadata, for the tax-id fill.
   *
   * Carried on this read for the same reason the customer columns and the address
   * booleans are. The fill has to know whether the order already designates a tax id
   * before it can decide to write one, and it is gap-only: the CONTENTS are read only
   * to answer "is a tax id already here", never to compare it with Allegro's copy.
   */
  metadata?: Record<string, unknown> | null;
}

const readMedusaOrder = async (
  container: MedusaContainer,
  logger: Logger,
  medusaOrderId: string,
): Promise<MedusaOrderSnapshot | undefined> => {
  try {
    const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "status",
        "total",
        "currency_code",
        "customer.id",
        "customer.first_name",
        "customer.last_name",
        "customer.company_name",
        "metadata",
        // Every field an address fill can write, on both sides. Asking for the ids
        // alone was what made a partial address indistinguishable from a complete
        // one, and the merge that fills only the blanks needs the current values.
        ...ADDRESS_FIELD_SELECTION,
      ],
      filters: { id: medusaOrderId },
    });
    const order = data[0];
    if (!order) {
      return undefined;
    }
    const customer = order.customer as CustomerNameRow | null | undefined;
    return {
      currency: (order.currency_code as string | null)?.trim().toLowerCase() || undefined,
      ...(customer?.id ? { customer } : {}),
      billingAddress: readAddressFields(
        order.billing_address as Record<string, unknown> | null | undefined,
      ),
      shippingAddress: readAddressFields(
        order.shipping_address as Record<string, unknown> | null | undefined,
      ),
      metadata: (order.metadata as Record<string, unknown> | null) ?? null,
      status: (order.status as string | null) ?? undefined,
      // NOT cast to a scalar: `order.total` is a Medusa `BigNumber` instance, and the
      // scalar cast is what hid that. `parseAmount` reads the object directly.
      total: parseAmount(order.total as AmountInput),
    };
  } catch (error) {
    logger.warn(
      `[allegro-orders] could not read Medusa order ${medusaOrderId}: ${describeError(error)}. The status action falls back to attempting the workflow, no total conflict is recorded - an unreadable total is not evidence of a mismatch - and the customer name is left alone, because an unread customer cannot be shown to be missing one.`,
    );
    return undefined;
  }
};

const reconcileOrderTotal = (
  view: CheckoutFormView,
  snapshot: MedusaOrderSnapshot | undefined,
  customLineCount: number,
): OrderConflict | undefined => {
  const expected = view.totalToPay;
  if (!expected) {
    return undefined;
  }

  const actual = snapshot?.total;
  if (actual === undefined) {
    return undefined;
  }

  const actualCurrency = snapshot?.currency;
  // `view.currency` rather than `totalToPay.currency`: the view only exists when the form
  // carried an order currency, so this is always present, whereas the money helper no longer
  // invents one for an amount Allegro sent without it.
  const expectedCurrency = view.currency.trim().toLowerCase();
  const hint =
    customLineCount > 0
      ? ` This order carries ${customLineCount} custom line item(s) whose sygnatura matched no Medusa variant, which is the usual reason a total differs.`
      : "";

  if (actualCurrency && actualCurrency !== expectedCurrency) {
    return {
      conflict: "total-mismatch",
      conflict_detail: `Currency mismatch: Allegro charged ${expected.amount} ${expectedCurrency.toUpperCase()} but the Medusa order is in ${actualCurrency.toUpperCase()}, so the totals are not comparable.${hint}`,
    };
  }
  if (toMinorUnits(actual) !== toMinorUnits(expected.amount)) {
    return {
      conflict: "total-mismatch",
      conflict_detail: `Total mismatch: Allegro charged ${expected.amount} ${expectedCurrency.toUpperCase()} but the Medusa order totals ${actual}. The Allegro figure is what the buyer paid.${hint}`,
    };
  }
  return undefined;
};

/** Create or update the bookkeeping row, returning its id. */
const upsertBookkeeping = async (
  allegro: AllegroModuleService,
  checkoutFormId: string,
  patch: Record<string, unknown>,
  known?: AllegroOrderRow,
): Promise<string> => {
  const existing =
    known ??
    ((
      (await allegro.listAllegroOrders(
        { checkout_form_id: checkoutFormId },
        { take: 1 },
      )) as unknown as AllegroOrderRow[]
    )[0] as AllegroOrderRow | undefined);
  if (existing) {
    await allegro.updateAllegroOrders([{ id: existing.id, ...patch }] as never);
    return existing.id;
  }
  const [created] = (await allegro.createAllegroOrders([patch] as never)) as unknown as {
    id: string;
  }[];
  return created.id;
};

/**
 * Apply one checkout form: bookkeeping row, Medusa order, status, watermark, event.
 *
 * THROWS when the form did not land, and that throw is load-bearing: it is the only
 * thing that holds the event cursor. See `drainOrderEvents`.
 */
export const applyCheckoutForm = async (
  container: MedusaContainer,
  allegro: AllegroModuleService,
  logger: Logger,
  options: AllegroSyncOptions,
  form: AllegroCheckoutForm,
): Promise<ApplyFormResult> => {
  const read = readCheckoutForm(form);
  const derived = mapCheckoutFormStatus(form);

  if (!read.ok) {
    // The form's money could not be read, so it is NOT applied. Recording the Allegro
    // statuses and the precise reason still happens - the form has to stay visible - but
    // no Medusa order is created and no `derived_status` is advanced. The throw feeds the
    // streak/quarantine machinery exactly like any other per-form failure, so a transient
    // shape glitch retries and a permanently malformed form is eventually set aside with
    // its reason on the row.
    //
    // Creating the order anyway was the old behaviour, and it produced orders whose
    // totals silently disagreed with the Allegro total stored beside them.
    await upsertBookkeeping(allegro, read.facts.checkoutFormId, {
      allegro_status: read.facts.allegroStatus ?? null,
      buyer_login: read.facts.buyerLogin ?? null,
      checkout_form_id: read.facts.checkoutFormId,
      currency: read.facts.currency ?? null,
      fulfillment_status: read.facts.fulfillmentStatus ?? null,
      last_error: `unusable checkout form: ${read.problems.join("; ")}`,
      last_event_at: read.facts.updatedAt ? new Date(read.facts.updatedAt) : null,
      total_to_pay: read.facts.totalToPayAmount ?? null,
    });
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `checkout form ${read.facts.checkoutFormId} was not applied: ${read.problems.join("; ")}`,
    );
  }

  const { view } = read;

  const [existing] = (await allegro.listAllegroOrders(
    { checkout_form_id: view.checkoutFormId },
    { take: 1 },
  )) as unknown as AllegroOrderRow[];

  // `derived_status` is written in the SAME operation as any status action, so a
  // suppressed write self-heals on the next pass rather than latching forever. See
  // `resolveStatusWrite`.
  const write = resolveStatusWrite(derived, existing);

  const variantIdsBySku = await resolveVariantIdsBySku(
    container,
    view.lines.map((line) => line.sku).filter((sku): sku is string => Boolean(sku)),
  );
  const { conflicts, items } = buildOrderItems(view.lines, variantIdsBySku);

  // Step 1: the bookkeeping row, WITHOUT `synced_at`. The raw Allegro statuses are
  // recorded whatever happens next, so the admin can see the upstream state even for
  // a form whose Medusa order could not be created.
  const bookkeeping: Record<string, unknown> = {
    allegro_status: view.allegroStatus ?? null,
    buyer_login: view.buyerLogin ?? null,
    checkout_form_id: view.checkoutFormId,
    currency: view.currency,
    fulfillment_status: view.fulfillmentStatus ?? null,
    last_event_at: view.updatedAt ? new Date(view.updatedAt) : null,
    line_conflicts: conflicts.length > 0 ? conflicts : null,
    total_to_pay: view.totalToPayAmount ?? null,
  };

  const rowId = await upsertBookkeeping(allegro, view.checkoutFormId, bookkeeping, existing);

  // Step 2: the Medusa order, if this form has none.
  let medusaOrderId = existing?.medusa_order_id ?? undefined;
  let created = false;
  let lastError: string | undefined;
  if (!medusaOrderId) {
    // ADOPT before creating. The bookkeeping row's `medusa_order_id` is written in a
    // separate statement from the order creation, so a crash (or a failed link write) in
    // between leaves a real Medusa order that this row does not know about - and the next
    // pass, seeing a null, created a SECOND one. Nothing reconciled them, so a marketplace
    // order silently became two Medusa orders, each pickable and shippable.
    const adopted = await findExistingMedusaOrder(container, logger, view.checkoutFormId);
    if (adopted) {
      medusaOrderId = adopted;
      logger.warn(
        `[allegro-orders] adopted existing Medusa order ${adopted} for checkout form ${view.checkoutFormId}; a previous pass created it but did not record the link. No duplicate was created.`,
      );
      await linkMedusaOrder(allegro, logger, rowId, medusaOrderId, view.checkoutFormId);
    } else {
      const outcome = await createMedusaOrder(container, logger, options, view, items, derived);
      if (outcome.id) {
        medusaOrderId = outcome.id;
        created = true;
        await linkMedusaOrder(allegro, logger, rowId, medusaOrderId, view.checkoutFormId);
      } else {
        lastError = outcome.error;
      }
    }
  }

  // One read of the order, serving both of the steps below: its status decides whether the
  // action is already achieved, and its total is what the money reconciliation compares.
  const snapshot = medusaOrderId
    ? await readMedusaOrder(container, logger, medusaOrderId)
    : undefined;

  // Step 2b: the inventory reservations.
  //
  // BEFORE the payment (3c) on purpose. Registering the payment emits `payment.captured`,
  // which is the head of the invoicing and digital-delivery chain that ends in a
  // fulfillment - so an order whose reservation lands afterwards is an order whose first
  // fulfillment attempt can still fail. Reserving first costs nothing and closes that race.
  //
  // Run on EVERY pass, not only the creating one: that is what heals the orders created
  // before this existed, through the reconciliation sweep, with no backfill script. It is
  // free on a healthy order - the plan subtracts the reservations that already exist and
  // comes back empty.
  //
  // Never gated on `lastError` and never a reason to set it. A line that cannot be reserved
  // is a catalogue problem no retry of THIS form fixes, and holding the event cursor on it
  // would stall every later order behind it.
  let reservationsCreated = 0;
  const orderIsCancelled = derived === "cancelled" || snapshot?.status === "canceled";
  if (medusaOrderId && !orderIsCancelled) {
    const reserved = await ensureOrderReservations(container, logger, medusaOrderId);
    reservationsCreated = reserved.created;
  }

  // Step 3: the status action.
  if (medusaOrderId && write.status) {
    const outcome = await applyMedusaAction(
      container,
      logger,
      medusaOrderId,
      write.status,
      snapshot?.status,
    );
    if (outcome.kind === "failed") {
      lastError ??= outcome.error;
    } else if (outcome.kind === "satisfied" && outcome.note) {
      // An already-satisfied action counts as LANDED, so `derived_status` advances and the
      // form stops being retried. Reporting it as a failure was a permanent latch: the gate
      // on `derived_status` meant it never advanced, every pass retried the same impossible
      // action, and the form quarantined after five with no repair able to clear it - which
      // was GUARANTEED for any form first seen as CANCELLED, because `createMedusaOrder`
      // creates it already cancelled and step 3 then tries to cancel it again.
      logger.info(
        `[allegro-orders] checkout form ${view.checkoutFormId}: ${outcome.note}. Treated as applied.`,
      );
    }
  }

  // Step 3c: the money the buyer already paid.
  //
  // Here rather than only in the reconciliation sweep, because this is the path that runs
  // seconds after the buyer pays: the `READY_FOR_PROCESSING` event arrives, the form is
  // re-read, and the payment should be recorded in the same pass. The sweep underneath is
  // the safety net for a lost event, not the mechanism.
  //
  // A failure here deliberately does NOT set `lastError`. Holding the event cursor on a
  // payment problem would stall every LATER order behind one whose payment module is
  // misconfigured, and it is not needed: the sweep classifies by the order's ACTUAL payment
  // state rather than by `derived_status`, so an order that failed to record its payment
  // stays in the fast tier and is retried within seconds regardless of what this row says.
  let paymentRegistered = false;
  let paymentError: string | undefined;
  if (medusaOrderId) {
    const paymentState = await readOrderPaymentState(container, logger, medusaOrderId);
    const outcome = await registerOrderPayment(
      container,
      logger,
      medusaOrderId,
      planOrderPayment(
        readPaymentFacts(form),
        paymentState,
        snapshot?.currency ?? view.currency.trim().toLowerCase(),
      ),
    );
    paymentRegistered = outcome.registered;
    paymentError = outcome.error;
  }

  // Step 3d: the customer's name.
  //
  // After the order exists, because there is no other moment: `createOrderWorkflow`
  // takes an email and creates the customer from that alone, with every name column
  // NULL. Running it on EVERY pass rather than only on the pass that created the order
  // is what makes the sweep heal the customers created before this existed - the plan
  // is recomputed from what the row currently holds, so an already-named customer costs
  // nothing and a null-named one is filled wherever it next gets swept.
  //
  // Like the payment above, a failure here deliberately does NOT set `lastError`: an
  // unnamed customer is not a reason to hold the event cursor and stall every later
  // order behind it.
  let customerNamed = false;
  if (medusaOrderId) {
    const outcome = await nameOrderCustomer(
      container,
      logger,
      medusaOrderId,
      planCustomerName(readBuyerIdentity(form), snapshot?.customer),
    );
    customerNamed = outcome.named;
  }

  // Step 3e: the order's addresses.
  //
  // Same shape and same reason as the customer name above, and run on EVERY pass for
  // the same reason: an order created from a checkout form the buyer had not finished
  // has no address, and nothing else ever writes one - addresses are set only inside
  // `createOrderWorkflow`. Without this the order stays address-less forever and
  // cannot be invoiced, which is what happened to order #49.
  //
  // Gap only. An address already on the order is never touched, even if Allegro's
  // copy differs; see `planOrderAddressRepair`.
  //
  // Like the name fill, a failure here deliberately does NOT set `lastError`: a
  // missing address is not a reason to hold the event cursor and stall every later
  // order behind it.
  let addressRepaired = false;
  // The billing address the order carries once this pass has landed. It starts as
  // whatever the order already held and moves only if this pass wrote a new one, which
  // is what step 6 tests for completeness.
  let billingAddressNow = snapshot?.billingAddress;
  if (medusaOrderId && snapshot) {
    const plan = planOrderAddressRepair(
      { billingAddress: view.billingAddress, shippingAddress: view.shippingAddress },
      { billingAddress: snapshot.billingAddress, shippingAddress: snapshot.shippingAddress },
    );
    const outcome = await repairOrderAddresses(container, logger, medusaOrderId, plan);
    addressRepaired = outcome.repaired;
    if (outcome.repaired && plan.kind === "write" && plan.patch.billing_address) {
      // The planned patch rather than a re-read. `repairOrderAddresses` merges it once
      // more under the order's freshest values before writing, and that merge can only
      // KEEP fields that were already non-blank - so an address the planner judged
      // usable is still usable after it, and a second query per form would learn
      // nothing this does not already know.
      billingAddressNow = plan.patch.billing_address;
    }
  }

  // Step 3f: the invoice recipient's tax id, on `order.metadata.nip`.
  //
  // Same shape and same reason as the two fills above, and run on EVERY pass for the
  // same reason. Two orders need it: one created before the tax id stopped being
  // concatenated into `billing_address.company`, and one whose billing address is
  // filled in by step 3e - that fill writes a CLEAN company name, so without this the
  // tax id would have nowhere left to live and a company sale would be invoiced as a
  // consumer one.
  //
  // Gap only. A tax id already on the order is never touched; see `planOrderTaxIdFill`.
  //
  // Like the two fills above, a failure here deliberately does NOT set `lastError`: an
  // order without this key is still invoiceable - the inFakt plugin also parses a NIP
  // out of `billing_address.company` - so it is not a reason to hold the event cursor.
  let taxIdFilled = false;
  if (medusaOrderId && snapshot) {
    const outcome = await fillOrderTaxId(
      container,
      logger,
      medusaOrderId,
      planOrderTaxIdFill(view.billingTaxId, snapshot.metadata),
    );
    taxIdFilled = outcome.filled;
  }

  // Step 3b: reconcile the money. Read-only, and never a reason to withhold the order.
  // `undefined` clears any conflict a previous pass recorded, so a repaired order stops being
  // reported without needing its own action.
  const totalConflict = medusaOrderId
    ? reconcileOrderTotal(view, snapshot, conflicts.length)
    : undefined;
  if (totalConflict) {
    logger.warn(
      `[allegro-orders] checkout form ${view.checkoutFormId} (Medusa order ${medusaOrderId}): ${totalConflict.conflict_detail}`,
    );
  }

  // Step 4: the watermark, LAST. A crash before here leaves the row unfinished and
  // the next pass repairs it.
  //
  // `derived_status` is gated on the pass having LANDED, exactly like `synced_at`. It used
  // to be written unconditionally, which permanently suppressed the retry: `derived_status`
  // is the comparison basis, so once it had advanced, `resolveStatusWrite` saw no
  // transition and returned no `status` - and the cancel or complete that had just failed
  // was never attempted again. The order froze mid-ladder with a stale Medusa status.
  //
  // Gating on the whole `lastError` rather than only on the action's own error is
  // deliberate and strictly safer: when the order CREATE failed no action ran at all, so
  // an action-only gate would still advance `derived_status` and suppress the action on
  // the later pass that does create the order.
  const landed = !lastError;
  await allegro.updateAllegroOrders([
    {
      id: rowId,
      last_error: lastError ?? null,
      // Written on every pass that got as far as having an order, including the null that
      // CLEARS a stale conflict. A reconciliation report that only ever set the column would
      // leave a repaired order looking broken forever.
      ...(medusaOrderId
        ? {
            conflict: totalConflict?.conflict ?? null,
            conflict_detail: totalConflict?.conflict_detail ?? null,
          }
        : {}),
      ...(landed && write.derived_status ? { derived_status: write.derived_status } : {}),
      ...(landed ? { synced_at: new Date() } : {}),
    },
  ] as never);

  // Step 5: `order.placed`, the event core does NOT emit for an order created through
  // `createOrderWorkflow`. See `emitOrderPlaced` for why it is emitted here at all and
  // why the payload is core's verbatim.
  //
  // Gated on `created` alone, and that gate is the whole idempotency argument: `created`
  // is set only by the pass that actually ran `createOrderWorkflow`. Every way a form
  // gets re-applied - a redelivered Allegro event, a forced refresh, the reconciliation
  // sweep, the adoption path that picks up an order a crashed pass left behind - takes
  // the `medusaOrderId` branch instead and leaves `created` false, so none of them can
  // announce the same sale twice.
  //
  // BEFORE the throw below rather than after it, deliberately. `lastError` is about the
  // Allegro-side status ladder, not about whether the order exists - and the retry that
  // eventually lands finds `medusa_order_id` already set, so `created` is false there and
  // the announcement would never happen at all. Emitting here makes it exactly once per
  // created order, whatever else the pass could not finish.
  //
  // The one gap left is a crash between `linkMedusaOrder` and this line: the next pass
  // adopts the order rather than creating it, so it does not emit. Announcing on adoption
  // would close that gap and open a worse one - adoption also runs for an order a crashed
  // pass created minutes ago, and a duplicate announcement cannot be taken back.
  let orderPlacedEmitted = false;
  if (created && medusaOrderId) {
    orderPlacedEmitted = await emitOrderPlaced(container, logger, medusaOrderId);
  }

  // Step 6: `allegro.order.billing_ready`, the moment the order can actually be invoiced.
  //
  // Nothing else announces it. Steps 3e and 3f write through the Order module service to
  // step around medusajs/medusa#16636, so the billing address and the tax id land with no
  // `order.updated` and no event of any kind - while `payment.captured` has already fired
  // minutes earlier and sent the invoicing plugin at an order with no address.
  //
  // TWO ARMS, and exactly one of them is ever evaluated, which is the whole
  // fire-once-per-pass argument:
  //
  // - The order was CREATED this pass, already carrying a usable billing address. Without
  //   this arm, an order whose form was complete from the start would never get the event
  //   at all: steps 3e and 3f both correctly find nothing to do on the creating pass -
  //   the address is already there and `createMedusaOrder` already wrote `metadata.nip` -
  //   so the edge below never fires for it, and its invoice would wait for a fallback.
  //
  // - Otherwise, this pass CHANGED something (`repaired` or `filled`) and the billing data
  //   is now complete. The edge is what keeps the event off all ~20s passes in between:
  //   both signals are per-pass, set only by a write that actually happened, so a form
  //   re-applied by a redelivered event, a forced refresh or the reconciliation sweep
  //   changes nothing and announces nothing.
  //
  // Completeness is tested against the FIELD VALUES with `isUsableAddress` - the invoice
  // builder's own three - never against the presence of an address row, which is the
  // reading that let a name-and-country-only address pass as complete.
  //
  // Never gated on payment or status. This says the DATA is there, not "invoice this now";
  // a subscriber decides for itself whether an order is paid, cancelled or already
  // invoiced. See `emitOrderBillingReady`.
  let billingReadyEmitted = false;
  const billingReady = created
    ? isUsableAddress(view.billingAddress)
    : (addressRepaired || taxIdFilled) && isUsableAddress(billingAddressNow);
  if (billingReady && medusaOrderId) {
    billingReadyEmitted = await emitOrderBillingReady(container, logger, medusaOrderId);
  }

  if (lastError) {
    // Thrown so the cursor holds and the form is retried. A form whose order could
    // not be created is exactly the case the quarantine machinery exists for: it
    // retries five times, then lets the cursor past while keeping the form visible.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `checkout form ${view.checkoutFormId}: ${lastError}`,
    );
  }

  return {
    conflicts,
    created,
    addressRepaired,
    billingReadyEmitted,
    customerNamed,
    medusaOrderId,
    orderPlacedEmitted,
    ...(paymentError ? { paymentError } : {}),
    paymentRegistered,
    reservationsCreated,
    totalMismatch: Boolean(totalConflict),
    // A brand-new order always counts as a status change; an existing one only when
    // the derived status actually moved. That distinction is what makes the summary's
    // `statusChanged` mean something against a forced refresh that always writes.
    statusChanged: created || Boolean(write.status && existing),
  };
};
