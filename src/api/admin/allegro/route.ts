import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../modules/allegro";
import type AllegroModuleService from "../../../modules/allegro/service";

/**
 * GET /admin/allegro
 *
 * Everything the settings page needs in one round trip: the connection status
 * and the per-provider sync health. No secret material is returned - the token
 * envelopes never leave the service.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const [connection, syncState] = await Promise.all([
    allegro.getConnectionStatus(),
    allegro.listAllegroSyncStates({}, { order: { provider: "ASC" } }),
  ]);

  res.json({ connection, sync_state: syncState });
}
