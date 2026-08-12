import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Container, StatusBadge, Text } from "@medusajs/ui";
import { useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import type { AllegroSummary, SummaryResponse } from "../lib/types";

/**
 * A compact Allegro health line above the products table.
 *
 * Medusa does not let a plugin add a column to the core products data table, so
 * a true per-row "Allegro status" while browsing is not on offer. This is the
 * best-supported approximation: one roll-up line that answers "is anything
 * wrong with my Allegro catalogue?" at a glance, with each count linking into
 * the Allegro offers route filtered to exactly those rows. The authoritative
 * per-product view lives on each product's own detail page.
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
      <a className="text-ui-fg-interactive txt-compact-small" href="/app/allegro">
        {summary.linked} linked
      </a>
      <Text className="text-ui-fg-subtle txt-compact-small">{summary.unlinked} unlinked</Text>
      <a className="flex items-center gap-x-1" href="/app/allegro?filter=drift">
        <StatusBadge color={summary.drifting > 0 ? "orange" : "grey"}>
          {summary.drifting} drifting
        </StatusBadge>
      </a>
      <a className="flex items-center gap-x-1" href="/app/allegro?filter=conflict">
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
