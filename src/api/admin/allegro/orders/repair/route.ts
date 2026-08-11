import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { repairAllegroOrder } from "../../../../../workflows/drain-allegro-orders";

/**
 * POST /admin/allegro/orders/repair
 *
 * `{ "checkout_form_id": "..." }`. Re-reads one Allegro order and applies it.
 *
 * The remedy for a quarantined order. The drain gives up on a form after five
 * consecutive failures so the event cursor can move past it, and this is how an
 * operator retries that one form once the underlying cause is fixed. A success clears
 * it from both failure maps, so the loop takes it back over from the next tick.
 *
 * Works while the orders kill switch is on: the switch stops the SCHEDULE, and an
 * operator who disabled the drain to stop a runaway still needs to fix the order that
 * caused it.
 *
 * Answers 200 with the outcome either way. A failed repair is expected - the cause may
 * not be fixed yet - and the operator needs the message, not a status code.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { checkout_form_id?: unknown };
  const checkoutFormId =
    typeof body.checkout_form_id === "string" ? body.checkout_form_id.trim() : "";
  if (!checkoutFormId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "`checkout_form_id` is required.");
  }

  const result = await repairAllegroOrder(req.scope, checkoutFormId);
  res.json(result);
}
