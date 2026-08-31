import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { DetailWidgetProps } from "@medusajs/framework/types";
import { Alert, Badge, Container, Heading, Select, Table, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../lib/sdk";

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
 * Naming trap it states outright: the account's "Bitdefender Sale" rule is
 * Allegro's PAID HIGHLIGHT ("Wyroznienie"), not a discount.
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
  costRecentlyEdited: boolean;
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
      setError(caught instanceof Error ? caught.message : "Could not load the Allegro preview.");
    }
  }, [promotionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setBase = useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const discount_base = value === "none" ? null : value;
        await sdk.client.fetch(`/admin/allegro/promotions/${encodeURIComponent(promotionId)}/config`, {
          body: { discount_base },
          method: "POST",
        });
        toast.success("Discount base saved. Nothing was sent to Allegro.");
        await load();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : "Could not save the discount base.");
      } finally {
        setSaving(false);
      }
    },
    [promotionId, load],
  );

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col gap-2 px-6 py-4">
        <Heading level="h2">Allegro promotion preview</Heading>
        <Alert variant="info">
          <Text weight="plus">Nothing here writes to Allegro.</Text>
          <Text size="small">
            This shows what this promotion WOULD do to your Allegro auctions. It is not armed and
            cannot publish anything - the overlay that would act on it does not exist yet.
          </Text>
        </Alert>
        <Alert variant="warning">
          <Text weight="plus">&quot;Sale&quot; on Allegro is a paid highlight, not a discount.</Text>
          <Text size="small">
            The &quot;Bitdefender Sale&quot; rule is Allegro&apos;s &quot;Wyroznienie&quot; highlight
            and only changes the commission rate. A promotional discount is a different rule, named
            with the ZR&#x276F; prefix below.
          </Text>
        </Alert>
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
                <Text weight="plus">This promotion cannot drive Allegro:</Text>
                <ul className="list-disc pl-5">
                  {preview.promotion.blockReasons.map((blocker) => (
                    <li key={blocker.reason}>
                      <Text size="small">{blocker.label}</Text>
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 px-6 py-4">
            <div className="flex items-center gap-3">
              <Text size="small" weight="plus">
                Discount base
              </Text>
              <div className="w-64">
                <Select
                  disabled={saving || preview.promotion.blockReasons.length > 0}
                  value={preview.discountBase ?? "none"}
                  onValueChange={(value) => void setBase(value)}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Not chosen (preview only)" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="none">Not chosen (preview only)</Select.Item>
                    <Select.Item value="competitor">Competitor - rule switch</Select.Item>
                    <Select.Item value="srp">SRP - price override</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>
            <Text size="small" className="text-ui-fg-subtle">
              Choosing a base records which mechanism the overlay would use. It writes nothing to
              Allegro. Until a base is chosen this promotion is preview-only and cannot be armed.
            </Text>
          </div>

          <div className="px-6 py-4">
            <Alert variant="success">
              <Text weight="plus">
                Would move {preview.coverage.eligible} auction(s). Everything else is untouched.
              </Text>
              <Text size="small">
                Targeted {preview.coverage.targeted} SKU(s): {preview.coverage.linked} linked to an
                Allegro offer, {preview.coverage.eligible} eligible to move,{" "}
                {preview.coverage.skipped} skipped. This promotion never touches an auction outside
                its own targeted products - the rest of your catalogue is left exactly as it is.
                Break-even is shown whole-PLN with the raw value beside it, because whether
                Allegro&apos;s managed rules require whole-unit bounds is UNVERIFIED until price sync
                is armed once.
              </Text>
            </Alert>
          </div>

          <div className="px-6 py-4">
            <PreviewTable preview={preview} />
          </div>
        </>
      ) : (
        !error && (
          <div className="px-6 py-4">
            <Text size="small">Loading preview...</Text>
          </div>
        )
      )}
    </Container>
  );
};

const PreviewTable = ({ preview }: { preview: PromotionPreview }) => (
  <>
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>SKU</Table.HeaderCell>
          <Table.HeaderCell>Highlight</Table.HeaderCell>
          <Table.HeaderCell>Break-even (whole / raw)</Table.HeaderCell>
          <Table.HeaderCell>SRP</Table.HeaderCell>
          <Table.HeaderCell>Competitor -&gt; rule switch</Table.HeaderCell>
          <Table.HeaderCell>SRP -&gt; price override</Table.HeaderCell>
          <Table.HeaderCell>Cost</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {preview.rows.map((row) => (
          <Table.Row key={row.sku}>
            <Table.Cell>{row.sku}</Table.Cell>
            <Table.Cell>
              {row.promoted ? (
                <Badge color="orange" size="2xsmall">
                  Wyroznienie
                </Badge>
              ) : (
                <span className="text-ui-fg-muted">-</span>
              )}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {row.breakEven} {row.currency}
              <span className="text-ui-fg-muted"> / {row.breakEvenRaw}</span>
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {row.srp} {row.currency}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {"skipped" in row.ruleSwitch ? (
                <Badge color="red" size="2xsmall">
                  {row.ruleSwitch.skipped}
                </Badge>
              ) : (
                <div className="flex flex-col gap-1">
                  <span>
                    {row.ruleSwitch.fromRule} -&gt; <b>{row.ruleSwitch.toRule}</b>
                  </span>
                  <span className="text-ui-fg-muted">
                    won&apos;t lower the price when we are already the cheapest
                  </span>
                </div>
              )}
            </Table.Cell>
            <Table.Cell className="txt-compact-xsmall">
              {"skipped" in row.override ? (
                <Badge color="red" size="2xsmall">
                  {row.override.skipped}
                </Badge>
              ) : (
                <div className="flex flex-col gap-1">
                  <span>
                    <b>
                      {row.override.price} {row.currency}
                    </b>
                    {row.override.clampedToFloor ? (
                      <Badge color="orange" size="2xsmall" className="ml-1">
                        floored at break-even
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-ui-fg-muted">reverts to {row.override.revertRule} on expiry</span>
                </div>
              )}
            </Table.Cell>
            <Table.Cell>
              {row.costRecentlyEdited ? (
                <Badge color="orange" size="2xsmall">
                  edited &lt;30d
                </Badge>
              ) : (
                <span className="text-ui-fg-muted">-</span>
              )}
            </Table.Cell>
          </Table.Row>
        ))}
        {preview.rows.length === 0 ? (
          <Table.Row>
            <Table.Cell className="text-ui-fg-muted">
              No targeted SKU resolves to an eligible Allegro offer.
            </Table.Cell>
          </Table.Row>
        ) : null}
      </Table.Body>
    </Table>
    {preview.skipped.length > 0 ? (
      <div className="mt-3">
        <Text size="small" weight="plus">
          Skipped SKUs (stay untouched)
        </Text>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>SKU</Table.HeaderCell>
              <Table.HeaderCell>Reason</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {preview.skipped.map((entry) => (
              <Table.Row key={entry.sku}>
                <Table.Cell>{entry.sku}</Table.Cell>
                <Table.Cell>
                  <Badge color="grey" size="2xsmall">
                    {entry.reason}
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
