import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { registerProductColumn } from "@zanreal/medusa-admin-kit";
import type { ProductColumnProduct } from "@zanreal/medusa-admin-kit";
import { StatusBadge, Text } from "@medusajs/ui";
import { formatOfferStatus, summarizeOfferStatus } from "../lib/offer-status";
import type { OfferStatusSummary } from "../lib/offer-status";
import { sdk } from "../lib/sdk";
import type { OffersResponse } from "../lib/types";

/**
 * Registers the per-product Allegro offer-status column in the shared,
 * extensible products list (`@zanreal/medusa-admin-kit`'s Catalog route).
 *
 * This call must live at the top level of this file - not in the component
 * body, not in an effect - because the admin build statically imports every
 * widget into `virtual:medusa/widgets`, which the dashboard evaluates once at
 * boot. `registerProductColumn` runs then, strictly before anyone can
 * navigate to Catalog, so the column is always present by the time that
 * route's table reads the registry. See the admin-kit README's "contributor
 * contract" for the full explanation of why this is not optional.
 *
 * The lookup is a network call keyed by the row's SKUs, so it goes through
 * `loadData` rather than `cell`: the Catalog table renders immediately with
 * this column showing its loading state, then re-renders once the offers
 * response for that row's SKUs resolves. A product with no SKUs never hits
 * the network at all.
 */
registerProductColumn<ProductColumnProduct, OfferStatusSummary>({
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
    const summary = async.data;
    if (!summary || summary.total === 0) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          -
        </Text>
      );
    }
    return (
      <StatusBadge color={summary.conflicts > 0 ? "red" : "green"}>
        {formatOfferStatus(summary)}
      </StatusBadge>
    );
  },
  header: "Allegro",
  id: "allegro.offer_status",
  loadData: async (ctx) => {
    if (ctx.skus.length === 0) {
      return { conflicts: 0, linked: 0, total: 0 };
    }
    const response = await sdk.client.fetch<OffersResponse>("/admin/allegro/offers", {
      query: { limit: ctx.skus.length, skus: ctx.skus },
    });
    return summarizeOfferStatus(response.offers);
  },
  priority: 10,
});

const RegisterAllegroProductColumnsWidget = () => null;

export const config = defineWidgetConfig({
  zone: "product.list.before",
});

export default RegisterAllegroProductColumnsWidget;
