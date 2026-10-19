import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import en from "../json/en.json";
import pl from "../json/pl.json";

/**
 * Every string under `src/admin` lives in the `allegro` namespace (see
 * `../index.ts`). A `useTranslation()` with no namespace reads the dashboard's
 * default `translation` namespace instead, finds nothing, and react-i18next
 * renders the key itself - which is how the product page ended up showing
 * `marginCard.heading` and `marginCard.columns.*` with both locales complete.
 * Nothing fails at build or type-check time, so this spec is the guard.
 */

const ADMIN_ROOT = join(__dirname, "..", "..");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });

const files = sourceFiles(ADMIN_ROOT).map((path) => ({
  path: relative(ADMIN_ROOT, path),
  source: readFileSync(path, "utf8"),
}));

const lookup = (dict: unknown, key: string): unknown => {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
};

/** A plural key (`t("x", { count })`) resolves through `x_other`, which every locale must have. */
const hasKey = (dict: unknown, key: string): boolean =>
  typeof lookup(dict, key) === "string" || typeof lookup(dict, `${key}_other`) === "string";

/** Literal keys only: `t("a.b")`. Template keys are built from data and checked by hand. */
const literalKeys = (source: string): string[] =>
  [...source.matchAll(/\bt\(\s*["']([A-Za-z0-9_.-]+)["']/g)].map((match) => match[1]);

describe("admin translations", () => {
  it("reads the allegro namespace in every useTranslation call", () => {
    const offenders = files.flatMap(({ path, source }) =>
      [...source.matchAll(/useTranslation\(([^)]*)\)/g)]
        .filter((match) => match[1].trim() !== '"allegro"')
        .map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("has every literal t() key in both locales", () => {
    const missing = files.flatMap(({ path, source }) =>
      literalKeys(source).flatMap((key) =>
        [
          hasKey(en, key) ? null : `${path}: ${key} (en)`,
          hasKey(pl, key) ? null : `${path}: ${key} (pl)`,
        ].filter((entry): entry is string => entry !== null),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the margin card keys the product page renders", () => {
    for (const key of [
      "marginCard.heading",
      "marginCard.columns.variant",
      "marginCard.columns.sku",
      "marginCard.columns.price",
      "marginCard.columns.commission",
      "marginCard.columns.margin",
    ]) {
      expect(hasKey(en, key)).toBe(true);
      expect(hasKey(pl, key)).toBe(true);
    }
  });
});
