import type { LoaderOptions } from "@medusajs/framework/types";
import { resolveAllegroOptions } from '../../../lib/options';
import type { AllegroPluginOptions } from '../../../lib/options';

/**
 * Fail fast on a misconfigured plugin.
 *
 * Loaders run once at application startup, before any request is served, which
 * is the only place a configuration error can be reported to the person who can
 * fix it. Left to the service constructor, the same error would surface on the
 * first Allegro call - in the middle of a merchant's workflow, wrapped in an
 * unrelated stack trace.
 */
export default async function validateAllegroOptions({
  options,
  logger,
}: LoaderOptions<AllegroPluginOptions>): Promise<void> {
  const resolved = resolveAllegroOptions(options);

  logger?.info(
    `[medusa-allegro] configured for ${resolved.environment}, callback ${resolved.redirectPath}, price sync ${
      resolved.priceSyncDisabled ? "DISABLED" : "enabled"
    }`,
  );
}
