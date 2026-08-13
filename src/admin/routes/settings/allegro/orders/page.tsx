import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  StatusBadge,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { formatAge, formatDate, SYNC_STATUS_COLOR } from "../../../../lib/format";
import { sdk } from "../../../../lib/sdk";
import type {
  ImportResult,
  OrdersResponse,
  RepairResult,
  SyncRunResponse,
} from "../../../../lib/types";

/**
 * The orders sync surface.
 *
 * The quarantine list is the reason this page exists. A quarantined checkout form was
 * SKIPPED so the event cursor could keep moving - the right trade, but only while it
 * stays visible, and a run summary vanishes on the next render. Here each entry is
 * durable, carries its error and its age, and has a Repair button next to it.
 *
 * The import dialog is the other half: the only route to an order the journal never
 * named. Allegro retains roughly 60 days of events, and a fresh install deliberately
 * starts its cursor at "now", so bringing in history is an explicit action taken here.
 */

const DERIVED_STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey" | "blue"> = {
  cancelled: "red",
  delivered: "green",
  new: "blue",
  pending: "orange",
  processing: "blue",
  ready_for_shipment: "blue",
  returned: "orange",
  sent: "green",
};

const AllegroOrdersPage = () => {
  const [data, setData] = useState<OrdersResponse | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busyForm, setBusyForm] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importSince, setImportSince] = useState("");
  const [importUntil, setImportUntil] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | undefined>();

  const load = useCallback(async () => {
    try {
      setData(await sdk.client.fetch<OrdersResponse>("/admin/allegro/orders?limit=50"));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the Allegro orders.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async () => {
    setRunning(true);
    try {
      const response = await sdk.client.fetch<SyncRunResponse>("/admin/allegro/sync", {
        body: { provider: "orders" },
        method: "POST",
      });
      if (response.result.skipped) {
        toast.info(String(response.result.skipped));
      } else if (response.result.error) {
        toast.warning("The drain finished with findings", {
          description: String(response.result.error),
        });
      } else {
        toast.success("The event journal was drained cleanly.");
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not drain the journal.");
    } finally {
      setRunning(false);
    }
  };

  const repair = async (checkoutFormId: string) => {
    setBusyForm(checkoutFormId);
    try {
      const result = await sdk.client.fetch<RepairResult>("/admin/allegro/orders/repair", {
        body: { checkout_form_id: checkoutFormId },
        method: "POST",
      });
      if (result.ok) {
        toast.success(
          `Repaired ${checkoutFormId}${result.created ? " and created its Medusa order" : ""}. The drain resumes handling it automatically.`,
        );
      } else {
        // Expected: the underlying cause may not be fixed yet, and the message says
        // what is still wrong.
        toast.error(result.error ?? "The repair did not succeed.");
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not repair this order.");
    } finally {
      setBusyForm(undefined);
    }
  };

  const runImport = async () => {
    setImporting(true);
    setImportResult(undefined);
    try {
      const result = await sdk.client.fetch<ImportResult>("/admin/allegro/orders/import", {
        body: {
          since: new Date(importSince).toISOString(),
          ...(importUntil ? { until: new Date(importUntil).toISOString() } : {}),
        },
        method: "POST",
      });
      setImportResult(result);
      if (result.skipped) {
        toast.info(result.skipped);
      } else {
        toast.success(`Imported ${result.imported} of ${result.fetched} order(s).`);
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The import failed.");
    } finally {
      setImporting(false);
    }
  };

  const orders = data?.orders ?? [];
  const quarantined = data?.quarantined ?? [];

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
        <div>
          <Heading level="h1">Allegro orders</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Drained from Allegro's order event journal. The cursor advances only over orders that
            landed, so a transient failure replays rather than being lost.
          </Text>
        </div>
        <div className="flex gap-x-2">
          <Button disabled={running} onClick={() => void syncNow()} size="small">
            Sync now
          </Button>
          <Button onClick={() => setImportOpen(true)} size="small" variant="secondary">
            Import window
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading level="h2">Drain health</Heading>
          {data ? (
            <StatusBadge color={SYNC_STATUS_COLOR[data.status]}>{data.status}</StatusBadge>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-3">
          <Field label="Last synced">{formatDate(data?.last_synced_at)}</Field>
          <Field label="Event cursor">
            {data?.cursor ?? "not bootstrapped - the first run records the newest event id"}
          </Field>
          <Field label="Orders tracked">{data?.count ?? 0}</Field>
        </dl>
        {data?.last_error ? (
          <Alert className="mt-4" variant="warning">
            {data.last_error}
          </Alert>
        ) : null}
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Quarantined ({quarantined.length})
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          These checkout forms failed repeatedly, so the event cursor was allowed past them to keep
          the rest of the sync moving. They are NOT retried automatically. Repair each one once the
          underlying cause is fixed; a success hands it back to the drain.
        </Text>
        {quarantined.length > 0 ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Checkout form</Table.HeaderCell>
                <Table.HeaderCell>Failing since</Table.HeaderCell>
                <Table.HeaderCell>Last error</Table.HeaderCell>
                <Table.HeaderCell> </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {quarantined.map((entry) => (
                <Table.Row key={entry.key}>
                  <Table.Cell className="txt-compact-small-plus">{entry.key}</Table.Cell>
                  <Table.Cell className="txt-compact-xsmall">{formatAge(entry.since)}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                    {entry.error}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end">
                      <Button
                        disabled={busyForm === entry.key}
                        onClick={() => void repair(entry.key)}
                        size="small"
                        variant="secondary"
                      >
                        Repair
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <Text className="text-ui-fg-muted" size="small">
            Nothing quarantined.
          </Text>
        )}
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <Heading className="mb-3" level="h2">
          Recent orders
        </Heading>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Checkout form</Table.HeaderCell>
              <Table.HeaderCell>Medusa order</Table.HeaderCell>
              <Table.HeaderCell>Allegro</Table.HeaderCell>
              <Table.HeaderCell>Derived</Table.HeaderCell>
              <Table.HeaderCell>Total</Table.HeaderCell>
              <Table.HeaderCell>Last event</Table.HeaderCell>
              <Table.HeaderCell> </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {orders.map((order) => (
              <Table.Row key={order.id}>
                <Table.Cell>
                  <div className="flex flex-col">
                    <span className="txt-compact-small-plus">{order.checkout_form_id}</span>
                    {order.buyer_login ? (
                      <span className="text-ui-fg-muted txt-compact-xsmall">
                        {order.buyer_login}
                      </span>
                    ) : null}
                  </div>
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                  {order.medusa_order_id ?? (
                    <Badge color="red" size="2xsmall">
                      not created
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                  {order.allegro_status ?? "-"}
                  {order.fulfillment_status ? ` / ${order.fulfillment_status}` : ""}
                </Table.Cell>
                <Table.Cell>
                  {order.derived_status ? (
                    <StatusBadge color={DERIVED_STATUS_COLOR[order.derived_status] ?? "grey"}>
                      {order.derived_status}
                    </StatusBadge>
                  ) : (
                    "-"
                  )}
                </Table.Cell>
                <Table.Cell className="txt-compact-xsmall">
                  {order.total_to_pay ? `${order.total_to_pay} ${order.currency ?? ""}` : "-"}
                  {/*
                    A disputed total is shown next to the figure it disputes, not tucked into a
                    separate column. The order exists and the sale is real; what needs a human
                    is the disagreement about how much it was for.
                  */}
                  {order.conflict ? (
                    <div className="mt-1">
                      <Badge color="orange" size="2xsmall">
                        {order.conflict}
                      </Badge>
                      {order.conflict_detail ? (
                        <div className="text-ui-fg-subtle txt-compact-xsmall mt-1">
                          {order.conflict_detail}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                  {formatDate(order.last_event_at)}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex flex-col items-end gap-y-1">
                    {(order.line_conflicts?.length ?? 0) > 0 ? (
                      <Badge color="orange" size="2xsmall">
                        {order.line_conflicts?.length} unmapped line
                      </Badge>
                    ) : null}
                    {order.last_error ? (
                      <Button
                        disabled={busyForm === order.checkout_form_id}
                        onClick={() => void repair(order.checkout_form_id)}
                        size="small"
                        variant="secondary"
                      >
                        Repair
                      </Button>
                    ) : null}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        {orders.length === 0 ? (
          <Text className="text-ui-fg-muted py-4" size="small">
            No Allegro orders recorded yet. The drain starts tracking from the newest event at its
            first run; use the import window to bring in history.
          </Text>
        ) : null}
      </div>

      <FocusModal onOpenChange={setImportOpen} open={importOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading level="h2">Import an order window</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col gap-y-4 p-6">
            <Text className="text-ui-fg-subtle" size="small">
              Pages `GET /order/checkout-forms` by `updatedAt`. This is the only route to an order
              the event journal never named - Allegro retains roughly 60 days of events, and a fresh
              installation starts its cursor at "now". It never moves the event cursor, because an
              import fills a gap behind it.
            </Text>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="allegro-import-since">Updated since</Label>
              <Input
                id="allegro-import-since"
                onChange={(changeEvent) => setImportSince(changeEvent.target.value)}
                type="datetime-local"
                value={importSince}
              />
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="allegro-import-until">Updated until (optional)</Label>
              <Input
                id="allegro-import-until"
                onChange={(changeEvent) => setImportUntil(changeEvent.target.value)}
                type="datetime-local"
                value={importUntil}
              />
            </div>
            <Text className="text-ui-fg-muted" size="small">
              One run covers at most 3,000 orders and holds the orders sync claim while it works, so
              the per-minute drain cannot import anything new in the meantime. For a larger
              backfill, run several windows.
            </Text>

            {importResult ? (
              <Alert
                variant={importResult.failed > 0 || importResult.truncated ? "warning" : "success"}
              >
                Fetched {importResult.fetched}, imported {importResult.imported}, created{" "}
                {importResult.created}, failed {importResult.failed}.
                {importResult.error ? ` ${importResult.error}` : ""}
              </Alert>
            ) : null}

            <div className="flex gap-x-2">
              <Button
                disabled={importing || !importSince}
                onClick={() => void runImport()}
                size="small"
              >
                Import
              </Button>
              <Button onClick={() => setImportOpen(false)} size="small" variant="secondary">
                Close
              </Button>
            </div>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </Container>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-ui-fg-muted txt-compact-small">{label}</dt>
    <dd className="txt-compact-small break-all">{children}</dd>
  </div>
);

export const config = defineRouteConfig({
  label: "Allegro orders",
});

export default AllegroOrdersPage;
