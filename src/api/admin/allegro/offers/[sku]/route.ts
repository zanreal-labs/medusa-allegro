import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../../modules/allegro";
import type AllegroModuleService from "../../../../../modules/allegro/service";

/**
 * GET /admin/allegro/offers/:sku
 *
 * One mapping row plus its push history, which is the drawer the admin opens. The
 * history is the only record of what price bounds were ever pushed - Allegro exposes
 * an attached rule's range nowhere - so it is worth a dedicated read rather than
 * being folded into the list response.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const sku = decodeURIComponent(req.params.sku as string);

  const [offer] = await allegro.listAllegroOffers({ sku }, { take: 1 });
  if (!offer) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `No Allegro mapping for SKU "${sku}".`);
  }

  const pushes = await allegro.listAllegroPricePushes(
    { sku },
    { order: { pushed_at: "DESC" }, take: 50 },
  );

  res.json({ offer, pushes });
}

/**
 * POST /admin/allegro/offers/:sku
 *
 * The per-offer opt-out. `{ "price_sync_enabled": false }` takes this one offer out
 * of the price loop without touching the global kill switch - for an item whose
 * pricing an operator wants to own by hand.
 *
 * Nothing else on the row is writable here. Every other column is either observed
 * from Allegro or derived, and letting an operator hand-edit an observation would
 * make the next sweep silently disagree with it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const sku = decodeURIComponent(req.params.sku as string);
  const body = (req.body ?? {}) as { price_sync_enabled?: unknown };

  if (typeof body.price_sync_enabled !== "boolean") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`price_sync_enabled` must be a boolean.",
    );
  }

  const [offer] = await allegro.listAllegroOffers({ sku }, { take: 1 });
  if (!offer) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `No Allegro mapping for SKU "${sku}".`);
  }

  await allegro.updateAllegroOffers([
    { id: (offer as { id: string }).id, price_sync_enabled: body.price_sync_enabled },
  ] as never);

  const [updated] = await allegro.listAllegroOffers({ sku }, { take: 1 });
  res.json({ offer: updated });
}
