import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * GET /admin/allegro/summary
 *
 * A cheap roll-up of the offer mapping table: how many SKUs are linked to a
 * live offer, how many are drifting, and how many carry an unresolved
 * conflict. It backs the compact status widget shown while browsing products,
 * where a full offer list would be noise - the counts are enough to answer
 * "is anything wrong with my Allegro catalogue right now?" and each links into
 * the Allegro offers route filtered to the rows that need attention.
 *
 * Counts only, never rows: this is polled from the product list, so it stays a
 * handful of `count` queries rather than paging the whole catalogue.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const [[, total], [, linked], [, drifting], [, conflicts]] = await Promise.all([
    allegro.listAndCountAllegroOffers({}, { take: 1 }),
    // `offer_id` is null until discovery matches the SKU to a live offer, so a
    // non-null offer_id is the definition of "linked".
    allegro.listAndCountAllegroOffers({ offer_id: { $ne: null } }, { take: 1 }),
    allegro.listAndCountAllegroOffers({ price_automation_drift: true }, { take: 1 }),
    allegro.listAndCountAllegroOffers({ conflict: { $ne: null } }, { take: 1 }),
  ]);

  res.json({
    summary: {
      conflicts,
      drifting,
      linked,
      total,
      unlinked: Math.max(0, total - linked),
    },
  });
}
