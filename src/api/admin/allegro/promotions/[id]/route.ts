import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { resolvePromotionPreview } from "../../../../../workflows/lib/promotion-resolve";

/**
 * GET /admin/allegro/promotions/:id
 *
 * The per-SKU preview for one promotion: for every targeted SKU that resolves to
 * an eligible Allegro offer, what BOTH mechanisms would do - the rule switch a
 * competitor-base discount would make (and its "does nothing when we are already
 * cheapest" caveat), and the clamped Buy Now price an SRP-base override would set
 * (and the rule it would re-attach on expiry). Plus the SKUs held out by the
 * eligibility ladder, and a coverage roll-up.
 *
 * Read-only, like the list route: it resolves offers, costs and SRP and writes
 * nothing. Showing both mechanisms rather than one is deliberate - the operator
 * has not chosen a `discount_base` yet (that is the arming step, held), so the
 * preview shows the effect of each choice rather than presupposing one.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const id = req.params.id;
  const preview = await resolvePromotionPreview(req.scope, id);
  if (!preview) {
    res.status(404).json({ message: `No promotion found with id ${id}.` });
    return;
  }
  res.json({ preview, readOnly: true });
}
