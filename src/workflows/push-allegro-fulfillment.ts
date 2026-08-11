import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";
import { AllegroApiError } from "../lib/allegro/errors";
import type { AllegroSettableFulfillmentStatus } from "../lib/allegro/types";
import { ALLEGRO_MODULE } from "../modules/allegro";
import type AllegroModuleService from "../modules/allegro/service";

/**
 * Push a Medusa fulfillment back to Allegro's seller-managed status.
 *
 * The one place this plugin writes to Allegro on a Medusa EVENT rather than on a
 * schedule, and it is best-effort by design. The reasoning:
 *
 * - **A fulfillment is a point-in-time act**, not reconcilable state. There is no
 *   "current fulfillment status" in Medusa that a periodic sweep could compare
 *   against Allegro's and correct - a shipment either happened or it did not. So
 *   unlike stock and price, there is nothing for a reconciliation loop to do here,
 *   and the event is the only signal.
 * - **Which is why a failure must never propagate.** The Medusa fulfillment has
 *   already been created by the time this runs; throwing would fail a subscriber
 *   over a marketplace call, and the shipment would still have happened. The error
 *   is recorded on the `allegro_order` row so an operator can see the marketplace
 *   was not told, and set the status by hand.
 *
 * `RETURNED` is deliberately not reachable from here: Allegro manages it (it appears
 * once every unit is returned and refunded) and `PUT .../fulfillment` rejects it.
 */

/** Statuses this push will set, by the Medusa event that triggered it. */
const STATUS_BY_EVENT: Record<string, AllegroSettableFulfillmentStatus> = {
  // A fulfillment exists but has no shipment yet: the goods are packed, not gone.
  "order.fulfillment_created": "READY_FOR_SHIPMENT",
  // A shipment exists: it is on its way.
  "shipment.created": "SENT",
};

export interface PushFulfillmentResult {
  /** False when nothing was attempted (not an Allegro order, not connected). */
  attempted: boolean;
  /** The status this push set, when it set one. */
  status?: AllegroSettableFulfillmentStatus;
  error?: string;
}

/**
 * Tell Allegro about a Medusa fulfillment for an Allegro-sourced order.
 *
 * A no-op for any order that did not come from Allegro, which is the common case in
 * a store selling through several channels - the lookup is by `medusa_order_id`
 * against this plugin's own bookkeeping, so a non-Allegro order costs one indexed
 * read and nothing else.
 */
export const pushAllegroFulfillment = async (
  container: MedusaContainer,
  input: { orderId: string; eventName: string },
): Promise<PushFulfillmentResult> => {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const allegro = container.resolve<AllegroModuleService>(ALLEGRO_MODULE);

  const status = STATUS_BY_EVENT[input.eventName];
  if (!status) {
    return { attempted: false };
  }

  const [row] = (await allegro.listAllegroOrders(
    { medusa_order_id: input.orderId },
    { take: 1 },
  )) as unknown as { id: string; checkout_form_id: string }[];
  if (!row) {
    return { attempted: false };
  }

  const client = await allegro.getClient();
  if (!client) {
    const error = "Allegro is not connected, so the fulfillment status was not pushed.";
    await allegro.updateAllegroOrders([{ id: row.id, last_error: error }] as never);
    return { attempted: false, error };
  }

  try {
    await client.updateCheckoutFormFulfillment(row.checkout_form_id, status);
    await allegro.updateAllegroOrders([
      { fulfillment_status: status, id: row.id, last_error: null },
    ] as never);
    logger.info(
      `[allegro-fulfillment] set checkout form ${row.checkout_form_id} to ${status} for Medusa order ${input.orderId}.`,
    );
    return { attempted: true, status };
  } catch (error) {
    const message =
      error instanceof AllegroApiError
        ? `Allegro rejected the fulfillment update (HTTP ${error.httpStatus}): ${error.message}`
        : (error instanceof Error
          ? error.message
          : String(error));
    // Recorded, never thrown. The Medusa fulfillment already exists; failing the
    // subscriber would not undo it, and it would bury the reason.
    await allegro.updateAllegroOrders([
      { id: row.id, last_error: `fulfillment push: ${message}` },
    ] as never);
    logger.warn(
      `[allegro-fulfillment] could not set ${status} on checkout form ${row.checkout_form_id}: ${message}. Set it by hand on Allegro.`,
    );
    return { attempted: true, error: message, status };
  }
};
