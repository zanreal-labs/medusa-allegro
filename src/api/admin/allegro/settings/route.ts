import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { RUNTIME_TOGGLES } from "../../../../lib/runtime-toggles";
import type { RuntimeToggleColumn } from "../../../../lib/runtime-toggles";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type { AllegroSettingsPatch } from "../../../../modules/allegro/service";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * The persisted runtime toggles - the live, redeploy-free arming of each writer.
 *
 * A writer flipped here takes effect on the next tick, because every runtime path
 * resolves its effective state from this row rather than from a value captured at
 * boot. The environment override is NOT writable here on purpose: it can only force a
 * writer off, and it lives in the deployment's environment, not in a row an operator
 * edits - so the response reports it back (`forceDisabled`) and the UI locks the switch
 * rather than pretending a write could clear it.
 */

/** The columns an admin may write, mapped for a fast membership test. */
const WRITABLE_COLUMNS = new Set<RuntimeToggleColumn>(
  RUNTIME_TOGGLES.map((toggle) => toggle.column),
);

/** GET /admin/allegro/settings - every toggle's persisted, forced and effective state. */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  res.json({ toggles: await allegro.getRuntimeToggleStates() });
}

/**
 * POST /admin/allegro/settings
 *
 * `{ price_sync_enabled?, stock_sync_enabled?, orders_sync_enabled?,
 *    fulfillment_writeback_enabled?, invoice_attach_enabled? }`. Only the keys present
 * are written, so arming one writer never disturbs another.
 *
 * A write to a writer the environment force-disables is accepted and stored - the
 * operator is recording intent for when the override is lifted - and the returned
 * `toggles` still show it held off, never a lie. Unknown keys and non-boolean values
 * are rejected rather than silently ignored, so a typo cannot read as a successful arm.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const patch: AllegroSettingsPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!WRITABLE_COLUMNS.has(key as RuntimeToggleColumn)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown toggle \`${key}\`. Writable toggles: ${[...WRITABLE_COLUMNS].join(", ")}.`,
      );
    }
    if (typeof value !== "boolean") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`${key}\` must be a boolean (got ${typeof value}).`,
      );
    }
    patch[key as RuntimeToggleColumn] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Provide at least one toggle to update: ${[...WRITABLE_COLUMNS].join(", ")}.`,
    );
  }

  await allegro.updateSettings(patch);
  res.json({ toggles: await allegro.getRuntimeToggleStates() });
}
