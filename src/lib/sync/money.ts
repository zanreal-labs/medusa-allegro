/**
 * Money helpers shared by the sync engines.
 *
 * Allegro's API speaks decimal strings ("233.21"), and every amount this plugin
 * stores or sends is text for that reason. These helpers are the two boundaries:
 * `parseAmount` on the way in, `formatAmount` on the way out. Nothing else in
 * the sync code should be doing arithmetic on an Allegro string.
 */

/**
 * Round to 2 decimals.
 *
 * `Number.EPSILON` biases the binary representation away from tie-to-even, so
 * 1.005 rounds to 1.01 rather than 1.00. Without it a price floor lands a grosz
 * below the true break-even, which is the unsafe direction.
 */
export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * A money value that arrived as an object rather than a scalar.
 *
 * Medusa stores every monetary column as a big number and hands it back as a
 * `BigNumber` INSTANCE, not as a string or a number - `order.total` read through
 * `query.graph` is an object carrying `numeric`, `raw` (`{ value: "206.00" }`) and
 * the `valueOf` / `toString` coercions. A serialized copy of the same value is the
 * bare raw shape, `{ value, precision }`. Both are money this parser has to accept;
 * treating either as "unparseable" reports a real total as unknown.
 */
export interface BigNumberLike {
  /** `BigNumber.numeric` - the value as a JS number. */
  numeric?: unknown;
  /** `BigNumber.raw` - the authoritative decimal, as `{ value: "206.00" }`. */
  raw?: { value?: unknown } | null;
  /** The raw shape passed directly, which is how a serialized big number arrives. */
  value?: unknown;
  valueOf?: () => unknown;
  toString?: () => string;
}

/** Everything `parseAmount` accepts. */
export type AmountInput = string | number | BigNumberLike | null | undefined;

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

/** Only the shapes `parseScalar` can judge; anything else is not an amount. */
const asScalar = (value: unknown): string | number | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

/**
 * Read a big-number object, in order of authority.
 *
 * `raw.value` first: it is the stored decimal string, exact by construction, whereas
 * `numeric` is a JS float derived from it. Then the two coercions, which cover a
 * `bignumber.js` instance (no `numeric`, no `raw`) and anything else that renders itself as
 * a decimal. Every candidate goes through the SAME strict scalar check, so a non-money
 * object whose `toString` yields "[object Object]" still parses as undefined rather than
 * being coerced into a number nobody meant.
 */
const parseBigNumberLike = (value: BigNumberLike): number | undefined => {
  const candidates: unknown[] = [
    value.raw?.value,
    value.value,
    value.numeric,
    typeof value.valueOf === "function" ? value.valueOf() : undefined,
    typeof value.toString === "function" ? value.toString() : undefined,
  ];
  for (const candidate of candidates) {
    // `candidate === value` guards the default `valueOf`, which returns the object itself.
    if (candidate === undefined || candidate === null || candidate === value) {
      continue;
    }
    const scalar = asScalar(candidate);
    if (scalar === undefined) {
      continue;
    }
    const parsed = parseScalar(scalar);
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
