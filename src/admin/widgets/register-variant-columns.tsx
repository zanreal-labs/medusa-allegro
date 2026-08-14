import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { StatusBadge, Text } from "@medusajs/ui";
import { registerVariantColumn } from "@zanreal/medusa-admin-kit";
import type { CatalogProduct } from "@zanreal/medusa-admin-kit";
import { formatVariantOffer, resolveVariantOffer, variantOfferColor } from "../lib/variant-offer";
import type { VariantOffer } from "../lib/variant-offer";
import { sdk } from "../lib/sdk";
import type { OffersResponse } from "../lib/types";

/**
 * Registers the per-variant Allegro offer-status column in the shared,
 * extensible catalogue list (`@zanreal/medusa-admin-kit`'s Catalog route).
 *
 * This call must live at the top level of this file - not in the component
 * body, not in an effect - because the admin build statically imports every
 * widget into `virtual:medusa/widgets`, which the dashboard evaluates once at
 * boot. `registerVariantColumn` runs then, strictly before anyone can
 * navigate to Catalog, so the column is always present by the time that
 * route's table reads the registry. See the admin-kit README's "contributor
 * contract" for the full explanation of why this is not optional.
 *
 * The lookup is a network call keyed by the row's SKU, so it goes through
 * `loadData` rather than `cell`: the Catalog table renders immediately with
 * this column showing its loading state, then re-renders once that SKU's offer
 * resolves. A variant with no SKU never hits the network at all.
 *
 * The cell names what is wrong with this one SKU. It used to read
 * "3 offers / 1 conflict" because a row was a product and a product spans many
 * SKUs; a row is now one variant with at most one offer, so the column can say
 * which state that offer is in.
 */
registerVariantColumn<CatalogProduct, VariantOffer | null>({
  cell: (_ctx, async) => {
    if (!async || async.isLoading) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          ...
        </Text>
      );
    }
    if (async.error) {
      return <StatusBadge color="red">error</StatusBadge>;
    }
    const offer = async.data;
    if (!offer) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          not listed
        </Text>
      );
    }
    return <StatusBadge color={variantOfferColor(offer)}>{formatVariantOffer(offer)}</StatusBadge>;
  },
  header: "Allegro",
  id: "allegro.offer_status",
  loadData: async (ctx) => {
    if (!ctx.sku) {
      return null;
    }
    const response = await sdk.client.fetch<OffersResponse>("/admin/allegro/offers", {
      query: { limit: 1, skus: ctx.sku },
    });
    return resolveVariantOffer(response.offers, ctx.sku);
  },
  priority: 10,
});

const RegisterAllegroVariantColumnsWidget = () => null;

export const config = defineWidgetConfig({
  zone: "product.list.before",
});

export default RegisterAllegroVariantColumnsWidget;
