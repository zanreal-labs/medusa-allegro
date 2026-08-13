import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  Input,
  Select,
  StatusBadge,
  Switch,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import {
  CONFLICT_LABEL,
  formatDate,
  PRICE_MODE_COLOR,
  PUSH_RESULT_COLOR,
} from "../../../../lib/format";
import { sdk } from "../../../../lib/sdk";
import type {
  OfferDetailResponse,
  OfferRow,
  OffersResponse,
  SinglePushResult,
  SyncRunResponse,
} from "../../../../lib/types";

/**
 * The offer mapping table.
 *
 * Functional over pretty, deliberately. What an operator needs from this screen is
 * narrow and specific: find the offers that are NOT being synced and see why. So the
 * two filters that matter are first-class buttons rather than buried in a query
 * builder, every row shows the state that decides whether it is written to, and the
 * push history - the only record of what bounds were ever sent - is one click away.
 */

const PAGE_SIZE = 50;

type Filter = "all" | "conflict" | "drift";

/**
 * The product-list status widget deep-links here with `?filter=conflict|drift`
 * so "3 drifting" lands on exactly those rows. Anything else means "all".
 */
const initialFilter = (): Filter => {
  const requested = new URLSearchParams(window.location.search).get("filter");
  return requested === "conflict" || requested === "drift" ? requested : "all";
};

const AllegroOffersPage = () => {
  const [data, setData] = useState<OffersResponse | undefined>();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busySku, setBusySku] = useState<string | undefined>();
  const [detail, setDetail] = useState<OfferDetailResponse | undefined>();
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (filter !== "all") {
      params.set(filter, "1");
    }
    if (search.trim()) {
      params.set("q", search.trim());
    }
    try {
      setData(await sdk.client.fetch<OffersResponse>(`/admin/allegro/offers?${params}`));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the offer mappings.");
    }
  }, [filter, offset, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSync = async (provider: string) => {
    setRunning(true);
    try {
      const response = await sdk.client.fetch<SyncRunResponse>("/admin/allegro/sync", {
        body: { provider },
        method: "POST",
      });
      // A skip is not a failure. Colliding with a scheduled run is retryable, and a
      // kill switch being on is the operator's own earlier decision - both need saying
      // out loud rather than being reported as an error or as a silent success.
      if (response.result.skipped) {
        toast.info(`${provider}: ${response.result.skipped}`);
      } else if (response.result.error) {
        toast.warning(`${provider} finished with findings`, {
          description: response.result.error,
        });
      } else {
        toast.success(`${provider} finished cleanly.`);
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not run ${provider}.`);
    } finally {
      setRunning(false);
    }
  };

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

  const pushNow = async (offer: OfferRow) => {
    setBusySku(offer.sku);
    try {
      const result = await sdk.client.fetch<SinglePushResult>(
        `/admin/allegro/offers/${encodeURIComponent(offer.sku)}/push`,
        { method: "POST" },
      );
      // Every outcome has its own sentence, because they call for different next
      // moves: a skip means the data is incomplete, a 403 means reconnect, a noop
      // means nothing was wrong in the first place.
      if (result.status === "synced") {
        toast.success(result.message);
      } else if (result.ok) {
        toast.info(result.message);
      } else {
        toast.error(result.message);
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not push this offer.");
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

  const offers = data?.offers ?? [];
  const count = data?.count ?? 0;

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
        <div>
          <Heading level="h1">Allegro offers</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            The SKU-to-offer mapping. A row with a conflict is held out of every sync path until it
            is resolved.
          </Text>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <Button
            disabled={running}
            onClick={() => runSync("offers")}
            size="small"
            variant="secondary"
          >
            Rediscover offers
          </Button>
          <Button
            disabled={running}
            onClick={() => runSync("price-automation")}
            size="small"
            variant="secondary"
          >
            Re-observe pricing
          </Button>
          <Button disabled={running} onClick={() => runSync("prices")} size="small">
            Sync prices now
          </Button>
          <Button disabled={running} onClick={() => runSync("stock")} size="small">
            Sync stock now
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-6 py-4">
        <Select
          onValueChange={(value) => {
            setFilter(value as Filter);
            setOffset(0);
          }}
          value={filter}
        >
          <Select.Trigger className="w-56">
            <Select.Value placeholder="Filter" />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all">All mappings</Select.Item>
            <Select.Item value="conflict">Conflicts only</Select.Item>
            <Select.Item value="drift">Price drift only</Select.Item>
          </Select.Content>
        </Select>
        <Input
          className="w-64"
          onChange={(changeEvent) => {
            setSearch(changeEvent.target.value);
            setOffset(0);
          }}
          placeholder="Search SKU"
          value={search}
        />
        <Text className="text-ui-fg-muted" size="small">
          {count} mapping{count === 1 ? "" : "s"}
        </Text>
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>SKU</Table.HeaderCell>
              <Table.HeaderCell>Offer</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Pricing</Table.HeaderCell>
              <Table.HeaderCell>Promoted</Table.HeaderCell>
              <Table.HeaderCell>Price sync</Table.HeaderCell>
              <Table.HeaderCell>Last synced</Table.HeaderCell>
              <Table.HeaderCell> </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {offers.map((offer) => (
              <Table.Row key={offer.id}>
                <Table.Cell>
                  <div className="flex flex-col">
                    <span className="txt-compact-small-plus">{offer.sku}</span>
                    {offer.conflict ? (
                      <Badge color="red" size="2xsmall">
                        {CONFLICT_LABEL[offer.conflict] ?? offer.conflict}
                      </Badge>
                    ) : null}
                  </div>
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle">
                  {offer.offer_id ?? "not linked"}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle">{offer.status ?? "-"}</Table.Cell>
                <Table.Cell>
                  <div className="flex flex-col gap-y-1">
                    <StatusBadge color={PRICE_MODE_COLOR[offer.price_mode ?? "unknown"] ?? "grey"}>
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
                {/*
                  Three states, not two. `promoted` is null until a promo-options sweep
                  resolves it, and price sync SKIPS an unresolved offer rather than
                  pricing it on the standard commission - so rendering null as "no" would
                  show a healthy-looking row for an offer that is not being synced at all.
                */}
                <Table.Cell>
                  {offer.promoted === null || offer.promoted === undefined
                    ? "unresolved"
                    : (offer.promoted
                      ? "yes"
                      : "no")}
                </Table.Cell>
                <Table.Cell>
                  <Switch
                    checked={offer.price_sync_enabled ?? true}
                    disabled={busySku === offer.sku}
                    onCheckedChange={() => void togglePriceSync(offer)}
                  />
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                  {formatDate(offer.price_synced_at)}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex justify-end gap-x-2">
                    <Button
                      disabled={busySku === offer.sku || Boolean(offer.conflict)}
                      onClick={() => void pushNow(offer)}
                      size="small"
                      variant="secondary"
                    >
                      Push
                    </Button>
                    <Button
                      onClick={() => void openHistory(offer.sku)}
                      size="small"
                      variant="transparent"
                    >
                      History
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>

        {offers.length === 0 ? (
          <Text className="text-ui-fg-muted py-4" size="small">
            No mappings match. Offer discovery creates them from the seller's live offers, matching
            each offer's sygnatura against a variant SKU.
          </Text>
        ) : null}

        {count > PAGE_SIZE ? (
          <div className="flex items-center justify-between pt-4">
            <Button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              size="small"
              variant="secondary"
            >
              Previous
            </Button>
            <Text className="text-ui-fg-muted" size="small">
              {offset + 1} to {Math.min(offset + PAGE_SIZE, count)} of {count}
            </Text>
            <Button
              disabled={offset + PAGE_SIZE >= count}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              size="small"
              variant="secondary"
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>

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
            {detail?.offer.last_error ? (
              <Alert variant="warning">{detail.offer.last_error}</Alert>
            ) : null}

            <div>
              <Heading className="mb-2" level="h3">
                Push history
              </Heading>
              <Text className="text-ui-fg-subtle mb-3" size="small">
                Append-only, and the only record of the price range that was pushed - Allegro does
                not expose an attached rule's bounds. `observed` rows are the monitor recording a
                state it did not write.
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
                        {push.rule_name_old && push.rule_name_old !== push.rule_name_new
                          ? `${push.rule_name_old} to ${push.rule_name_new ?? "-"}`
                          : (push.rule_name_new ?? "-")}
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

export const config = defineRouteConfig({
  label: "Allegro offers",
});

export default AllegroOffersPage;
