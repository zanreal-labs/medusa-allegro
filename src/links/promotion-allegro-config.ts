import PromotionModule from "@medusajs/medusa/promotion";
import { defineLink } from "@medusajs/framework/utils";
import AllegroModule from "../modules/allegro";

/**
 * Links a native Medusa promotion to its Allegro execution config.
 *
 * This is what makes `allegro_promotion_config` an EXTENSION of the promotion
 * rather than a sibling table: the config carries no `promotion_id`, and the
 * association lives in the link's own pivot, so both modules stay isolated. The
 * admin widget on the promotion page reads and upserts the config by traversing
 * this link from the promotion it is rendered on.
 *
 * The consuming app materialises the pivot with `medusa db:migrate` after the
 * plugin is added; there is no migration to hand-write for a link.
 */
export default defineLink(
  PromotionModule.linkable.promotion,
  AllegroModule.linkable.allegroPromotionConfig,
);
