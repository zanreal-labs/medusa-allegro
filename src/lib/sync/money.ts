/**
 * Money helpers shared by the sync engines.
 *
 * Allegro's API speaks decimal strings ("233.21"), and every amount this plugin
 * stores or sends is text for that reason. These helpers are the two boundaries:
 * `parseAmount` on the way in, `formatAmount` on the way out. Nothing else in
 * the sync code should be doing arithmetic on an Allegro string.
 *
 * The BigNumber-unwrapping half of `parseAmount` (recognising a Medusa
 * `BigNumber` instance, a bare `{ value, precision }` shape, or a detached
 * instance that lost its prototype) lives in `./big-number`, shared
 * byte-for-byte with medusa-infakt and medusa-marken - see that file's header
 * for the vendoring contract. This module keeps only what is genuinely
 * Allegro-specific: strict scalar validation and the two rounding rules.
 */
import { type BigNumberInput, bigNumberCandidates } from "./big-number";

/**
 * Round to 2 decimals.
 *
 * `Number.EPSILON` biases the binary representation away from tie-to-even, so
 * 1.005 rounds to 1.01 rather than 1.00. Without it a price floor lands a grosz
 * below the true break-even, which is the unsafe direction.
 */
export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Everything `parseAmount` accepts - re-exported from the shared unwrapper. */
export type AmountInput = BigNumberInput;

/**
 * Parse a scalar amount, strictly.
 *
 * Validated BEFORE parsing. `Number.parseFloat` stops at the first character it cannot use
 * and returns what it already has, so `"12abc"` parsed as 12, `"1 234,56"` as 1, and `"12."`
 * as 12. Each of those is a silently WRONG number in a money field rather than a refusal,
 * and downstream a partial parse is indistinguishable from a good one - which is the exact
 * failure mode this module exists to prevent.
 */
const parseScalar = (value: string | number): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const trimmed = value.trim();
  if (!/^[+-]?\d+(\.\d+)?$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Read a big-number object, trying each candidate the shared unwrapper finds
 * (in its order of authority - `raw.value` before the derived `numeric`,
 * public accessors before the private `raw_`/`numeric_` fallback, `toString`
 * last) through the SAME strict scalar check, so a non-money object whose
 * `toString` yields "[object Object]" still parses as undefined rather than
 * being coerced into a number nobody meant, and a value whose first
 * candidate fails validation still gets a chance from the next one.
 */
const parseBigNumberLike = (value: BigNumberInput): number | undefined => {
  for (const candidate of bigNumberCandidates(value)) {
    const parsed = parseScalar(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
};

/**
 * Parse an Allegro decimal string - or a Medusa big number - into a number, or
 * undefined when it is absent or not finite.
 *
 * Fail-soft on purpose: a malformed amount must become "unknown", never 0. A
 * zero cost or a zero price silently passes every downstream check that a
 * missing one correctly fails.
 *
 * Objects are accepted because Medusa hands monetary columns back as `BigNumber`
 * instances. Assuming a scalar here threw `value.trim is not a function` INSIDE the
 * caller's try/catch, which turned a perfectly readable total into "could not read
 * this order" - see `readMedusaOrder`.
 */
export const parseAmount = (value?: AmountInput): number | undefined => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "number" || typeof value === "string") {
    return parseScalar(value);
  }
  return parseBigNumberLike(value);
};

/** Render an amount the way Allegro expects it in a command body. */
export const formatAmount = (value: number): string => value.toFixed(2);

/**
 * The whole-PLN floor an automation rule's price range needs.
 *
 * Rounded to grosze first, then ceiled: ceiling the raw float directly turns a
 * break-even that is mathematically 45.00 but binary-represented as
 * 45.000000000000004 into 46, a full zloty above the true floor.
 */
export const roundAutomationFloor = (value: number): number => Math.ceil(round2(value));
