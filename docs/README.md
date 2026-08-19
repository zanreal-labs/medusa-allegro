# docs/

The published documentation for `@zanreal/medusa-allegro`.

These pages are the source of what renders at
<https://zanreal.com/docs/oss/medusa-allegro>. The marketing site clones this
repository at build time and copies this directory into its own content tree, so
a change merged here is what the site ships on its next deploy. Nothing is
maintained by hand on the other side.

## Layout

| File | Purpose |
| --- | --- |
| `index.en.mdx`, `index.pl.mdx` | Overview: what the plugin is, the SKU contract, what runs when, and how a host installs it. |
| `connecting.en.mdx`, `connecting.pl.mdx` | Registering the Allegro app, the encryption key, and what protects the OAuth callback. |
| `mapping.en.mdx`, `mapping.pl.mdx` | The sygnatura contract, the five mapping conflicts, and the stock loop's refusal rules. |
| `pricing.en.mdx`, `pricing.pl.mdx` | The three pricing modes, the floor and the ceiling, the skip ladder, and the safety machinery. |
| `orders.en.mdx`, `orders.pl.mdx` | The event journal drain, the derived status ladder, fulfillment write-back, and the invoice chain. |
| `configuration.en.mdx`, `configuration.pl.mdx` | Every option and environment variable, the runtime toggles, and the precedence rules. |
| `meta.json`, `meta.pl.json` | Sidebar title, description and page order, per locale. |

This `README.md` is deliberately **not** copied by the sync. It explains the
directory to someone browsing GitHub; it is not a page on the site.

## Conventions

- **Every page exists in both locales**, suffixed `.en.mdx` and `.pl.mdx`.
- **Each locale is written from the code, not translated from the other.** The
  two versions make the same argument and are expected to differ in examples and
  emphasis. A calque is a defect.
- **Cross-links between pages are relative** and point at the file, for example
  `[Pricing](./pricing.en.mdx)`. That resolves when browsing this directory on
  GitHub, and the site's sync rewrites it to a site route on the way in. The
  locale is taken from the link target, so `./pricing.pl.mdx` lands on the Polish
  page.
- **No em or en dashes.** Use a spaced hyphen for a parenthetical.
- **Plain MDX only.** No custom components - the sync copies these files into a
  content tree whose component scope this repository does not control.
- **Do not describe an option without reading its implementation.** The README and
  `src/lib/options.ts` are the source of truth for defaults and precedence.
