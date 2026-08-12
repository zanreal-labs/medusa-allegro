import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../modules/allegro";
import type AllegroModuleService from "../../../modules/allegro/service";

/**
 * GET /admin/allegro
 *
 * Everything the settings page needs in one round trip: the connection status, the
 * per-provider sync health, the runtime toggles, and the sync configuration. No secret
 * material is returned - the token envelopes never leave the service, and
 * `getPublicOptions` is the narrowed shape rather than the resolved options.
 *
 * The toggles are returned as a set rather than one flag, because "price sync is off"
 * reads as "nothing is written" and that is wrong while another writer is armed. Each
 * carries its persisted arming, whether the environment forces it off, and the
 * effective state - so the page renders an honest switch that says "forced off by
 * environment" instead of lying about an armed writer the environment is holding down.
 *
 * `write_scope_missing` on any state row is the one condition the page raises as a
 * persistent banner: it means the stored token cannot write offers at all, no retry
 * fixes it, and the only remedy is a reconnect with the right scope.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  const [connection, syncState, options, toggles] = await Promise.all([
    allegro.getConnectionStatus(),
    allegro.listAllegroSyncStates({}, { order: { provider: "ASC" } }),
    allegro.getPublicOptions(),
    allegro.getRuntimeToggleStates(),
  ]);

  res.json({
    connection,
    options,
    sync_state: syncState,
    toggles,
  });
}
