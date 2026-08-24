import fixtures from "../big-number.fixtures.json";
import { bigNumberCandidates } from "../big-number";

/**
 * Runs the shared cross-repo test-vector table against this repo's copy of
 * `bigNumberCandidates`. The SAME `big-number.fixtures.json` file (byte-for-
 * byte) is exercised from medusa-infakt and medusa-marken via vitest - see
 * the header comment in `big-number.ts` for the vendoring contract.
 */
describe("bigNumberCandidates (shared fixtures)", () => {
  for (const testCase of fixtures.cases) {
    it(testCase.name, () => {
      expect(bigNumberCandidates(testCase.input as never)).toEqual(testCase.candidates);
    });
  }
});
