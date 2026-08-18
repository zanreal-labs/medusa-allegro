# Admin Customizations Translations

The Medusa Admin dashboard supports multiple languages for its interface. Medusa uses [react-i18next](https://react.i18next.com/) to manage translations in the admin dashboard.

To add translations, create JSON translation files for each language under the `src/admin/i18n/json` directory. For example, `src/admin/i18n/json/en.json`:

```json
{
  "settings": {
    "title": "Allegro"
  },
  "common": {
    "save": "Save"
  }
}
```

Then, export the translations in `src/admin/i18n/index.ts`:

```ts
import en from "./json/en.json" with { type: "json" };
import pl from "./json/pl.json" with { type: "json" };

export default {
  en: { allegro: en },
  pl: { allegro: pl },
};
```

Note the `allegro` key in place of the default `translation` namespace: this plugin's keys are namespaced under `allegro` so they cannot collide with another plugin's translations in the shared admin dashboard.

Finally, read the namespace with the `useTranslation` hook from any component under `src/admin`:

```tsx
import { useTranslation } from "react-i18next";

const AllegroSettingsPage = () => {
  const { t } = useTranslation("allegro");
  return <Heading level="h1">{t("settings.title")}</Heading>;
};
```

A component that renders outside a React render pass - a Catalog column's `header`, or a `cell` callback registered with `@zanreal/medusa-admin-kit`'s `registerVariantColumn` - cannot call a hook. Those read the shared `i18next` instance directly instead:

```ts
import i18next from "i18next";

header: () => i18next.t("variantColumns.priceColumnHeader", { ns: "allegro" });
```

Learn more about translating admin extensions in the [Translate Admin Customizations](https://docs.medusajs.com/learn/fundamentals/admin/translations) documentation.
