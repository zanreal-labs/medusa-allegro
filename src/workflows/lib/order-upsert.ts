import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import {
  cancelOrderWorkflow,
  completeOrderWorkflow,
  createOrderWorkflow,
} from "@medusajs/medusa/core-flows";
import type { AllegroCheckoutForm } from "../../lib/allegro/types";
import {
  mapCheckoutFormStatus,
  medusaActionForStatus,
  resolveStatusWrite,
} from "../../lib/sync/order-status";
import type { DerivedOrderStatus } from "../../lib/sync/order-status";
import type { AllegroSyncOptions } from "../../modules/allegro/service";
import type AllegroModuleService from "../../modules/allegro/service";
import { readCheckoutForm } from "./checkout-form";
import type { CheckoutFormLine, CheckoutFormView } from "./checkout-form";

/**
 * Applying one Allegro checkout form to Medusa.
 *
 * ## Crash-safe ordering
 *
 * The order of writes is the whole correctness argument, and it is:
 *
 * 1. Upsert the `allegro_order` bookkeeping row WITHOUT `synced_at`.
 * 2. Create the Medusa order, if this form has none yet.
 * 3. Act on the status (cancel / complete), writing `derived_status` in the SAME
 *    operation.
 * 4. Stamp `synced_at` LAST.
 *
 * A crash anywhere before step 4 leaves the row looking unfinished, so the next
 * pass repairs it. Stamping earlier would let a half-applied form read as done -
 * and the event cursor would then be free to move past it.
 *
 * ## Unmatched lines do not lose the sale
 *
 * A line whose sygnatura matches no Medusa variant is carried as a title-only
 * custom line item and recorded in `line_conflicts`. Refusing the order would be
 * worse: the sale happened on Allegro whatever Medusa's catalogue says, and an order
 * nobody can see is not a safer outcome than one that is visibly half-mapped.
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
    return { error: error instanceof Error ? error.message : String(error) };
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
const applyMedusaAction = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  derived: DerivedOrderStatus,
): Promise<string | undefined> => {
  const action = medusaActionForStatus(derived);
  if (action === "none") {
    return undefined;
  }
  try {
    if (action === "cancel") {
      await cancelOrderWorkflow(container).run({ input: { order_id: orderId } });
    } else {
      await completeOrderWorkflow(container).run({ input: { orderIds: [orderId] } });
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[allegro-orders] could not ${action} Medusa order ${orderId} for Allegro status "${derived}": ${message}. The Allegro-derived status is still recorded.`,
    );
    return `${action} failed: ${message}`;
  }
};

/**
 * Apply one checkout form: bookkeeping row, Medusa order, status, watermark.
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
  const view = readCheckoutForm(form);
  const derived = mapCheckoutFormStatus(form);

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
    total_to_pay: form.summary?.totalToPay?.amount ?? null,
  };

  let rowId: string;
  if (existing) {
    rowId = existing.id;
    await allegro.updateAllegroOrders([{ id: rowId, ...bookkeeping }] as never);
  } else {
    const [created] = (await allegro.createAllegroOrders([bookkeeping] as never)) as unknown as {
      id: string;
    }[];
    rowId = created.id;
  }

  // Step 2: the Medusa order, if this form has none.
  let medusaOrderId = existing?.medusa_order_id ?? undefined;
  let created = false;
  let lastError: string | undefined;
  if (!medusaOrderId) {
    const outcome = await createMedusaOrder(container, logger, options, view, items, derived);
    if (outcome.id) {
      medusaOrderId = outcome.id;
      created = true;
      await allegro.updateAllegroOrders([{ id: rowId, medusa_order_id: medusaOrderId }] as never);
    } else {
      lastError = outcome.error;
    }
  }

  // Step 3: the status action, and `derived_status` written with it.
  if (medusaOrderId && write.status) {
    const actionError = await applyMedusaAction(container, logger, medusaOrderId, write.status);
    lastError ??= actionError;
  }

  // Step 4: the watermark, LAST. A crash before here leaves the row unfinished and
  // the next pass repairs it.
  await allegro.updateAllegroOrders([
    {
      id: rowId,
      last_error: lastError ?? null,
      ...(write.derived_status ? { derived_status: write.derived_status } : {}),
      ...(lastError ? {} : { synced_at: new Date() }),
    },
  ] as never);

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
    medusaOrderId,
    // A brand-new order always counts as a status change; an existing one only when
    // the derived status actually moved. That distinction is what makes the summary's
    // `statusChanged` mean something against a forced refresh that always writes.
    statusChanged: created || Boolean(write.status && existing),
  };
};
