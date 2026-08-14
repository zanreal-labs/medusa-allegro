/**
 * The sync-configuration precedence, in one pure function, plus the metadata that
 * ties each editable field to its persisted column and its environment lock.
 *
 * Sibling of `runtime-toggles.ts`, same shape and same reason: deliberately
 * framework-free and dependency-free, no Medusa imports, no model, no
 * `process.env` read. The service wires the persisted row, the env readers and the
 * `medusa-config.ts` defaults into `resolveEffectiveConfigValue`, and the pure
 * function is what makes the precedence trivially unit-testable.
 *
 * These fields were shipped as `medusa-config.ts` constructor options only - read
 * back through `getPublicOptions()` and rendered in the admin as inert text. An
 * operator could not change a rule name, the change cap, the SRP source or the
 * sales-channel scope without editing the config file and redeploying. This module
 * is what makes them editable-and-persisted, mirroring the runtime toggles: a
 * value entered in the admin takes effect on the next call to `getSyncOptions()`,
 * no redeploy.
 */

import { PRICING_MODES } from "./pricing-mode";

/**
 * The effective value of one configuration field.
 *
 *   effectiveValue = envOverride ?? persistedValue ?? configDefault
 *
 * The environment override is a HARD lock, mirroring the runtime toggles' "the
 * override can only force off" contract - except here there is no "off" for a
 * string or a number, so the override simply wins outright whenever it is set.
 * That is deliberate: `marketplaceId` and `salesChannelId` re-scope which offers
 * this plugin matches against which Medusa catalogue, and an operator responding
 * to a wiring incident needs a way to pin the correct value that an admin mistake
 * cannot override, exactly like `ALLEGRO_PRICE_SYNC_DISABLED` cannot be re-armed
 * from the admin.
 *
 * Below the override, the persisted (admin-entered) value governs when it is set,
 * and the `medusa-config.ts` default is the fallback of last resort - the same
 * value this plugin used before any of these fields were persisted, so a fresh
 * install or an unedited field behaves exactly as it always did.
 *
 * `null` and `undefined` are both read as "not set" for `persistedValue`, since a
 * cleared admin field and a column that has never been written are the same fact.
 */
export const resolveEffectiveConfigValue = <T>(
  envOverride: T | null | undefined,
  persistedValue: T | null | undefined,
  configDefault: T | null | undefined,
): T | null => {
  if (envOverride !== null && envOverride !== undefined) {
    return envOverride;
  }
  if (persistedValue !== null && persistedValue !== undefined) {
    return persistedValue;
  }
  return configDefault ?? null;
};

/** The stable key for each governed configuration field. */
export type ConfigFieldKey =
  | "pricingMode"
  | "automationRuleStandard"
  | "automationRulePromoted"
  | "srpMetadataKey"
  | "srpPriceListId"
  | "changeCap"
  | "marketplaceId"
  | "salesChannelId"
  | "salesChannelName";

/** The persisted column on `allegro_settings` backing each field. */
export type ConfigFieldColumn =
  | "pricing_mode"
  | "automation_rule_standard"
  | "automation_rule_promoted"
  | "srp_metadata_key"
  | "srp_price_list_id"
  | "change_cap"
  | "marketplace_id"
  | "sales_channel_id"
  | "sales_channel_name";

export interface ConfigFieldMeta {
  key: ConfigFieldKey;
  /** The persisted column on `allegro_settings`. */
  column: ConfigFieldColumn;
  /** The environment variable that hard-locks this field at runtime. */
  envVar: string;
  /** What an operator is editing, named after what it does. */
  label: string;
  /** One line of what the field controls. */
  description: string;
  /**
   * Which control the admin renders: a text box, a number box, or a picker.
   *
   * A `choice` field is genuinely different from the other two rather than a text
   * box with a hint: the set of valid values is closed, so the admin offers
   * exactly those and the write route rejects anything else. It also has no
   * "blank" state - there is always a mode in force - which is why the picker
   * carries no empty option.
   */
  kind: "text" | "number" | "choice";
  /**
   * The closed set of values, for a `choice` field. Absent for the others.
   *
   * Each option carries the sentence the admin shows under the picker, because
   * "what does this mode actually write?" is the question the setting exists to
   * answer and a bare label does not answer it.
   */
  choices?: readonly { value: string; label: string; description: string }[];
  /**
   * True when a wrong value silently breaks the Allegro<->Medusa mapping rather
   * than merely mis-tuning a run. The admin renders an explicit re-scoping
   * warning next to these fields rather than treating them like any other text
   * box.
   */
  wiringCritical: boolean;
}

/**
 * Every editable configuration field, in the order the admin lists them.
 *
 * The single source of truth for "which fields exist and what backs them". The
 * service maps each to its persisted column, its env lock and the
 * `medusa-config.ts` default; the admin renders one input per entry.
 */
export const CONFIG_FIELDS: readonly ConfigFieldMeta[] = [
  {
    choices: PRICING_MODES,
    column: "pricing_mode",
    description:
      "How this store prices its Allegro offers. Everything else in this section only matters to the modes that use it. Leave it alone and the plugin keeps offers on your Allegro automation rules, which is what it has always done.",
    envVar: "ALLEGRO_PRICING_MODE",
    key: "pricingMode",
    kind: "choice",
    label: "Pricing mode",
    wiringCritical: false,
  },
  {
    column: "automation_rule_standard",
    description:
      "Name of the price-automation rule attached to a standard (non-promoted) offer. Must already exist on the Allegro account.",
    envVar: "ALLEGRO_AUTOMATION_RULE_STANDARD",
    key: "automationRuleStandard",
    kind: "text",
    label: "Automation rule (standard)",
    wiringCritical: false,
  },
  {
    column: "automation_rule_promoted",
    description:
      "Name of the price-automation rule attached to a promoted offer. Must already exist on the Allegro account, and must differ from the standard rule.",
    envVar: "ALLEGRO_AUTOMATION_RULE_PROMOTED",
    key: "automationRulePromoted",
    kind: "text",
    label: "Automation rule (promoted)",
    wiringCritical: false,
  },
  {
    column: "srp_metadata_key",
    description:
      "Variant (or product) metadata key holding the SRP ceiling. Mutually exclusive with the SRP price list.",
    envVar: "ALLEGRO_SRP_METADATA_KEY",
    key: "srpMetadataKey",
    kind: "text",
    label: "SRP source: metadata key",
    wiringCritical: false,
  },
  {
    column: "srp_price_list_id",
    description:
      "Price list id whose price is read as the SRP ceiling. Mutually exclusive with the SRP metadata key.",
    envVar: "ALLEGRO_SRP_PRICE_LIST_ID",
    key: "srpPriceListId",
    kind: "text",
    label: "SRP source: price list id",
    wiringCritical: false,
  },
  {
    column: "change_cap",
    description: "Commands issued per price-sync run, a blast-radius limit on a bad run.",
    envVar: "ALLEGRO_CHANGE_CAP",
    key: "changeCap",
    kind: "number",
    label: "Change cap",
    wiringCritical: false,
  },
  {
    column: "marketplace_id",
    description: "Marketplace the price-automation rule assignment targets.",
    envVar: "ALLEGRO_MARKETPLACE_ID",
    key: "marketplaceId",
    kind: "text",
    label: "Marketplace id",
    wiringCritical: true,
  },
  {
    column: "sales_channel_id",
    description:
      "Sales channel id that scopes which Medusa products are matched against Allegro offers. Exact match; takes precedence over the channel name.",
    envVar: "ALLEGRO_SALES_CHANNEL_ID",
    key: "salesChannelId",
    kind: "text",
    label: "Sales channel id",
    wiringCritical: true,
  },
  {
    column: "sales_channel_name",
    description:
      "Sales channel name that scopes eligible products when no channel id is set. Resolved by name at run time.",
    envVar: "ALLEGRO_SALES_CHANNEL_NAME",
    key: "salesChannelName",
    kind: "text",
    label: "Sales channel name",
    wiringCritical: false,
  },
] as const;
