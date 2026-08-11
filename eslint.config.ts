import medusa from "@medusajs/eslint-plugin";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...medusa.configs.recommended,
  {
    // `src/lib/**` is framework-agnostic on purpose.
    //
    // `src/lib/allegro` is a standalone Allegro REST client with no Medusa
    // imports at all, so it stays portable and testable outside a Medusa
    // process. `crypto.ts` and `options.ts` sit in the same layer and only throw
    // at construction or boot time, before any HTTP request exists to map a
    // status onto. `MedusaError` would be both a wrong dependency and a wrong
    // shape here, so the rule that insists on it is off for this directory.
    files: ["src/lib/**/*.ts"],
    rules: {
      "@medusajs/use-medusa-error-not-generic-error": "off",
    },
  },
]);
