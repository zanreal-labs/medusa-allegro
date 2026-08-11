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
 * Parse an Allegro decimal string into a number, or undefined when it is absent
 * or not finite.
 *
 * Fail-soft on purpose: a malformed amount must become "unknown", never 0. A
 * zero cost or a zero price silently passes every downstream check that a
 * missing one correctly fails.
 */
export const parseAmount = (value?: string | number | null): number | undefined => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
