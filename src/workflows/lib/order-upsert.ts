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
      `[allegro-orders] could not query orders by \`metadata.allegro_checkout_form_id\` (${
        error instanceof Error ? error.message : String(error)
      }); falling back to a bounded newest-first scan so a duplicate order is not created.`,
    );
  }

  for (let page = 0; page < ADOPTION_MAX_PAGES; page += 1) {
    // Offset pagination, newest first: a duplicate can only have been created by a
    // recent pass, so the newest orders are where it is.
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
    `[allegro-orders] scanned ${ADOPTION_MAX_PAGES * ADOPTION_PAGE_SIZE} recent orders without finding one for checkout form ${checkoutFormId}; proceeding to create it.`,
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
      `[allegro-orders] created or adopted Medusa order ${medusaOrderId} for checkout form ${checkoutFormId} but FAILED to record the link on allegro_order ${rowId}: ${
        error instanceof Error ? error.message : String(error)
      }. The next pass adopts it by \`metadata.allegro_checkout_form_id\`; set \`medusa_order_id\` by hand if that does not happen.`,
    );
  }
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

  // Step 3: the status action.
  if (medusaOrderId && write.status) {
    const actionError = await applyMedusaAction(container, logger, medusaOrderId, write.status);
    lastError ??= actionError;
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
      ...(landed && write.derived_status ? { derived_status: write.derived_status } : {}),
      ...(landed ? { synced_at: new Date() } : {}),
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
