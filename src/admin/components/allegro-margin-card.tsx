import type { AdminProductVariant } from "@medusajs/framework/types";
import { Container, Heading, Table, Text, toast } from "@medusajs/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMarginLabel, formatMoney, formatPercentCompact } from "../lib/format";
import { sdk } from "../lib/sdk";
import type { OffersResponse } from "../lib/types";
import { classifyVariantMargin, isMarginGap } from "../lib/variant-margin";
import type { VariantMargin } from "../lib/variant-margin";

/**
 * What each variant earns on Allegro right now, on both detail pages.
 *
 * The owner could see this figure in the Catalog list and then lose it the
 * moment he opened the product - and lose it again on the variant ("jak wejdę w
 * wariant to już nie widzę tych informacji, są tylko w produkcie"). So the same
 * component mounts on `product.details.after` with every variant of the product
 * and on `product_variant.details.after` with just the one, and the numbers
 * cannot drift between the two pages because there is only one of them.
 *
 * ## Why this is a separate card from the offers widget
 *
 * `product-allegro-offers.tsx` answers "is this product on Allegro and is the
 * mapping healthy" - offer ids, statuses, drift, the sync opt-out, push
 * history. This answers "what does it earn". Folding a money table into that
 * one would bury the figure the owner actually asked for underneath the
 * plumbing, and the two are read at different moments.
 *
 * ## Why it lives here and not in the costs plugin
 *
 * Both numbers it needs are this plugin's alone: the commission comes from
 * `allegro_category_rate` selected by the offer's three-state `promoted` flag,
 * and the anchor price is `allegro_offer.price_amount`. This plugin already
 * resolves `@zanreal/medusa-product-costs` at runtime as a soft dependency, so
 * the arithmetic is delegated there and the reverse edge - a costs plugin that
 * imports Allegro - would be a cycle and would make that plugin uninstallable
 * for a store that does not sell here.
 */

/** Matches the product-costs card's own limit; a product with more is not a real case. */
const VARIANT_FETCH_LIMIT = 200;

interface MarginRow {
  variantId: string;
  variantTitle: string;
  sku: string;
  margin: VariantMargin;
}

export interface AllegroMarginCardProps {
  /** The product whose variants are shown. */
  productId: string;
  /** When set, only this variant is shown - the variant detail page. */
  variantId?: string;
}

export const AllegroMarginCard = ({ productId, variantId }: AllegroMarginCardProps) => {
  const { i18n, t } = useTranslation();
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      // The product page never hands a widget its variants (the dashboard
      // fetches the variant table separately), and the variant page hands over
      // one without its siblings, so both go through the same list call.
      const response = await sdk.admin.product.listVariants(productId, {
        fields: "id,title,sku",
        limit: VARIANT_FETCH_LIMIT,
      });
      const all = response.variants ?? [];
      const variants = variantId
        ? all.filter((variant: AdminProductVariant) => variant.id === variantId)
        : all;

      const skus = [
        ...new Set(
          variants.map((variant) => variant.sku).filter((sku): sku is string => Boolean(sku)),
        ),
      ];

      // `economics=1` is the whole point of this fetch: without it the offers
      // come back with no cost, commission or margin attached at all.
      const offersResponse =
        skus.length > 0
          ? await sdk.client.fetch<OffersResponse>("/admin/allegro/offers", {
              query: { economics: 1, limit: skus.length, skus },
            })
          : { offers: [] };

      if (cancelled) {
        return;
      }

      const bySku = new Map((offersResponse.offers ?? []).map((offer) => [offer.sku, offer]));
      setRows(
        variants.map((variant) => ({
          margin: classifyVariantMargin(variant.sku ? (bySku.get(variant.sku) ?? null) : null),
          sku: variant.sku ?? "",
          variantId: variant.id,
          variantTitle: variant.title ?? variant.sku ?? variant.id,
        })),
      );
      setLoading(false);
    }

    load().catch((error: unknown) => {
      if (!cancelled) {
        setLoading(false);
        toast.error(
          error instanceof Error ? error.message : t("marginCard.loadError"),
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [productId, variantId]);

  /** The amber label naming which input is missing, or a quiet dash when unmapped. */
  const gapLabel = (margin: VariantMargin): string => {
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
        return t("variantColumns.notListed");
      }
    }
  };

  const gapCell = (margin: VariantMargin) => (
    <Text
      className={isMarginGap(margin) ? "text-ui-tag-orange-text" : "text-ui-fg-muted"}
      size="xsmall"
    >
      {gapLabel(margin)}
    </Text>
  );

  // Every product page would otherwise carry an empty card; a product with no
  // variants has nothing to earn.
  if (!loading && rows.length === 0) {
    return null;
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t("marginCard.heading")}</Heading>
      </div>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("marginCard.columns.variant")}</Table.HeaderCell>
            <Table.HeaderCell>{t("marginCard.columns.sku")}</Table.HeaderCell>
            <Table.HeaderCell>{t("marginCard.columns.price")}</Table.HeaderCell>
            <Table.HeaderCell>{t("marginCard.columns.commission")}</Table.HeaderCell>
            <Table.HeaderCell>{t("marginCard.columns.margin")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {loading ? (
            <Table.Row>
              <Table.Cell>
                <Text size="small">{t("common.loading")}</Text>
              </Table.Cell>
              <Table.Cell />
              <Table.Cell />
              <Table.Cell />
              <Table.Cell />
            </Table.Row>
          ) : (
            rows.map((row) => {
              const { margin } = row;
              return (
                <Table.Row key={row.variantId}>
                  <Table.Cell>{row.variantTitle}</Table.Cell>
                  <Table.Cell>
                    {row.sku || (
                      <Text className="text-ui-fg-muted" size="small">
                        {t("marginCard.noSku")}
                      </Text>
                    )}
                  </Table.Cell>
                  {margin.state === "resolved" ? (
                    <>
                      <Table.Cell>
                        <Text className="tabular-nums" size="small">
                          {formatMoney(margin.sellingPrice, margin.currency, i18n.language)}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text className="tabular-nums" size="small">
                          {margin.commissionAmount === undefined
                            ? formatPercentCompact(margin.commissionRate, i18n.language)
                            : `${formatMoney(margin.commissionAmount, margin.currency, i18n.language)} (${formatPercentCompact(margin.commissionRate, i18n.language)})`}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text
                          className={`tabular-nums${margin.amount < 0 ? " text-ui-fg-error" : ""}`}
                          size="small"
                        >
                          {formatMarginLabel(
                            margin.amount,
                            margin.pct,
                            margin.currency,
                            i18n.language,
                          )}
                        </Text>
                      </Table.Cell>
                    </>
                  ) : (
                    <>
                      <Table.Cell>{gapCell(margin)}</Table.Cell>
                      <Table.Cell />
                      <Table.Cell />
                    </>
                  )}
                </Table.Row>
              );
            })
          )}
        </Table.Body>
      </Table>
    </Container>
  );
};
