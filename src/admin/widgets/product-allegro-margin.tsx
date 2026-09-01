import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { AdminProduct, DetailWidgetProps } from "@medusajs/framework/types";
import { AllegroMarginCard } from "../components/allegro-margin-card";

/**
 * What this product's variants earn on Allegro, on the product page.
 *
 * All of the behaviour lives in {@link AllegroMarginCard}, which the variant
 * page mounts too; this only says which product to show.
 */
const ProductAllegroMarginWidget = ({ data }: DetailWidgetProps<AdminProduct>) => (
  <AllegroMarginCard productId={data.id} />
);

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductAllegroMarginWidget;
