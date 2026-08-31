import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { DetailWidgetProps } from "@medusajs/framework/types";
import { Alert, Badge, Container, Heading, Select, Switch, Table, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import {
  BLOCK_REASON_PL,
  coverageBody,
  labelFor,
  movesHeadline,
  marginLabel,
  PROMO_COPY,
  raisesPriceLabel,
  THIN_MARGIN_PCT,
  SKIP_REASON_PL,
} from "../lib/promotion-preview-copy";

/**
 * The Allegro promotion preview, rendered on the promotion's own detail page.
 *
 * It WRITES NOTHING TO ALLEGRO. It reads the promotion and shows, per SKU, exactly
 * which Allegro auctions this promotion would move and which stay untouched - the
 * scoping made visible rather than trusted, which is the whole answer to "it can
 * only set the model for everything at once". A promotion acts only on the offers
 * of its own targeted products; every other auction in the catalogue is left alone.
 *
 * The one control here, the `discount_base` selector, persists a Medusa-side choice
 * (which mechanism the overlay would use) and still writes nothing to Allegro. The
 * overlay that would act on it does not exist yet, so there is no arm step and
 * nothing can be published from this page.
 *
 * Every string it draws is about the operator's promotion and the resulting price,
 * never about the mechanism behind it: no rule names, no rule-name prefix, no
 * attach/switch/override vocabulary. That context is real, but it belongs beside
 * the code it explains (`resolveExpectedRuleIds` in `src/lib/sync/price-automation.ts`)
 * rather than in front of somebody who opened this page to see what a promotion
 * does to his prices. See the note in `src/admin/lib/promotion-preview-copy.ts`.
 */

type DiscountBase = "srp" | "competitor";

interface OfferPreview {
  sku: string;
  offerId: string | null;
  promoted: boolean | null;
  currency: string;
  breakEven: number;
  breakEvenRaw: number;
  srp: number;
  ruleSwitch:
    | { fromRule: string; toRule: string; competitorRelativeCaveat: true }
    | { skipped: string };
  override: { price: number; clampedToFloor: boolean; revertRule: string } | { skipped: string };
  currentPrice?: number;
  marginAmount?: number;
  marginPct?: number;
  overrideMarginPct?: number;
  raisesPrice?: boolean;
}

interface PromotionPreview {
  promotion: {
    id: string;
    code: string | null;
    automatic: boolean;
    active: boolean;
    includesAllegro: boolean;
    discountLabel: string;
    blockReasons: { reason: string; label: string }[];
  };
  discountBase: DiscountBase | null;
  enabled: boolean;
  rows: OfferPreview[];
  skipped: { sku: string; reason: string }[];
  coverage: { targeted: number; linked: number; eligible: number; skipped: number };
}

const AllegroPromotionWidget = ({ data }: DetailWidgetProps<{ id: string }>) => {
  const promotionId = data.id;
  const [preview, setPreview] = useState<PromotionPreview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const response = await sdk.client.fetch<{ preview: PromotionPreview }>(
        `/admin/allegro/promotions/${encodeURIComponent(promotionId)}`,
      );
      setPreview(response.preview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : PROMO_COPY.loadError);
    }
  }, [promotionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setArmed = useCallback(
    async (next: boolean) => {
      setSaving(true);
      try {
        await sdk.client.fetch(`/admin/allegro/promotions/${encodeURIComponent(promotionId)}/config`, {
          body: { discount_base: preview?.discountBase ?? null, enabled: next },
          method: "POST",
        });
        toast.success(PROMO_COPY.saveOk);
        await load();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : PROMO_COPY.saveError);
      } finally {
        setSaving(false);
      }
    },
    [promotionId, preview?.discountBase, load],
  );

  const setBase = useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const discount_base = value === "none" ? null : value;
        await sdk.client.fetch(`/admin/allegro/promotions/${encodeURIComponent(promotionId)}/config`, {
          body: { discount_base },
          method: "POST",
        });
        toast.success(PROMO_COPY.saveOk);
        await load();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : PROMO_COPY.saveError);
      } finally {
        setSaving(false);
      }
    },
    [promotionId, load],
  );

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col gap-1 px-6 py-4">
        <Heading level="h2">{PROMO_COPY.heading}</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          {PROMO_COPY.noWriteLine}
        </Text>
      </div>

      {error ? (
        <div className="px-6 py-4">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {preview ? (
        <>
          {preview.promotion.blockReasons.length > 0 ? (
            <div className="px-6 py-4">
              <Alert variant="warning">
                <Text weight="plus">{PROMO_COPY.blockedTitle}</Text>
                <ul className="list-disc pl-5">
                  {preview.promotion.blockReasons.map((blocker) => (
                    <li key={blocker.reason}>
                      <Text size="small">
                        {labelFor(BLOCK_REASON_PL, blocker.reason, blocker.label)}
                      </Text>
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 px-6 py-4">
            <div className="flex items-center gap-3">
              <Text size="small" weight="plus">
                {PROMO_COPY.discountBaseLabel}
              </Text>
              <div className="w-64">
                <Select
                  disabled={saving || preview.promotion.blockReasons.length > 0}
                  value={preview.discountBase ?? "none"}
                  onValueChange={(value) => void setBase(value)}
                >
                  <Select.Trigger>
                    <Select.Value placeholder={PROMO_COPY.baseNone} />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="none">{PROMO_COPY.baseNone}</Select.Item>
                    <Select.Item value="competitor">{PROMO_COPY.baseCompetitor}</Select.Item>
                    <Select.Item value="srp">{PROMO_COPY.baseSrp}</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={preview.enabled}
                disabled={
                  saving ||
                  preview.discountBase !== "competitor" ||
                  preview.promotion.blockReasons.length > 0
                }
                onCheckedChange={(next) => void setArmed(next)}
              />
              <Text size="small" weight="plus">
                {PROMO_COPY.armLabel}
              </Text>
              {preview.discountBase === null ? (
                <Text size="small" className="text-ui-fg-subtle">
                  {PROMO_COPY.armNeedsBase}
                </Text>
              ) : preview.discountBase === "srp" ? (
                <Text size="small" className="text-ui-fg-subtle">
                  {PROMO_COPY.armNeedsCompetitor}
                </Text>
              ) : null}
            </div>
          </div>

          <div className="px-6 py-4">
            <Alert variant="success">
              <Text weight="plus">{movesHeadline(preview.coverage.eligible)}</Text>
              <Text size="small">{coverageBody(preview.coverage)}</Text>
            </Alert>
          </div>

          <div className="px-6 py-4">
            <PreviewTable preview={preview} />
          </div>
        </>
      ) : (
        !error && (
          <div className="px-6 py-4">
            <Text size="small">{PROMO_COPY.loading}</Text>
          </div>
        )
      )}
    </Container>
  );
};

/**
 * The margin the CURRENT auction price leaves, and the pathology states that can
 * actually occur.
 *
 * Anchored on the live price rather than an SRP hypothetical, because live data
 * showed the two are nowhere near each other: an offer sitting at 155 under
 * Allegro's own automation while SRP is 255. A margin measured against SRP would
 * have described a sale that is not happening.
 *
 * Reachability, checked rather than assumed. Both modes clamp at the break-even
 * floor, and break-even already includes Allegro's commission, so a price below
 * cost is not reachable through either path: the override is floored at break-even
 * by `computeOverridePrice`, and the competitor rule is bounded by the same floor.
 * The loss state is therefore rendered defensively rather than expectantly - if it
 * ever appears, the clamp invariant is broken and that is precisely the moment
 * somebody needs to see it, so it stays.
 *
 * The state that IS routinely reachable is a thin margin: a discount landing near
 * the floor leaves a few percent, and the clamped case leaves whatever the whole-PLN
 * rounding of the floor happens to give.
 */
const MarginCell = ({ row }: { row: OfferPreview }) => {
  if (row.marginAmount === undefined) {
    return <span className="text-ui-fg-muted">{PROMO_COPY.marginUnknown}</span>;
  }
  const value = marginLabel(row.marginAmount, row.marginPct, row.currency);
  if (row.marginAmount <= 0) {
    return (
      <Badge color="red" size="2xsmall">
        {PROMO_COPY.marginLoss}: {value}
      </Badge>
    );
  }
  if (row.marginPct !== undefined && row.marginPct < THIN_MARGIN_PCT) {
    return (
      <Badge color="orange" size="2xsmall">
        {PROMO_COPY.marginThin}: {value}
      </Badge>
    );
  }
  return <span>{value}</span>;
};

const PreviewTable = ({ preview }: { preview: PromotionPreview }) => (
  <>
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{PROMO_COPY.tableSku}</Table.HeaderCell>
          <Table.HeaderCell>{PROMO_COPY.tableCurrent}</Table.HeaderCell>
          <Table.HeaderCell>{PROMO_COPY.tableMargin}</Table.HeaderCell>
          <Table.HeaderCell>{PROMO_COPY.tableSrp}</Table.HeaderCell>
          <Table.HeaderCell>{PROMO_COPY.tableSrpBase}</Table.HeaderCell>
          <Table.HeaderCell>{PROMO_COPY.tableCompetitor}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {preview.rows.map((row) => (
          <Table.Row key={row.sku}>
            <Table.Cell>{row.sku}</Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {row.currentPrice === undefined ? (
                <span className="text-ui-fg-muted">{PROMO_COPY.marginUnknown}</span>
              ) : (
                <b>
                  {row.currentPrice} {row.currency}
                </b>
              )}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              <MarginCell row={row} />
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {row.srp} {row.currency}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {"skipped" in row.override ? (
                <Badge color="red" size="2xsmall">
                  {labelFor(SKIP_REASON_PL, row.override.skipped)}
                </Badge>
              ) : (
                <div className="flex flex-col gap-1">
                  <span>
                    <b>
                      {row.override.price} {row.currency}
                    </b>
                    {row.overrideMarginPct === undefined ? null : (
                      <span className="text-ui-fg-muted">
                        {" "}
                        ({Math.round(row.overrideMarginPct * 100)}%)
                      </span>
                    )}
                    {row.override.clampedToFloor ? (
                      <Badge color="orange" size="2xsmall" className="ml-1">
                        {PROMO_COPY.clampedToFloor}
                      </Badge>
                    ) : null}
                  </span>
                  {row.raisesPrice && row.currentPrice !== undefined ? (
                    <Badge color="red" size="2xsmall">
                      {raisesPriceLabel(row.currentPrice, row.override.price, row.currency)}
                    </Badge>
                  ) : null}
                </div>
              )}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {"skipped" in row.ruleSwitch ? (
                <Badge color="red" size="2xsmall">
                  {labelFor(SKIP_REASON_PL, row.ruleSwitch.skipped)}
                </Badge>
              ) : (
                <span>
                  {row.breakEven} - {row.srp} {row.currency}
                </span>
              )}
            </Table.Cell>
          </Table.Row>
        ))}
        {preview.rows.length === 0 ? (
          <Table.Row>
            <Table.Cell className="text-ui-fg-muted">
              {PROMO_COPY.emptyRows}
            </Table.Cell>
          </Table.Row>
        ) : null}
      </Table.Body>
    </Table>
    {preview.skipped.length > 0 ? (
      <div className="mt-3">
        <Text size="small" weight="plus">
          {PROMO_COPY.skippedTitle}
        </Text>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{PROMO_COPY.tableSku}</Table.HeaderCell>
              <Table.HeaderCell>{PROMO_COPY.reasonHeader}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {preview.skipped.map((entry) => (
              <Table.Row key={entry.sku}>
                <Table.Cell>{entry.sku}</Table.Cell>
                <Table.Cell>
                  <Badge color="grey" size="2xsmall">
                    {labelFor(SKIP_REASON_PL, entry.reason)}
                  </Badge>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    ) : null}
  </>
);

export const config = defineWidgetConfig({
  zone: "promotion.details.after",
});

export default AllegroPromotionWidget;
