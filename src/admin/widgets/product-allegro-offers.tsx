import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type {
  AdminProduct,
  AdminProductVariant,
  DetailWidgetProps,
} from "@medusajs/framework/types";
import {
  Alert,
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  StatusBadge,
  Switch,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CONFLICT_LABEL, formatDate, PRICE_MODE_COLOR, PUSH_RESULT_COLOR } from "../lib/format";
import { sdk } from "../lib/sdk";
import type { OfferDetailResponse, OfferRow, OffersResponse } from "../lib/types";

/**
 * A single product's Allegro state, on the product detail page.
 *
 * This is the place an operator answers "is this product on Allegro, and is it
 * healthy?" without opening the cross-catalogue offers table: per variant SKU
 * it shows the linked offer (with a link to the live listing), a short status,
 * the observed pricing mode and drift, promotion state, and the per-offer price
 * sync opt-out. The push history - the only record of the bounds ever sent - is
 * one click away in a drawer. Bulk work (rediscovery, category rates, orders)
 * stays under Settings -> Allegro.
 */

/** The public storefront page for an offer. Sandbox offers will not resolve. */
const offerUrl = (offerId: string): string => `https://allegro.pl/oferta/${offerId}`;

const promotedLabel = (promoted: boolean | null | undefined): string => {
  if (promoted === null || promoted === undefined) {
    return "unresolved";
  }
  return promoted ? "yes" : "no";
};

/**
 * A product detail page never hands a widget its variants.
 *
 * The dashboard loads the product for `product.details.*` with
 * `PRODUCT_DETAIL_FIELDS = getLinkedFields("product", "*categories,*shipping_profile,-variants")`
 * (see `@medusajs/dashboard/src/routes/products/product-detail/constants.ts`).
 * The `-variants` there is an explicit exclusion: the page fetches the variant
 * table separately with `useProductVariants`. So `data.variants` is `undefined`
 * here, this widget's SKU list was always empty, and the `skus.length === 0`
 * guard below returned `null` on every product - the widget never appeared at
 * all. It fetches its own variants now, the same way the dashboard's own
 * variant section does, and still prefers `data.variants` if a future dashboard
 * version starts passing it.
 */
const VARIANT_FETCH_LIMIT = 200;

const ProductAllegroOffersWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const [variants, setVariants] = useState<AdminProductVariant[]>(
    () => (data.variants ?? []) as AdminProductVariant[],
  );
  const skus = useMemo(
    () => [
      ...new Set(
        variants.map((variant) => variant.sku).filter((sku): sku is string => Boolean(sku)),
      ),
    ],
    [variants],
  );

  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [variantsLoading, setVariantsLoading] = useState(!data.variants);

  useEffect(() => {
    if (data.variants) {
      setVariants(data.variants as AdminProductVariant[]);
      setVariantsLoading(false);
      return;
    }

    let cancelled = false;
    setVariantsLoading(true);
    sdk.admin.product
      .listVariants(data.id, { fields: "id,title,sku", limit: VARIANT_FETCH_LIMIT })
      .then((response) => {
        if (!cancelled) {
          setVariants(response.variants ?? []);
          setVariantsLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVariantsLoading(false);
          toast.error(
            error instanceof Error ? error.message : "Could not load this product's variants.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data.id, data.variants]);
  const [busySku, setBusySku] = useState<string | undefined>();
  const [detail, setDetail] = useState<OfferDetailResponse | undefined>();

  const load = useCallback(async () => {
    if (skus.length === 0) {
      setOffers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await sdk.client.fetch<OffersResponse>("/admin/allegro/offers", {
        query: { limit: skus.length, skus },
      });
      setOffers(response.offers);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the Allegro offers.");
    } finally {
      setLoading(false);
    }
  }, [skus]);

  useEffect(() => {
    void load();
  }, [load]);

  const bySku = useMemo(() => new Map(offers.map((offer) => [offer.sku, offer])), [offers]);

  const togglePriceSync = async (offer: OfferRow) => {
    setBusySku(offer.sku);
    try {
      await sdk.client.fetch(`/admin/allegro/offers/${encodeURIComponent(offer.sku)}`, {
        body: { price_sync_enabled: !(offer.price_sync_enabled ?? true) },
        method: "POST",
      });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the opt-out.");
    } finally {
      setBusySku(undefined);
    }
  };

  const openHistory = async (sku: string) => {
    try {
      setDetail(
        await sdk.client.fetch<OfferDetailResponse>(
          `/admin/allegro/offers/${encodeURIComponent(sku)}`,
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the push history.");
    }
  };

  // No SKUs means nothing can ever map to an Allegro offer - render nothing
  // rather than an empty panel on every SKU-less product. Only once the variant
  // fetch has settled, though: bailing out before that is what kept this widget
  // off the page entirely.
  if (!variantsLoading && skus.length === 0) {
    return null;
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Allegro</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            The offer mapped to each variant SKU, its sync state, and the per-offer price sync
            opt-out.
          </Text>
        </div>
      </div>

      {loading || variantsLoading ? (
        <div className="px-6 py-4">
          <Text size="small">Loading...</Text>
        </div>
      ) : (offers.length === 0 ? (
        <div className="px-6 py-4">
          <Text className="text-ui-fg-subtle" size="small">
            Not on Allegro. No offer maps to this product's SKUs ({skus.join(", ")}). Offer
            discovery links an offer whose sygnatura (external id) equals a variant SKU.
          </Text>
        </div>
      ) : (
        <div className="overflow-x-auto px-6 py-4">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Variant / SKU</Table.HeaderCell>
                <Table.HeaderCell>Offer</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Pricing</Table.HeaderCell>
                <Table.HeaderCell>Promoted</Table.HeaderCell>
                <Table.HeaderCell>Price sync</Table.HeaderCell>
                <Table.HeaderCell>Last sync</Table.HeaderCell>
                <Table.HeaderCell> </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {variants
                .filter((variant): variant is typeof variant & { sku: string } =>
                  Boolean(variant.sku),
                )
                .map((variant) => {
                  const offer = bySku.get(variant.sku);
                  return (
                    <Table.Row key={variant.id}>
                      <Table.Cell>
                        <div className="flex flex-col">
                          <span className="txt-compact-small-plus">
                            {variant.title ?? variant.sku}
                          </span>
                          <span className="text-ui-fg-muted txt-compact-xsmall">{variant.sku}</span>
                        </div>
                      </Table.Cell>
                      {offer ? (
                        <>
                          <Table.Cell className="text-ui-fg-subtle">
                            {offer.offer_id ? (
                              <a
                                className="text-ui-fg-interactive"
                                href={offerUrl(offer.offer_id)}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {offer.offer_id}
                              </a>
                            ) : (
                              "not linked"
                            )}
                          </Table.Cell>
                          <Table.Cell>
                            {offer.conflict ? (
                              <StatusBadge color="red">
                                {CONFLICT_LABEL[offer.conflict] ?? offer.conflict}
                              </StatusBadge>
                            ) : offer.offer_id ? (
                              <StatusBadge color="green">linked</StatusBadge>
                            ) : (
                              <StatusBadge color="grey">not linked</StatusBadge>
                            )}
                            {offer.last_error ? (
                              <Text className="text-ui-fg-subtle txt-compact-xsmall">
                                {offer.last_error}
                              </Text>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-col gap-y-1">
                              <StatusBadge
                                color={PRICE_MODE_COLOR[offer.price_mode ?? "unknown"] ?? "grey"}
                              >
                                {offer.price_mode ?? "unknown"}
                              </StatusBadge>
                              {offer.automation_rule ? (
                                <span className="text-ui-fg-muted txt-compact-xsmall">
                                  {offer.automation_rule}
                                </span>
                              ) : null}
                              {offer.price_automation_drift ? (
                                <Badge color="orange" size="2xsmall">
                                  drift
                                </Badge>
                              ) : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>{promotedLabel(offer.promoted)}</Table.Cell>
                          <Table.Cell>
                            <Switch
                              checked={offer.price_sync_enabled ?? true}
                              disabled={busySku === offer.sku}
                              onCheckedChange={() => void togglePriceSync(offer)}
                            />
                          </Table.Cell>
                          <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                            <div className="flex flex-col">
                              <span>price {formatDate(offer.price_synced_at)}</span>
                              <span>stock {formatDate(offer.stock_synced_at)}</span>
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex justify-end">
                              <Button
                                onClick={() => void openHistory(offer.sku)}
                                size="small"
                                variant="transparent"
                              >
                                History
                              </Button>
                            </div>
                          </Table.Cell>
                        </>
                      ) : (
                        <>
                          <Table.Cell className="text-ui-fg-subtle">not linked</Table.Cell>
                          <Table.Cell>
                            <StatusBadge color="grey">not linked</StatusBadge>
                          </Table.Cell>
                          <Table.Cell className="text-ui-fg-muted">-</Table.Cell>
                          <Table.Cell className="text-ui-fg-muted">-</Table.Cell>
                          <Table.Cell className="text-ui-fg-muted">-</Table.Cell>
                          <Table.Cell className="text-ui-fg-muted">-</Table.Cell>
                          <Table.Cell />
                        </>
                      )}
                    </Table.Row>
                  );
                })}
            </Table.Body>
          </Table>
        </div>
      ))}

      <Drawer onOpenChange={(open) => !open && setDetail(undefined)} open={Boolean(detail)}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{detail?.offer.sku}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-col gap-y-4 overflow-y-auto">
            {detail?.offer.conflict ? (
              <Alert variant="error">
                {CONFLICT_LABEL[detail.offer.conflict] ?? detail.offer.conflict}:{" "}
                {detail.offer.conflict_detail}
              </Alert>
            ) : null}

            <div>
              <Heading className="mb-2" level="h3">
                Push history
              </Heading>
              <Text className="text-ui-fg-subtle mb-3" size="small">
                Append-only, and the only record of the price range that was pushed. `observed` rows
                are the monitor recording a state it did not write.
              </Text>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>When</Table.HeaderCell>
                    <Table.HeaderCell>Result</Table.HeaderCell>
                    <Table.HeaderCell>Rule</Table.HeaderCell>
                    <Table.HeaderCell>Bounds</Table.HeaderCell>
                    <Table.HeaderCell>By</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {(detail?.pushes ?? []).map((push) => (
                    <Table.Row key={push.id}>
                      <Table.Cell className="txt-compact-xsmall">
                        {formatDate(push.pushed_at)}
                      </Table.Cell>
                      <Table.Cell>
                        <StatusBadge color={PUSH_RESULT_COLOR[push.result]}>
                          {push.result}
                        </StatusBadge>
                      </Table.Cell>
                      <Table.Cell className="txt-compact-xsmall">
                        {push.rule_name_new ?? "-"}
                      </Table.Cell>
                      <Table.Cell className="txt-compact-xsmall">
                        {push.bound_floor && push.bound_ceiling
                          ? `${push.bound_floor} to ${push.bound_ceiling}`
                          : "-"}
                      </Table.Cell>
                      <Table.Cell className="txt-compact-xsmall">
                        {push.pushed_by ?? "-"}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {(detail?.pushes ?? []).length === 0 ? (
                <Text className="text-ui-fg-muted py-3" size="small">
                  Nothing recorded yet. Until a successful push carries bounds, price sync treats
                  this offer's range as unknown and re-asserts it.
                </Text>
              ) : null}
              {(detail?.pushes ?? []).some((push) => push.error) ? (
                <Textarea
                  className="mt-3"
                  readOnly
                  rows={4}
                  value={(detail?.pushes ?? [])
                    .filter((push) => push.error)
                    .map((push) => `${formatDate(push.pushed_at)}: ${push.error}`)
                    .join("\n")}
                />
              ) : null}
            </div>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductAllegroOffersWidget;
