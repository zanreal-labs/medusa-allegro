import type { AllegroCheckoutForm } from "../allegro/types";

/**
 * The Allegro status ladder, mapped.
 *
 * Allegro reports two statuses per order - the checkout status and the
 * seller-managed fulfillment status - and their product is what an operator
 * thinks of as "where is this order". Medusa's own `order.status` enum is much
 * narrower, so the full ladder is kept on `allegro_order.derived_status` and only
 * the representable parts are pushed onto the Medusa order.
 */

/** The mapped ladder, as stored on `allegro_order.derived_status`. */
export type DerivedOrderStatus =
  | "pending"
  | "new"
  | "processing"
  | "ready_for_shipment"
  | "sent"
  | "delivered"
  | "returned"
  | "cancelled";

/**
 * Status derivable from the checkout status alone.
 *
 * `READY_FOR_PROCESSING` means the buyer's payment finalized (or they chose
 * cash-on-delivery or in-person pickup), so the order is actionable. `BOUGHT` and
 * `FILLED_IN` are still awaiting payment, and an absent status is treated the
 * same way - pending is the safe reading, because it claims nothing.
 */
export const checkoutOnlyStatus = (checkoutStatus?: string | null): DerivedOrderStatus => {
  if (checkoutStatus === "CANCELLED") {
    return "cancelled";
  }
  return checkoutStatus === "READY_FOR_PROCESSING" ? "new" : "pending";
};

/**
 * Map an Allegro (checkout status, fulfillment status) pair onto the ladder, or
 * `undefined` when Allegro reports a fulfillment status this plugin does not
 * model.
 *
 * `undefined` is a real answer, not a failure: callers must leave the stored
 * status alone rather than collapse an unrecognised upstream state onto
 * "pending". Allegro adds fulfillment statuses over time (RETURNED arrived in
 * March 2025), and a mapping that guesses would silently report a returned order
 * as new.
 *
 * CANCELLED on the checkout status wins over everything. A cancelled order can
 * still carry a stale fulfillment status, and reading that instead would resurrect
 * an order the buyer or Allegro killed.
 */
export const mapStatusPair = (
  checkoutStatus?: string | null,
  fulfillmentStatus?: string | null,
): DerivedOrderStatus | undefined => {
  if (checkoutStatus === "CANCELLED") {
    return "cancelled";
  }
  switch (fulfillmentStatus) {
    case "NEW": {
      // Allegro sets fulfillment NEW as soon as the order exists, before the buyer
      // has paid. Deferring to the checkout status here is what makes the payment
      // transition visible at all: pending -> new the moment the form reaches
      // READY_FOR_PROCESSING.
      return checkoutOnlyStatus(checkoutStatus);
    }
    case "PROCESSING":
    case "SUSPENDED": {
      return "processing";
    }
    case "READY_FOR_SHIPMENT":
    case "READY_FOR_PICKUP": {
      return "ready_for_shipment";
    }
    case "SENT": {
      return "sent";
    }
    case "PICKED_UP": {
      return "delivered";
    }
    case "RETURNED": {
      // Allegro-managed, added March 2025: every unit returned and refunded.
      return "returned";
    }
    case "CANCELLED": {
      return "cancelled";
    }
    default: {
      break;
    }
  }
  if (fulfillmentStatus) {
    return undefined;
  }
  // No fulfillment state at all: the checkout status is everything we have.
  return checkoutOnlyStatus(checkoutStatus);
};

/** Map a checkout form onto the ladder. */
export const mapCheckoutFormStatus = (form: AllegroCheckoutForm): DerivedOrderStatus | undefined =>
  mapStatusPair(form.status, form.fulfillment?.status);

/** What one pass may write about status. */
export interface StatusWrite {
  /** Set when the sync should act on the Medusa order too. */
  status?: DerivedOrderStatus;
  /** Always set when `derived` was resolvable, even if `status` is suppressed. */
  derived_status?: DerivedOrderStatus;
}

/**
 * Decide whether this pass may act on the order's status.
 *
 * The comparison basis is `derived_status` - the status this sync last derived
 * from Allegro - NOT the raw `allegro_status` / `fulfillment_status` pair. That
 * distinction is the whole fix, and it is worth spelling out because the obvious
 * implementation is wrong: the raw columns are rewritten on every pass, so
 * re-deriving from them made a single suppressed status write permanent. The guard
 * would see "no transition" forever after, and the order would freeze at whatever
 * status it happened to carry.
 *
 * `derived_status` is written in the same operation as any status action, so the
 * two cannot diverge, and a write that never landed is simply retried next pass.
 *
 * Staff edits survive because a staff action changes the Medusa order without
 * touching `derived_status`: the next pass sees no Allegro transition and leaves
 * the local state alone.
 *
 * A null stored `derived_status` is treated as a transition on purpose. It means
 * the row predates this column, and healing every latched status once is worth
 * the cost of overwriting a staff override made before that point - re-applying
 * the override then sticks.
 */
export const resolveStatusWrite = (
  derived: DerivedOrderStatus | undefined,
  existing?: { derived_status?: DerivedOrderStatus | null },
): StatusWrite => {
  if (!derived) {
    // Unmodelled upstream state: change nothing, and keep the last known derived
    // status so the next recognised transition still compares cleanly.
    return {};
  }
  if (!existing) {
    return { derived_status: derived, status: derived };
  }
  if (existing.derived_status !== derived) {
    return { derived_status: derived, status: derived };
  }
  // Allegro has not moved since the last pass. Re-assert the derived status and
  // leave the order alone.
  return { derived_status: derived };
};

/**
 * The Medusa-side action a derived status calls for.
 *
 * Medusa's order status enum has no `sent` or `ready_for_shipment`, and inventing
 * them by writing the column directly would fight both the dashboard and the
 * order-edit flows. So only the two ends of the ladder that Medusa genuinely
 * models are acted on:
 *
 * - `cancel` for a cancelled order.
 * - `complete` for one Allegro reports as picked up.
 *
 * Everything in between lives on `allegro_order.derived_status`, which is what the
 * admin renders. `none` is not a gap in the mapping; it is the correct answer for
 * a state Medusa does not have.
 */
export type MedusaOrderAction = "none" | "cancel" | "complete";

export const medusaActionForStatus = (status: DerivedOrderStatus): MedusaOrderAction => {
  if (status === "cancelled") {
    return "cancel";
  }
  if (status === "delivered") {
    return "complete";
  }
  return "none";
};
