import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * POST /admin/allegro/disconnect
 *
 * Revokes the tokens at Allegro, then deletes the stored connection.
 *
 * Revocation is best-effort and the local delete happens regardless. If Allegro
 * is unreachable, or the token is already dead, refusing to disconnect would
 * leave the operator staring at a connection they explicitly asked to remove
 * with no way to remove it. The refresh token is revoked first, since that is
 * the credential that matters: an access token expires on its own within hours.
 *
 * The stored rows are the only copy of the tokens, so this is not recoverable -
 * reconnecting means walking the consent screen again.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    warn: (message: string) => void;
  };

  const token = await allegro.loadToken().catch(() => {});

  if (token) {
    const oauth = await allegro.getOAuth();
    const revocations: Promise<unknown>[] = [];
    if (token.refreshToken) {
      revocations.push(oauth.revoke(token.refreshToken, "refresh_token"));
    }
    revocations.push(oauth.revoke(token.accessToken, "access_token"));

    const results = await Promise.allSettled(revocations);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn(
          `[medusa-allegro] token revocation at Allegro failed, deleting the local connection anyway - ${String(result.reason)}`,
        );
      }
    }
  }

  await allegro.deleteConnection();

  res.json({ connection: await allegro.getConnectionStatus() });
}
