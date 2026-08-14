import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { CONFIG_FIELDS } from "../../../../lib/config-fields";
import type { ConfigFieldColumn, ConfigFieldMeta } from "../../../../lib/config-fields";
import { RUNTIME_TOGGLES } from "../../../../lib/runtime-toggles";
import type { RuntimeToggleColumn } from "../../../../lib/runtime-toggles";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type { AllegroSettingsPatch } from "../../../../modules/allegro/service";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * The persisted settings singleton - the runtime toggles AND the editable
 * sync-configuration fields (automation rule names, SRP source, change cap,
 * marketplace id, sales-channel scope).
 *
 * The two families share this route because they share the same storage and the
 * same admin page: a write here is an operator changing how the plugin behaves
 * WITHOUT a redeploy, whether that is arming a writer or renaming the standard
 * price-automation rule. A writer flipped, or a field edited, takes effect on the
 * next tick/call, because every runtime path resolves its effective state from
 * this row rather than from a value captured at boot.
 *
 * The environment override is NOT writable here on purpose, for either family: it
 * can only pin a value (or force a toggle off), and it lives in the deployment's
 * environment, not in a row an operator edits - so the response reports it back
 * (`forceDisabled` / `locked`) and the UI disables the control rather than
 * pretending a write could clear it.
 */

/** The toggle columns an admin may arm or disarm, mapped for a fast membership test. */
const WRITABLE_TOGGLE_COLUMNS = new Set<RuntimeToggleColumn>(
  RUNTIME_TOGGLES.map((toggle) => toggle.column),
);

/** The configuration columns an admin may edit, keyed for validation and lookup. */
const CONFIG_FIELDS_BY_COLUMN = new Map<ConfigFieldColumn, ConfigFieldMeta>(
  CONFIG_FIELDS.map((field) => [field.column, field]),
);

/**
 * GET /admin/allegro/settings
 *
 * Every toggle's persisted, forced and effective state, and every configuration
 * field's persisted, locked, defaulted and effective state.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const [toggles, configFields] = await Promise.all([
    allegro.getRuntimeToggleStates(),
    allegro.getConfigFieldStates(),
  ]);
  res.json({ configFields, toggles });
}

/**
 * A configuration value as the request body supplied it, validated for its
 * column's kind.
 *
 * `null` (or an empty/whitespace-only string) clears the field back to its
 * `medusa-config.ts` fallback - the same "clear" contract the category-rate route
 * already uses, and the reason a blank admin input is not an error: it is how an
 * operator un-sets a field they previously edited.
 *
 * A number-kind field rejects anything that is not a positive integer, the same
 * rule `resolveChangeCap` enforces on the `medusa-config.ts` default at boot: a
 * cap of 0 or less is not "no writes" - the writer toggles exist for that - it is
 * a config value with no sane meaning.
 */
const parseConfigValue = (value: unknown, field: ConfigFieldMeta): string | number | null => {
  if (value === null) {
    return null;
  }
  // A closed set, checked against the field's own choices rather than against a
  // list repeated here: the picker and the validator must never disagree about
  // which values exist, and the only way to guarantee that is for both to read
  // `CONFIG_FIELDS`.
  if (field.kind === "choice") {
    const allowed = (field.choices ?? []).map((choice) => choice.value);
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`${field.column}\` must be one of ${allowed.join(", ")}, or null to fall back to the configured default (got ${typeof value === "string" ? `"${value}"` : typeof value}).`,
      );
    }
    return value;
  }
  if (field.kind === "number") {
    if (typeof value !== "number") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`${field.column}\` must be a number or null (got ${typeof value}).`,
      );
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`${field.column}\` must be a positive integer or null (got ${value}). To stop price writes entirely, use a writer toggle instead of a cap of zero.`,
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field.column}\` must be a string or null (got ${typeof value}).`,
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * POST /admin/allegro/settings
 *
 * `{ price_sync_enabled?, stock_sync_enabled?, orders_sync_enabled?,
 *    fulfillment_writeback_enabled?, invoice_attach_enabled?, automation_rule_standard?,
 *    automation_rule_promoted?, srp_metadata_key?, srp_price_list_id?, change_cap?,
 *    marketplace_id?, sales_channel_id?, sales_channel_name? }`.
 *
 * Only the keys present are written, so arming one writer - or editing one
 * configuration field - never disturbs another. Unknown keys and wrongly-typed
 * values are rejected rather than silently ignored, so a typo cannot read as a
 * successful write. `updateSettings` additionally rejects a configuration write
 * that would newly collide the two automation rule names, or newly set both SRP
 * sources - see the service for that check.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (WRITABLE_TOGGLE_COLUMNS.has(key as RuntimeToggleColumn)) {
      if (typeof value !== "boolean") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `\`${key}\` must be a boolean (got ${typeof value}).`,
        );
      }
      patch[key] = value;
      continue;
    }

    const field = CONFIG_FIELDS_BY_COLUMN.get(key as ConfigFieldColumn);
    if (!field) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown setting \`${key}\`. Writable toggles: ${[...WRITABLE_TOGGLE_COLUMNS].join(", ")}. Writable configuration fields: ${[...CONFIG_FIELDS_BY_COLUMN.keys()].join(", ")}.`,
      );
    }
    patch[key] = parseConfigValue(value, field);
  }

  if (Object.keys(patch).length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Provide at least one setting to update. Writable toggles: ${[...WRITABLE_TOGGLE_COLUMNS].join(", ")}. Writable configuration fields: ${[...CONFIG_FIELDS_BY_COLUMN.keys()].join(", ")}.`,
    );
  }

  await allegro.updateSettings(patch as AllegroSettingsPatch);
  const [toggles, configFields] = await Promise.all([
    allegro.getRuntimeToggleStates(),
    allegro.getConfigFieldStates(),
  ]);
  res.json({ configFields, toggles });
}
