import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { createReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { describeError } from "../../lib/allegro/errors";
import type { AmountInput } from "../../lib/sync/money";
import { planOrderReservations, readQuantity } from "../../lib/sync/order-reservations";
import type {
  ExistingReservationView,
  InventoryItemView,
  InventoryLevelView,
  OrderLineView,
  ReservationPlan,
} from "../../lib/sync/order-reservations";

/**
 * Creating the inventory reservations an Allegro order needs to be fulfillable.
 *
 * ## Why the order-creation path has to do this
 *
 * `createOrderWorkflow` does not reserve - see `lib/sync/order-reservations.ts` for the
 * quote from Medusa's own documentation - so nothing in this plugin's pipeline ever held
 * stock against a marketplace sale. Core's `createOrderFulfillmentWorkflow` refuses to
 * fulfil a line whose variant manages inventory and has no reservation, which is what
 * `No stock reservation found for item ordli_...` is, and it refuses identically whether
 * the caller is the admin's Fulfill button or a plugin's auto-fulfilment step.
 *
 * Reserving HERE rather than in whichever plugin happens to fulfil is the difference
 * between fixing one caller and fixing the order: a reserved order is fulfillable by every
 * path Medusa offers, including the one an operator clicks.
 *
 * ## Every pass, not only creation
 *
 * `applyCheckoutForm` calls this on every pass over an order, and the reconciliation sweep
 * calls `applyCheckoutForm`. That is deliberate and it is the whole healing story: an order
 * created before this code existed - today's live one included - has its reservation
 * created by the next sweep that reaches it, with no backfill script and no second code
 * path. The plan subtracts what already exists, so a healthy order costs one read.
 *
 * ## Never fatal
 *
 * Every failure here returns rather than throws. An unreservable line is a catalogue
 * problem (no inventory level, no inventory item); holding the Allegro event cursor on it
 * would stall every later order behind a condition no retry fixes, and the sale itself is
 * not in doubt. The reservation is retried on the next pass regardless, because the plan is
 * recomputed from what actually exists.
 */

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

/**
 * The order fields the plan is computed from.
 *
 * `items.detail.*` rather than `items.quantity`: the computed `quantity` is DROPPED by the
 * serializer whenever another line-item scalar rides in the same selection - a Medusa core
 * defect bisected live on production on 2026-08-22, and the reason medusa-marken reads its
 * quantities the same way. `detail` is the source column and always arrives.
 *
 * The inventory shape mirrors core's `requiredOrderFieldsForInventoryConfirmation`, because
 * the location choice has to be made from the same facts core's own reservation path uses.
 */
const ORDER_FIELDS = [
  "id",
  "sales_channel_id",
  "items.id",
  "items.title",
  "items.detail.quantity",
  "items.detail.raw_quantity",
  "items.detail.fulfilled_quantity",
  "items.detail.raw_fulfilled_quantity",
  "items.variant.manage_inventory",
  "items.variant.allow_backorder",
  "items.variant.inventory_items.inventory_item_id",
  "items.variant.inventory_items.required_quantity",
  "items.variant.inventory_items.inventory.location_levels.location_id",
  "items.variant.inventory_items.inventory.location_levels.stocked_quantity",
  "items.variant.inventory_items.inventory.location_levels.reserved_quantity",
  "items.variant.inventory_items.inventory.location_levels.raw_stocked_quantity",
  "items.variant.inventory_items.inventory.location_levels.raw_reserved_quantity",
  "items.variant.inventory_items.inventory.location_levels.stock_locations.id",
  "items.variant.inventory_items.inventory.location_levels.stock_locations.sales_channels.id",
];

/** The row shapes `query.graph` returns for the selection above. */
interface LevelRow {
  location_id?: string | null;
  stocked_quantity?: AmountInput;
  reserved_quantity?: AmountInput;
  raw_stocked_quantity?: AmountInput;
  raw_reserved_quantity?: AmountInput;
  stock_locations?: { id?: string | null; sales_channels?: { id?: string | null }[] | null } | null;
}

interface VariantInventoryRow {
  inventory_item_id?: string | null;
  required_quantity?: AmountInput;
  inventory?: { location_levels?: LevelRow[] | null } | null;
}

interface ItemRow {
  id?: string | null;
  title?: string | null;
  detail?: {
    quantity?: AmountInput;
    raw_quantity?: AmountInput;
    fulfilled_quantity?: AmountInput;
    raw_fulfilled_quantity?: AmountInput;
  } | null;
  variant?: {
    manage_inventory?: boolean | null;
    allow_backorder?: boolean | null;
    inventory_items?: VariantInventoryRow[] | null;
  } | null;
}

/** A level's availability, floored at zero: an oversold level cannot lend negative stock. */
const levelAvailability = (level: LevelRow): number => {
  const stocked = readQuantity(level.raw_stocked_quantity ?? level.stocked_quantity);
  const reserved = readQuantity(level.raw_reserved_quantity ?? level.reserved_quantity);
  return Math.max(stocked - reserved, 0);
};

const readLevel = (level: LevelRow): InventoryLevelView | undefined => {
  const locationId = level.location_id ?? level.stock_locations?.id ?? undefined;
  if (!locationId) {
    return undefined;
  }
  return {
    available: levelAvailability(level),
    locationId,
    salesChannelIds: (level.stock_locations?.sales_channels ?? [])
      .map((channel) => channel?.id)
      .filter((id): id is string => Boolean(id)),
  };
};

const readInventoryItem = (row: VariantInventoryRow): InventoryItemView | undefined => {
  if (!row.inventory_item_id) {
    return undefined;
  }
  return {
    inventoryItemId: row.inventory_item_id,
    levels: (row.inventory?.location_levels ?? [])
      .map(readLevel)
      .filter((level): level is InventoryLevelView => level !== undefined),
    // Absent means one, which is the column's own default. Zero would silently plan no
    // reservation at all for a line that needs one.
    requiredQuantity: Math.max(readQuantity(row.required_quantity), 1),
  };
};

const readLine = (row: ItemRow): OrderLineView | undefined => {
  if (!row.id) {
    return undefined;
  }
  return {
    allowBackorder: Boolean(row.variant?.allow_backorder),
    fulfilledQuantity: readQuantity(
      row.detail?.raw_fulfilled_quantity ?? row.detail?.fulfilled_quantity,
    ),
    id: row.id,
    inventoryItems: (row.variant?.inventory_items ?? [])
      .map(readInventoryItem)
      .filter((item): item is InventoryItemView => item !== undefined),
    manageInventory: Boolean(row.variant?.manage_inventory),
    quantity: readQuantity(row.detail?.raw_quantity ?? row.detail?.quantity),
    title: row.title ?? row.id,
  };
};

/** Reservations already held against these lines, keyed for subtraction by the planner. */
const readExistingReservations = async (
  container: MedusaContainer,
  lineItemIds: readonly string[],
): Promise<ExistingReservationView[]> => {
  if (lineItemIds.length === 0) {
    return [];
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "reservations",
    fields: ["id", "line_item_id", "inventory_item_id", "quantity", "raw_quantity"],
    filters: { line_item_id: [...lineItemIds] },
  });
  return data
    .map((row) => ({
      inventoryItemId: (row.inventory_item_id as string | null) ?? "",
      lineItemId: (row.line_item_id as string | null) ?? "",
      quantity: readQuantity((row.raw_quantity ?? row.quantity) as AmountInput),
    }))
    .filter((reservation) => reservation.lineItemId && reservation.inventoryItemId);
};

/** Read the order and its existing reservations, and decide what is missing. */
export const planReservationsForOrder = async (
  container: MedusaContainer,
  orderId: string,
): Promise<ReservationPlan> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    filters: { id: orderId },
  });
  const order = data[0];
  if (!order) {
    return { create: [], gaps: [] };
  }
  const lines = ((order.items as ItemRow[] | null) ?? [])
    .map(readLine)
    .filter((line): line is OrderLineView => line !== undefined);
  const existing = await readExistingReservations(
    container,
    lines.map((line) => line.id),
  );
  const salesChannelId = (order.sales_channel_id as string | null) ?? undefined;
  return planOrderReservations({
    existing,
    lines,
    orderId,
    ...(salesChannelId ? { salesChannelId } : {}),
  });
};

/** What one attempt to reserve did. */
export interface EnsureReservationsResult {
  /** Reservations created on this pass. Non-zero from the sweep means an order was healed. */
  created: number;
  /** Lines that need stock held and have nowhere to hold it. Warned, never fatal. */
  gaps: number;
  /** Set when the read or the write failed. Never thrown - see the module docblock. */
  error?: string;
}

/**
 * Create whatever reservations this order is missing.
 *
 * `createReservationsWorkflow` rather than the inventory module directly: it is the stock
 * path, it takes the per-inventory-item lock that stops two concurrent passes reserving the
 * same stock twice, and it emits `reservation-item.created`, which anything watching
 * inventory expects to see.
 *
 * Reservations are created ONE workflow run per plan, not per line, so a plan that is
 * entirely satisfiable lands atomically: the workflow's compensation deletes the lot if any
 * single reservation fails, and a half-reserved order is exactly the state that makes the
 * admin's Fulfill button fail in a way nobody can read.
 */
export const ensureOrderReservations = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
): Promise<EnsureReservationsResult> => {
  let plan: ReservationPlan;
  try {
    plan = await planReservationsForOrder(container, orderId);
  } catch (error) {
    const message = describeError(error);
    logger.warn(
      `[allegro-orders] could not work out which inventory reservations Medusa order ${orderId} is missing: ${message}. No reservation is created against a state that could not be read; the next reconciliation sweep retries it.`,
    );
    return { created: 0, error: message, gaps: 0 };
  }

  for (const gap of plan.gaps) {
    logger.warn(
      `[allegro-orders] Medusa order ${orderId}, line ${gap.lineItemId}: ${gap.reason}`,
    );
  }

  if (plan.create.length === 0) {
    return { created: 0, gaps: plan.gaps.length };
  }

  try {
    await createReservationsWorkflow(container).run({
      input: { reservations: plan.create },
    });
    logger.info(
      `[allegro-orders] reserved inventory for ${plan.create.length} line item(s) on Medusa order ${orderId}. Allegro orders are created by \`createOrderWorkflow\`, which does not reserve, so without this the order cannot be fulfilled - by the admin's button or by anything else.`,
    );
    return { created: plan.create.length, gaps: plan.gaps.length };
  } catch (error) {
    const message = describeError(error);
    logger.warn(
      `[allegro-orders] could not reserve inventory for Medusa order ${orderId}: ${message}. The order stands and the licence/delivery work is unaffected, but fulfilling it will fail with "No stock reservation found" until this succeeds. The next reconciliation sweep retries it.`,
    );
    return { created: 0, error: message, gaps: plan.gaps.length };
  }
};
