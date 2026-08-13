import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Container, StatusBadge, Text } from "@medusajs/ui";
import { useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import type { AllegroSummary, SummaryResponse } from "../lib/types";

/**
 * A compact Allegro health line above the products table.
 *
 * Medusa 2.18's admin SDK exposes widget injection zones (`product.list.before`,
 * `product.details.*`) but NO way for a plugin to add a column to the CORE products
 * data table - that table is not extensible from a widget. So a true per-row "Allegro
 * status" while browsing the stock products list is not on offer here, and this is the
 * best-supported approximation: one roll-up line that answers "is anything wrong with
 * my Allegro catalogue?" at a glance, with each count linking into Settings -> Allegro
 * offers filtered to exactly those rows. The authoritative per-product view lives on
 * each product's own detail page (the `product.details.after` widget).
 *
 * TODO(medusa-admin-kit): the real per-row "Allegro status" column will be contributed
 * through @zanreal/medusa-admin-kit's extensible products list once it ships. This
 * plugin will register that column there rather than building a competing full products
 * list of its own; this summary line stays as the zero-dependency fallback. See the
 * README "Admin surfaces" section.
 *
 * It renders nothing until at least one SKU is mapped, so a store that does not
 * use Allegro never sees it.
 */
const ProductListAllegroSummaryWidget = () => {
  const [summary, setSummary] = useState<AllegroSummary | undefined>();

  useEffect(() => {
    let cancelled = false;
    sdk.client
      .fetch<SummaryResponse>("/admin/allegro/summary")
      .then((response) => {
        if (!cancelled) {
          setSummary(response.summary);
        }
      })
      .catch(() => {
        // The products list must not break because Allegro is unreachable or
        // not configured; the widget just stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary || summary.total === 0) {
    return null;
  }

  return (
    <Container className="mb-2 flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
      <Text size="small" weight="plus">
        Allegro
      </Text>
      <a className="text-ui-fg-interactive txt-compact-small" href="/app/settings/allegro/offers">
        {summary.linked} linked
      </a>
      <Text className="text-ui-fg-subtle txt-compact-small">{summary.unlinked} unlinked</Text>
      <a className="flex items-center gap-x-1" href="/app/settings/allegro/offers?filter=drift">
        <StatusBadge color={summary.drifting > 0 ? "orange" : "grey"}>
          {summary.drifting} drifting
        </StatusBadge>
      </a>
      <a className="flex items-center gap-x-1" href="/app/settings/allegro/offers?filter=conflict">
        <StatusBadge color={summary.conflicts > 0 ? "red" : "grey"}>
          {summary.conflicts} conflict{summary.conflicts === 1 ? "" : "s"}
        </StatusBadge>
      </a>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.list.before",
});

export default ProductListAllegroSummaryWidget;
