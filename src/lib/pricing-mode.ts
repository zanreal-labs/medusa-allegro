/**
 * How this store prices its Allegro offers: the one setting that decides what the
 * price loop is allowed to write.
 *
 * Deliberately framework-free and dependency-free, the same shape as
 * `runtime-toggles.ts` and `config-fields.ts`: no Medusa imports, no model, no
 * `process.env` read. The service resolves the persisted value, the environment
 * lock and the `medusa-config.ts` default through the shared configuration
 * precedence; everything here is pure so the mode's meaning is unit-testable.
 *
 * Three modes, named from the operator's point of view rather than after the
 * Allegro resource each one happens to call:
 *
 * - `monitor` computes the break-even floor and the SRP ceiling for every linked
 *   offer, records what it would change, and sends nothing to Allegro.
 * - `automation_rule` keeps each offer on one of the two named Allegro
 *   price-automation rules, promoted or standard, with the floor and ceiling as
 *   the rule's price range. Allegro's engine picks the number inside that range.
 * - `fixed_price` pushes the Medusa variant's own price to the offer, refusing
 *   any price outside the same floor and ceiling.
 *
 * The floor and the ceiling apply in every mode. They are the whole safety story
 * of this plugin, and a mode that skipped them would be a mode that can sell at a
 * loss.
 */

/** The pricing strategies an operator can choose between. */
export type PricingMode = "monitor" | "automation_rule" | "fixed_price";

/**
 * The mode an install gets when nothing is configured anywhere.
 *
 * `automation_rule`, not `monitor`, because that is what this plugin did before
 * the mode existed: an upgrade must not silently stop a store's price writes. A
 * fresh install writes nothing regardless, since every writer toggle ships
 * disarmed.
 */
export const DEFAULT_PRICING_MODE: PricingMode = "automation_rule";

/** One selectable mode, as the admin renders it. */
export interface PricingModeMeta {
  value: PricingMode;
  /** What an operator is choosing, in their words. */
  label: string;
  /** Exactly what this mode writes to Allegro, in one sentence. */
  description: string;
}

/**
 * Every mode, in the order the admin lists them: least invasive first.
 *
 * The single source of truth for "which modes exist and what each one writes".
 * The admin renders one option per entry and the settings route validates a
 * submitted value against it, so an unknown mode can never be persisted.
 */
export const PRICING_MODES: readonly PricingModeMeta[] = [
  {
    description:
      "Writes nothing to Allegro. Works out the break-even floor and the SRP ceiling for every linked offer and records what it would change, so you can see the numbers before you let anything act on them.",
    label: "Monitor only",
    value: "monitor",
  },
  {
    description:
      "Keeps every offer on one of your two Allegro price-automation rules (a promoted offer gets the promoted rule) and sets that rule's price range to the break-even floor and the SRP ceiling. Allegro's own engine then picks the price inside that range.",
    label: "Allegro automation rule",
    value: "automation_rule",
  },
  {
    description:
      "Sets each offer's Buy Now price to the price the variant already has in Medusa. A price below the break-even floor or above the SRP ceiling is refused rather than pushed. An offer still carrying an automation rule has the rule removed first, otherwise Allegro's engine would overwrite the price straight away.",
    label: "Fixed price from Medusa",
    value: "fixed_price",
  },
] as const;

/** Every valid mode value, for a fast membership test. */
export const PRICING_MODE_VALUES: readonly PricingMode[] = PRICING_MODES.map((mode) => mode.value);

/** Whether an arbitrary value is one of the known modes. */
export const isPricingMode = (value: unknown): value is PricingMode =>
  typeof value === "string" && PRICING_MODE_VALUES.includes(value as PricingMode);

/**
 * Read a stored, configured or environment-supplied value as a mode.
 *
 * An unrecognised value falls back to the default rather than throwing. This is
 * evaluated on every `getSyncOptions()` call, and a typo in an environment
 * variable must not turn every price-sync run into a thrown error - the same
 * reasoning `changeCapEnvOverride` already applies to a malformed cap. The
 * settings route and the boot-time option check both reject an unknown mode
 * loudly at the point it is entered, which is where an operator can act on it.
 */
export const coercePricingMode = (value: unknown): PricingMode =>
  isPricingMode(value) ? value : DEFAULT_PRICING_MODE;

/** Whether a mode sends anything to Allegro at all. */
export const modeWrites = (mode: PricingMode): boolean => mode !== "monitor";

/**
 * Whether a mode needs the two named automation rules to be configured.
 *
 * Only `automation_rule` does. `fixed_price` removes a rule rather than
 * attaching one, and removal is per marketplace and needs no rule name; `monitor`
 * writes nothing at all. Gating the rule-name requirement on this is what stops a
 * fixed-price store being told to configure two rules it will never use.
 */
export const modeNeedsAutomationRules = (mode: PricingMode): boolean =>
  mode === "automation_rule";
