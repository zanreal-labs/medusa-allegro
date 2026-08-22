/**
 * Planning the inventory reservations an Allegro-created order is missing.
 *
 * ## Why this exists
 *
 * `createOrderWorkflow` - the workflow this plugin creates every Allegro order with -
 * validates that stock exists but deliberately creates NO reservations. Medusa says so
 * itself, in the workflow's own documentation:
 *
 * > This workflow only validates that the order's items have sufficient inventory
 * > quantity; it doesn't create inventory reservations for the order's items. So,
 * > fulfilling an order created by this workflow with `createOrderFulfillmentWorkflow`
 * > throws an error for items whose variants have `manage_inventory` enabled [...] To
 * > create the reservations, use the `createReservationsWorkflow` after creating the
 * > order, passing each reservation the `line_item_id` of the order's item so that the
 * > fulfillment workflow can find it.
 *
 * Only cart checkout reserves (`completeCartWorkflow` runs `reserveInventoryStep`), and no
 * Allegro order goes through a cart. The consequence in production was
 * `No stock reservation found for item ordli_...` for EVERY marketplace order - thrown
 * both by the admin's Fulfill button and by any plugin calling
 * `createOrderFulfillmentWorkflow`, which left real, paid, delivered orders reading as
 * unfulfilled and stalled the Allegro ship-status write-back behind them.
 *
 * This module is the arithmetic half of the fix: what to reserve, where, and how much,
 * as a pure function over a snapshot. `workflows/lib/order-reservations.ts` is the half
 * that reads the snapshot and writes the reservations.
 *
 * ## The three properties that make it safe to run on every pass
 *
 * 1. **Idempotent.** Reservations that already exist are SUBTRACTED from what is needed,
 *    per line and per inventory item. A fully reserved order plans nothing, so the
 *    reconciliation sweep re-checking an order costs one read and writes nothing - which
 *    is also what heals every order created before this existed.
 * 2. **Never over-reserves.** The need is `required_quantity x (ordered - fulfilled)`.
 *    Fulfilled units have already consumed their reservation (core deletes or shrinks it
 *    as it fulfils), so reserving against them again would hold stock that has left the
 *    building.
 * 3. **Never fatal.** A line with no inventory level anywhere is REPORTED, not thrown.
 *    An unreservable line is a catalogue problem; failing order creation over it would
 *    lose the sale, which is strictly worse and is the same trade `line_conflicts` makes.
 */

import { parseAmount } from "./money";
import type { AmountInput } from "./money";

/**
 * A quantity as Medusa hands it back, as a whole number.
 *
 * Quantities travel as `BigNumber` instances exactly like the money columns, so they go
 * through the same parser rather than a second one - see `parseAmount`. Floored, because a
 * fractional reservation is not a thing the inventory module models, and unreadable means
 * ZERO rather than one: reserving a unit on a quantity nobody could read is how stock gets
 * held against an order that never wanted it.
 */
export const readQuantity = (value: AmountInput): number => {
  const parsed = parseAmount(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
};

/** One inventory level, as the planner needs to see it. */
export interface InventoryLevelView {
  locationId: string;
  /** `stocked - reserved`, in whole units. */
  available: number;
  /** Sales channels served by this level's stock location. */
  salesChannelIds: string[];
}

/** One inventory item behind a variant, with the levels it is stocked at. */
export interface InventoryItemView {
  inventoryItemId: string;
  /** Units of this inventory item consumed by ONE unit of the variant. Defaults to 1. */
  requiredQuantity: number;
  levels: InventoryLevelView[];
}

/** One order line, as the planner needs to see it. */
export interface OrderLineView {
  id: string;
  title: string;
  quantity: number;
  /** Units already fulfilled. Their reservation is gone; reserving them again double-holds. */
  fulfilledQuantity: number;
  manageInventory: boolean;
  allowBackorder: boolean;
  inventoryItems: InventoryItemView[];
}

/** An existing reservation, as read back before planning. */
export interface ExistingReservationView {
  lineItemId: string;
  inventoryItemId: string;
  quantity: number;
}

/** One reservation to create, in `createReservationsWorkflow`'s own input shape. */
export interface ReservationToCreate {
  line_item_id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  allow_backorder: boolean;
  description: string;
}

/** A line that needed a reservation and could not get one. Logged, never thrown. */
export interface ReservationGap {
  lineItemId: string;
  reason: string;
}

/** What one pass decided to reserve. */
export interface ReservationPlan {
  create: ReservationToCreate[];
  /** Lines that need stock held but have nowhere to hold it. */
  gaps: ReservationGap[];
}

/** The snapshot the plan is computed from. */
export interface ReservationSnapshot {
  orderId: string;
  /** Used only to prefer a location the order's channel actually sells from. */
  salesChannelId?: string;
  lines: OrderLineView[];
  existing: ExistingReservationView[];
}

/**
 * Pick the location to hold the stock at.
 *
 * The preference ladder mirrors core's own (`prepareConfirmInventoryInput`), and for the
 * same reason: a reservation at a location the order's sales channel does not serve is
 * invisible to every availability calculation the storefront makes, so it holds stock
 * without protecting the sale.
 *
 * 1. A channel-served location with enough available stock.
 * 2. Any location with enough available stock. A marketplace sale that already happened is
 *    not improved by refusing to record where its stock is.
 * 3. A channel-served location that merely HAS a level.
 * 4. Any location with a level at all.
 *
 * Undefined only when the inventory item is stocked nowhere, which is the one case the
 * caller reports as a gap.
 */
const pickLocation = (
  levels: readonly InventoryLevelView[],
  needed: number,
  salesChannelId: string | undefined,
): string | undefined => {
  const serves = (level: InventoryLevelView): boolean =>
    salesChannelId === undefined || level.salesChannelIds.includes(salesChannelId);
  const enough = (level: InventoryLevelView): boolean => level.available >= needed;

  return (
    levels.find((level) => serves(level) && enough(level))?.locationId ??
    levels.find(enough)?.locationId ??
    levels.find(serves)?.locationId ??
    levels[0]?.locationId
  );
};

/** Reservation units already held for one line's inventory item. */
const alreadyReserved = (
  existing: readonly ExistingReservationView[],
  lineItemId: string,
  inventoryItemId: string,
): number =>
  existing
    .filter(
      (reservation) =>
        reservation.lineItemId === lineItemId &&
        reservation.inventoryItemId === inventoryItemId,
    )
    .reduce((sum, reservation) => sum + reservation.quantity, 0);

/**
 * What this order is missing, line by line.
 *
 * A line contributes nothing when its variant does not manage inventory (core's
 * fulfillment never asks for a reservation there), when every ordered unit is already
 * fulfilled, or when the existing reservations already cover the outstanding units. Those
 * three silences are what make this safe to call on every drain tick and every sweep pass.
 */
export const planOrderReservations = (snapshot: ReservationSnapshot): ReservationPlan => {
  const create: ReservationToCreate[] = [];
  const gaps: ReservationGap[] = [];

  for (const line of snapshot.lines) {
    if (!line.manageInventory) {
      continue;
    }
    const outstanding = line.quantity - line.fulfilledQuantity;
    if (outstanding <= 0) {
      continue;
    }
    if (line.inventoryItems.length === 0) {
      // The variant manages inventory but has no inventory item behind it, so core's
      // fulfillment will demand a reservation that can never exist. Worth naming: it is a
      // catalogue defect an operator has to fix, and it is invisible until somebody tries
      // to ship.
      gaps.push({
        lineItemId: line.id,
        reason: `"${line.title}" manages inventory but its variant has no inventory item, so no reservation can be created and fulfilling it will fail until the catalogue is fixed`,
      });
      continue;
    }

    for (const item of line.inventoryItems) {
      const needed = item.requiredQuantity * outstanding;
      const held = alreadyReserved(snapshot.existing, line.id, item.inventoryItemId);
      const missing = needed - held;
      if (missing <= 0) {
        continue;
      }
      const locationId = pickLocation(item.levels, missing, snapshot.salesChannelId);
      if (!locationId) {
        gaps.push({
          lineItemId: line.id,
          reason: `"${line.title}" needs ${missing} unit(s) of inventory item ${item.inventoryItemId} reserved, but that item has no stock level at any location. Create one (or run the stock sync) and the next pass reserves it.`,
        });
        continue;
      }
      create.push({
        allow_backorder: line.allowBackorder,
        description: `Allegro order ${snapshot.orderId}`,
        inventory_item_id: item.inventoryItemId,
        line_item_id: line.id,
        location_id: locationId,
        quantity: missing,
      });
    }
  }

  return { create, gaps };
};
