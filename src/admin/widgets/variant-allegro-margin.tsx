import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { AdminProductVariant, DetailWidgetProps } from "@medusajs/framework/types";
import { AllegroMarginCard } from "../components/allegro-margin-card";

/**
 * The same card on the variant page, scoped to that one variant.
 *
 * This is the half the owner was missing: the margin was visible while looking
 * at the product and gone the moment he opened the variant he actually wanted
 * to price.
 */
const VariantAllegroMarginWidget = ({ data }: DetailWidgetProps<AdminProductVariant>) => {
  // A variant always belongs to a product, but the field is optional in the
  // admin types and the card cannot resolve anything without it.
  if (!data.product_id) {
    return null;
  }
  return <AllegroMarginCard productId={data.product_id} variantId={data.id} />;
};

export const config = defineWidgetConfig({
  zone: "product_variant.details.after",
});

export default VariantAllegroMarginWidget;
