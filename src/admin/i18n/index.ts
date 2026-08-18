import en from "./json/en.json" with { type: "json" };
import pl from "./json/pl.json" with { type: "json" };

/**
 * Namespaced under `allegro`, not the default `translation` namespace, so
 * these keys cannot collide with another plugin's translations in the
 * shared admin dashboard. See `useTranslation("allegro")` in `src/admin`.
 */
export default {
  en: { allegro: en },
  pl: { allegro: pl },
};
