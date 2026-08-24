import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * DRIFT GUARD.
 *
 * `big-number.ts` and `big-number.fixtures.json` are vendored byte-for-byte
 * into three repos - see the header comment in `big-number.ts` for the full
 * vendoring contract:
 *
 *   - zanreal-labs/medusa-allegro  @ src/lib/sync/big-number.ts + big-number.fixtures.json       (canonical, this repo)
 *   - zanreal-labs/medusa-infakt   @ src/lib/invoicing/big-number.ts + big-number.fixtures.json
 *   - zanreal-labs/medusa-marken   @ src/lib/big-number.ts + big-number.fixtures.json
 *
 * Vendoring by copy-paste is enforced by nothing on its own: the first person
 * who patches one repo under time pressure silently reintroduces the exact
 * three-copies-drift bug this file structure exists to prevent (allegro#9,
 * infakt#5, marken#2), and nothing goes red. THIS TEST is the mechanical
 * guard - it hashes both files on disk and fails loudly the moment either one
 * changes here without the same change landing in the other two.
 *
 * `CANONICAL_HASH` below is THE SAME VALUE in all three repos' copies of this
 * test file. To change `big-number.ts` or `big-number.fixtures.json`:
 *
 *   1. Edit the canonical copy in medusa-allegro
 *      (src/lib/sync/big-number.ts, src/lib/sync/big-number.fixtures.json).
 *   2. Copy both files verbatim to:
 *        - medusa-infakt @ src/lib/invoicing/big-number.ts (+ .fixtures.json)
 *        - medusa-marken @ src/lib/big-number.ts (+ .fixtures.json)
 *   3. Recompute the hash (run this test - a mismatch prints the recomputed
 *      value) and paste it into `CANONICAL_HASH` in all three copies of this
 *      test file.
 *   4. Open all three PRs together.
 *
 * This does not make the sync automatic - nothing short of a published
 * package does that (see `big-number.ts`'s header for why that trade-off was
 * rejected here). It makes an unsynced edit fail in the repo where it
 * happened, with a message pointing at the other two, instead of drifting
 * silently.
 */
const CANONICAL_HASH = "17ff0e86f5ae391308d02c62111c9f1209d7eb9c374210246a449c9653fa7334";

/** CRLF-normalised first so a checkout's `core.autocrlf` cannot flip the hash. */
const normalize = (content: string): string => content.replace(/\r\n/g, "\n");

const hashVendoredFiles = (paths: string[]): string => {
  const hash = createHash("sha256");
  for (const filePath of paths) {
    hash.update(normalize(readFileSync(filePath, "utf8")));
  }
  return hash.digest("hex");
};

describe("big-number.ts / big-number.fixtures.json vendoring", () => {
  it("matches the hash recorded in medusa-infakt and medusa-marken", () => {
    const actual = hashVendoredFiles([
      path.join(__dirname, "..", "big-number.ts"),
      path.join(__dirname, "..", "big-number.fixtures.json"),
    ]);

    if (actual !== CANONICAL_HASH) {
      throw new Error(
        "big-number.ts and/or big-number.fixtures.json changed in medusa-allegro without the vendoring sync procedure.\n\n" +
          `  recomputed hash: ${actual}\n` +
          `  recorded hash:   ${CANONICAL_HASH}\n\n` +
          "Sync procedure:\n" +
          "  1. Edit the canonical copy in medusa-allegro (src/lib/sync/big-number.ts, src/lib/sync/big-number.fixtures.json).\n" +
          "  2. Copy both files verbatim to:\n" +
          "       - medusa-infakt @ src/lib/invoicing/big-number.ts (+ .fixtures.json)\n" +
          "       - medusa-marken @ src/lib/big-number.ts (+ .fixtures.json)\n" +
          `  3. Update CANONICAL_HASH to ${actual} in this test file in ALL THREE repos.\n` +
          "  4. Open all three PRs together.",
      );
    }
  });
});
