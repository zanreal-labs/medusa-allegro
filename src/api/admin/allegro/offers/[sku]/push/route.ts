import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  MANUAL_PUSH_WINDOW_MS,
  pushSingleAllegroOffer,
} from "../../../../../../workflows/sync-allegro-prices";

/**
 * POST /admin/allegro/offers/:sku/push
 *
 * Push one offer's rule and bounds now.
 *
 * Two things this is for. It is the quarantine remedy - a successful push clears the
 * offer from both failure maps, so the loop resumes correcting it automatically - and
 * it is the override for an offer whose per-offer opt-out is set, because the operator
 * asked for this specific offer.
 *
 * `pushedBy` is the authenticated admin's actor id, recorded on the audit row. The
 * audit is append-only and it is the only bounds memory there is, so knowing which
 * pushes were a human and which were the loop is worth the column.
 *
 * Answers 200 with the outcome for every expected refusal - the kill switch is on, the claim
 * is held, the offer is ineligible, the token cannot write - because each needs its own
 * sentence on screen rather than a status code the client has to interpret.
 *
 * The ONE exception is the blast-radius cap, which answers 429. That refusal exists for
 * scripts rather than for humans: nothing stopped a loop over this route from repricing the
 * whole catalogue around `changeCap`, and a script needs a machine-readable signal to back
 * off on. `Retry-After` is set to the rolling window so a well-behaved client knows how long
 * to wait.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const sku = decodeURIComponent(req.params.sku as string);
  const actorId = req.auth_context?.actor_id ?? "admin";

  const result = await pushSingleAllegroOffer(req.scope, sku, actorId);

  if (result.status === "rate-limited") {
    res.setHeader("Retry-After", String(Math.ceil(MANUAL_PUSH_WINDOW_MS / 1000)));
    res.status(429).json(result);
    return;
  }
  res.json(result);
}
