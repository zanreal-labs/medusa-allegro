/**
 * CANONICAL ORIGIN: zanreal-labs/medusa-allegro @ src/lib/sync/big-number.ts
 *
 * This file is vendored byte-for-byte into three repos:
 *
 *   - zanreal-labs/medusa-allegro  @ src/lib/sync/big-number.ts       (canonical)
 *   - zanreal-labs/medusa-infakt   @ src/lib/invoicing/big-number.ts  (vendored copy)
 *   - zanreal-labs/medusa-marken   @ src/lib/big-number.ts            (vendored copy)
 *
 * All three plugins independently shipped the same bug: a Medusa `BigNumber`
 * INSTANCE reaching code that assumed a scalar `string | number` (allegro#9,
 * infakt#5, marken#2). This file is the one place that knows how to find the
 * decimal representation inside whatever shape `query.graph` (or a workflow
 * round trip) hands back for a money or quantity column.
 *
 * It deliberately does ONE job and stops: turning `AmountInput` into an
 * ordered list of raw scalar candidates. It does NOT validate the candidates'
 * format (rejecting "12abc", say) and does NOT decide null-vs-zero or
 * rounding policy - those differ between the three plugins on purpose (see
 * each repo's own money/quantity module) and must stay local.
 *
 * There is no published `@zanreal/medusa-money` package backing this file.
 * Three consumers on two different test runners (jest in medusa-allegro,
 * vitest in the other two) do not justify a fourth repo, a publish pipeline,
 * and a version-bump step on every release of all three plugins for ~80
 * lines of pure, stable logic. Instead: this file plus
 * `big-number.fixtures.json` are vendored identically, and any change here
 * must be ported to the other two copies together with the fixture.
 *
 * To change this file: edit the canonical copy in medusa-allegro first, copy
 * both files verbatim to the other two paths above, and re-run all three
 * repos' test suites.
 */

/**
 * A money (or quantity) value that arrived as an object rather than a scalar.
 *
 * Medusa stores every `BigNumberValue` column as a big number and hands it
 * back as a `BigNumber` INSTANCE, not as a string or a number - `order.total`
 * read through `query.graph` is an object carrying `numeric`, `raw` (`{
 * value: "206.00" }`) and the `valueOf` / `toString` coercions. A serialized
 * copy of the same value is the bare raw shape, `{ value, precision }`. An
 * instance that lost its prototype crossing a serialization boundary (a
 * spread, a `structuredClone`, a workflow step result) keeps only its private
 * `raw_` / `numeric_` fields. All of these are money; treating any of them as
 * "unparseable" reports a real total as unknown.
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

/** Everything `bigNumberCandidates` accepts. */
export type BigNumberInput = string | number | BigNumberLike | null | undefined;

/**
 * Is this a real, usable scalar candidate?
 *
 * Filters three kinds of noise that fall out of reading properties on an
 * arbitrary object rather than a genuine amount:
 *
 *   - the default `Object.prototype.valueOf`, which returns the object
 *     itself (`candidate === self`) - not a coercion, just "not this one";
 *   - the default `Object.prototype.toString`, which yields the literal
 *     string `"[object Object]"` for any plain object with no custom
 *     `toString`;
 *   - `Array.prototype.toString` on an empty array (or any all-whitespace
 *     string), which yields `""`.
 *
 * None of the three plugins' own numeric parsers would ever accept these as
 * a valid decimal, so filtering them here keeps the candidate list itself
 * meaningful ("this object had nothing readable") rather than pushing the
 * same rejection into every caller.
 */
function isUsableScalar(candidate: unknown, self: unknown): candidate is string | number {
  if (candidate === undefined || candidate === null || candidate === self) {
    return false;
  }
  if (typeof candidate === "number") {
    return true;
  }
  if (typeof candidate === "string") {
    if (candidate === "[object Object]") {
      return false;
    }
    return candidate.trim() !== "";
  }
  return false;
}

/**
 * Reduce anything Medusa might hand back for a money or quantity column to
 * an ORDERED list of raw scalar candidates - `string | number` - ready for
 * the caller's own numeric parsing and validation. Returns an empty array
 * when nothing readable was found.
 *
 * Read in order of authority, all of them collected (not just the first
 * hit), so a caller that needs to retry past an invalid earlier candidate
 * can:
 *
 *   1. `raw.value`   - the public getter's stored decimal string, exact by
 *                       construction, whereas `numeric` is a float derived
 *                       from it.
 *   2. `value`        - the bare `{ value, precision }` shape a serialized
 *                       big number arrives as.
 *   3. `numeric`      - the public getter's derived float.
 *   4. `valueOf()`    - the class's own coercion contract; covers a
 *                       `bignumber.js`-style instance that exposes neither
 *                       `numeric` nor `raw`.
 *   5. `raw_.value` / `numeric_` - an instance that lost its prototype
 *                       crossing a serialization boundary keeps only these
 *                       private fields; the trailing underscore is not a
 *                       contract, so this is consulted only after every
 *                       public accessor has been tried.
 *   6. `toString()`   - last resort, for an object with a custom string
 *                       coercion and none of the above.
 *
 * This function does not gate on "does this look like a BigNumber" before
 * trying `valueOf()` / `toString()` - a caller that must reject an arbitrary
 * object with a numeric `valueOf()` (a `Date`, for instance) applies that
 * check itself before calling in, or filters after the fact. See the
 * cross-repo comparison in the shared-money-util PRs for why that gate is
 * NOT identical across the three plugins.
 */
export function bigNumberCandidates(value: BigNumberInput): Array<string | number> {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object") {
    return [];
  }

  const obj = value as BigNumberLike & {
    raw_?: { value?: unknown } | null;
    numeric_?: unknown;
  };

  const ordered: unknown[] = [
    obj.raw && typeof obj.raw === "object" ? obj.raw.value : undefined,
    obj.value,
    obj.numeric,
    typeof obj.valueOf === "function" ? obj.valueOf() : undefined,
    obj.raw_ && typeof obj.raw_ === "object" ? obj.raw_.value : undefined,
    obj.numeric_,
    typeof obj.toString === "function" ? obj.toString() : undefined,
  ];

  const candidates: Array<string | number> = [];
  for (const candidate of ordered) {
    if (isUsableScalar(candidate, value)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}
