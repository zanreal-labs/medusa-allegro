import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { StatusBadge, Text } from "@medusajs/ui";
import { registerVariantColumn } from "@zanreal/medusa-admin-kit";
import type { CatalogProduct } from "@zanreal/medusa-admin-kit";
import i18next from "i18next";
import { formatMarginLabel } from "../lib/format";
import { createOfferBatcher } from "../lib/offer-batch";
import type { OfferFetcher } from "../lib/offer-batch";
import { sdk } from "../lib/sdk";
import type { OffersResponse } from "../lib/types";
import { classifyVariantMargin, isMarginGap } from "../lib/variant-margin";
import type { VariantMargin } from "../lib/variant-margin";
import {
  classifyVariantOffer,
  formatVariantOffer,
  isLiveOfferPrice,
  resolveVariantOfferPrice,
  variantOfferColor,
} from "../lib/variant-offer";
import type { VariantOffer, VariantOfferPrice } from "../lib/variant-offer";

/**
 * Registers this plugin's per-variant columns in the shared, extensible
 * catalogue list (`@zanreal/medusa-admin-kit`'s Catalog route).
 *
 * These calls must live at the top level of this file - not in the component
 * body, not in an effect - because the admin build statically imports every
 * widget into `virtual:medusa/widgets`, which the dashboard evaluates once at
 * boot. `registerVariantColumn` runs then, strictly before anyone can navigate
 * to Catalog, so the columns are always present by the time that route's table
 * reads the registry. See the admin-kit README's "contributor contract" for the
 * full explanation of why this is not optional.
 *
 * ## Three columns, not one
 *
 * The price is a **separate** column from the offer status rather than a second
 * line inside it. The status column renders a badge whose text is a state name;
 * a number inside a coloured badge reads as a label, not as money. More
 * practically, the point of showing the Allegro price is comparing it against
 * the shop price and the SRP that the kit renders two columns to the left, and
 * that comparison only works if this is a figure in a right-aligned money
 * column lined up with those - which it cannot be while it is a sub-line of a
 * status cell. Priority 9 puts it immediately before the status column, so the
 * three prices sit together and the badge that qualifies this one sits right
 * after it.
 *
 * ## The margin column
 *
 * Priority 11 puts it immediately after the status badge, so the row reads
 * price -> state -> what that price actually earns. It is the answer to "nie
 * widac marzy od zakupu z uwzglednieniem prowizji allegro": measured on the
 * live auction price, with the Allegro commission for this offer's category
 * and promotion state already taken out, and never on the SRP.
 *
 * Every unresolvable figure names its missing input in amber rather than going
 * blank - except an unmapped SKU, which stays quiet, because listing here is
 * done by hand and most of the catalogue is legitimately not on Allegro.
 *
 * ## One request per page, not one per cell
 *
 * All three columns need the same offer row, and `loadData` runs per row. Left
 * alone, that is `3 x pageSize` requests for one page. All of them go through
 * `offerBatcher` instead, which coalesces every SKU asked for within a tick
 * into a single `/admin/allegro/offers?skus=...` call. See `lib/offer-batch.ts`.
 */

/**
 * Ask the offers route for an exact SKU set.
 *
 * `limit` is set to the size of that set: the route defaults to 50 and would
 * otherwise truncate a full page's worth of SKUs, and a truncated response is
 * indistinguishable from "these SKUs have no offers" - every dropped row would
 * render as a calm, wrong "not listed".
 */
const fetchOffersBySkus: OfferFetcher = async (skus) => {
  const response = await sdk.client.fetch<OffersResponse>("/admin/allegro/offers", {
    // `economics=1` is what makes the margin column possible without a second
    // request: the same offer row now carries the purchase cost, the commission
    // and the resulting margin. All three columns still share this one call.
    query: { economics: 1, limit: skus.length, skus },
  });
  return response.offers ?? [];
};

/** One batcher for both columns, so they share a request rather than race. */
const offerBatcher = createOfferBatcher(fetchOffersBySkus);

/**
 * `header` and `cell` below run outside any component's render - they are
 * plain callbacks the Catalog table invokes, not components themselves - so
 * they cannot call the `useTranslation` hook. They read the shared `i18next`
 * instance the dashboard already initialized instead. See the i18n README's
 * "component rendering" note.
 */
const t = (key: string) => i18next.t(key, { ns: "allegro" });

/** The amber label naming which input a margin is missing, or a quiet dash when unmapped. */
const marginGapLabel = (margin: VariantMargin): string => {
  switch (margin.state) {
    case "no-price": {
      return t("variantColumns.marginNoPrice");
    }
    case "no-cost": {
      return t("variantColumns.marginNoCost");
    }
    case "no-commission": {
      return t("variantColumns.marginNoCommission");
    }
    default: {
      // Not listed on Allegro. Normal here - listing is manual - so it reads as
      // quietly as the price column's own empty cell.
      return "-";
    }
  }
};

/** A SKU-less variant cannot be matched to an offer; skip the network entirely. */
const loadOfferRow = async (sku: string | null) => (sku ? offerBatcher.load(sku) : null);

registerVariantColumn<CatalogProduct, VariantOfferPrice | null>({
  cell: (_ctx, async) => {
    if (!async || async.isLoading) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          {t("variantColumns.loadingCell")}
        </Text>
      );
    }
    if (async.error) {
      return (
        <Text className="text-ui-fg-error" size="small">
          {t("variantColumns.priceError")}
        </Text>
      );
    }
    const price = async.data;
    if (!price) {
      // Not listed on Allegro, or listed with no price observed yet. Neither is
      // a fault: most of this catalogue is not on Allegro at all, so this has
      // to be as quiet as an empty cell while still being a definite "no
      // price" rather than a zero.
      return (
        <span className="flex w-full justify-end">
          <Text className="text-ui-fg-muted" size="small">
            -
          </Text>
        </span>
      );
    }
    const live = isLiveOfferPrice(price);
    return (
      <span className="flex w-full items-baseline justify-end gap-x-1 tabular-nums">
        <Text className={live ? undefined : "text-ui-fg-muted"} size="small">
          {price.amount.toFixed(2)}
        </Text>
        {price.currency ? (
          <Text className="text-ui-fg-muted" size="xsmall">
            {price.currency}
          </Text>
        ) : null}
      </span>
    );
  },
  header: () => t("variantColumns.priceColumnHeader"),
  id: "allegro.price",
  loadData: async (ctx) => resolveVariantOfferPrice(await loadOfferRow(ctx.sku)),
  priority: 9,
});

/**
 * The offer-status column. The cell names what is wrong with this one SKU: it
 * used to read "3 offers / 1 conflict" because a row was a product and a
 * product spans many SKUs; a row is now one variant with at most one offer, so
 * the column can say which state that offer is in.
 */
registerVariantColumn<CatalogProduct, VariantOffer | null>({
  cell: (_ctx, async) => {
    if (!async || async.isLoading) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          {t("variantColumns.loadingCell")}
        </Text>
      );
    }
    if (async.error) {
      return <StatusBadge color="red">{t("variantColumns.statusError")}</StatusBadge>;
    }
    const offer = async.data;
    if (!offer) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          {t("variantColumns.notListed")}
        </Text>
      );
    }
    return <StatusBadge color={variantOfferColor(offer)}>{formatVariantOffer(offer)}</StatusBadge>;
  },
  header: () => t("variantColumns.statusColumnHeader"),
  id: "allegro.offer_status",
  loadData: async (ctx) => classifyVariantOffer(await loadOfferRow(ctx.sku)),
  priority: 10,
});

registerVariantColumn<CatalogProduct, VariantMargin>({
  cell: (_ctx, async) => {
    if (!async || async.isLoading) {
      return (
        <Text className="text-ui-fg-muted" size="small">
          {t("variantColumns.loadingCell")}
        </Text>
      );
    }
    if (async.error) {
      return (
        <Text className="text-ui-fg-error" size="small">
          {t("variantColumns.marginError")}
        </Text>
      );
    }
    const margin = async.data ?? { state: "no-offer" as const };
    if (margin.state !== "resolved") {
      return (
        <span className="flex w-full justify-end">
          <Text
            className={isMarginGap(margin) ? "text-ui-tag-orange-text" : "text-ui-fg-muted"}
            size={isMarginGap(margin) ? "xsmall" : "small"}
          >
            {marginGapLabel(margin)}
          </Text>
        </span>
      );
    }
    return (
      <span className="flex w-full justify-end tabular-nums">
        <Text className={margin.amount < 0 ? "text-ui-fg-error" : undefined} size="small">
          {formatMarginLabel(margin.amount, margin.pct, margin.currency, i18next.language)}
        </Text>
      </span>
    );
  },
  header: () => t("variantColumns.marginColumnHeader"),
  id: "allegro.margin",
  loadData: async (ctx) => classifyVariantMargin(await loadOfferRow(ctx.sku)),
  priority: 11,
});

const RegisterAllegroVariantColumnsWidget = () => null;

export const config = defineWidgetConfig({
  zone: "product.list.before",
});

export default RegisterAllegroVariantColumnsWidget;
