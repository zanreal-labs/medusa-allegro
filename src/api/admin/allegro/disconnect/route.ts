import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * Told to the operator whenever this route could not revoke at Allegro.
 *
 * The local rows are the only copy of the tokens and they are gone by the time
 * the response is written, so the plugin cannot retry. The developer panel is
 * the only remaining route, and the operator has to be told that rather than
 * left assuming a live refresh token was killed.
 */
const MANUAL_REVOCATION_HINT =
  "The local connection was deleted, but the tokens could not be revoked at Allegro. Revoke this application's access by hand in the Allegro developer panel (My applications), or the refresh token stays valid until it expires.";

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
 * reconnecting means walking the consent screen again. That is also why every
 * path that skips revocation says so in the response rather than returning a
 * clean success: afterwards there is nothing left to revoke WITH.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    warn: (message: string) => void;
  };

  let revocationFailed = false;

  // A failure here is almost always an `encryptionKey` that no longer opens the
  // stored envelope. Swallowing it silently skipped remote revocation without
  // saying so anywhere, and left the operator believing a long-lived refresh
  // token had been killed when it had not.
  const token = await allegro.loadToken().catch((error: unknown) => {
    revocationFailed = true;
    logger.warn(
      `[medusa-allegro] the stored tokens could not be read, so nothing was revoked at Allegro - ${String(error)}`,
    );
    return;
  });

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
        revocationFailed = true;
        logger.warn(
          `[medusa-allegro] token revocation at Allegro failed, deleting the local connection anyway - ${String(result.reason)}`,
        );
      }
    }
  }

  await allegro.deleteConnection();

  res.json({
    connection: await allegro.getConnectionStatus(),
    ...(revocationFailed ? { warning: MANUAL_REVOCATION_HINT } : {}),
  });
}
