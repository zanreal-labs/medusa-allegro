import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { asDiscountBase, DISCOUNT_BASES } from "../../../../../../lib/promotions/preview";
import { setPromotionDiscountBase } from "../../../../../../workflows/lib/promotion-resolve";

/**
 * POST /admin/allegro/promotions/:id/config
 *
 * Set (or clear) the `discount_base` for a promotion - which per-offer mechanism
 * the overlay would use. This is the ONE write this feature makes, and it is a
 * Medusa-only write: it upserts `allegro_promotion_config` and its link to the
 * promotion, and touches NOTHING on Allegro. No offer is repriced, no rule is
 * created; setting a base only records intent and changes what the preview
 * emphasises. Arming (`enabled`) is a separate, still-held step.
 *
 * The body is `{ discount_base: "srp" | "competitor" | null }`. Any other value is
 * rejected rather than silently coerced, because a bad base would quietly pick the
 * wrong mechanism the day the overlay is armed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const id = req.params.id;
  const body = req.body as { discount_base?: unknown; enabled?: unknown } | undefined;
  const raw = body?.discount_base;
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : undefined;

  let discountBase: "srp" | "competitor" | null;
  if (raw === null || raw === undefined) {
    discountBase = null;
  } else {
    const parsed = asDiscountBase(raw);
    if (!parsed) {
      res
        .status(400)
        .json({ message: `discount_base must be one of ${DISCOUNT_BASES.join(", ")}, or null.` });
      return;
    }
    discountBase = parsed;
  }

  const result = await setPromotionDiscountBase(req.scope, id, discountBase, enabled);
  // Still no Allegro write on this request. Arming only records intent; the overlay
  // acts on the next price-sync tick, and only when its own global toggle is armed
  // too.
  res.json({ ...result, readOnlyToAllegro: true });
}
