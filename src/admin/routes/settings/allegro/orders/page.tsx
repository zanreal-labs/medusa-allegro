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
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("allegro");
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
      setLoadError(error instanceof Error ? error.message : t("orders.errors.loadFailed"));
    }
  }, [t]);

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
        toast.warning(t("orders.toastFindingsTitle"), {
          description: String(response.result.error),
        });
      } else {
        toast.success(t("orders.toastSuccess"));
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("orders.errors.syncFailed"));
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
          t(
            result.created ? "orders.toastRepairedWithOrder" : "orders.toastRepaired",
            { id: checkoutFormId },
          ),
        );
      } else {
        // Expected: the underlying cause may not be fixed yet, and the message says
        // what is still wrong.
        toast.error(result.error ?? t("orders.repairFailedDefault"));
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("orders.errors.repairFailed"));
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
        toast.success(t("orders.toastImported", { fetched: result.fetched, imported: result.imported }));
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("orders.errors.importFailed"));
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
          <Heading level="h1">{t("orders.title")}</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            {t("orders.description")}
          </Text>
        </div>
        <div className="flex gap-x-2">
          <Button disabled={running} onClick={() => void syncNow()} size="small">
            {t("orders.actions.syncNow")}
          </Button>
          <Button onClick={() => setImportOpen(true)} size="small" variant="secondary">
            {t("orders.actions.importWindow")}
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
          <Heading level="h2">{t("orders.drainHealth.title")}</Heading>
          {data ? (
            <StatusBadge color={SYNC_STATUS_COLOR[data.status]}>{data.status}</StatusBadge>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-3">
          <Field label={t("common.lastSynced")}>{formatDate(data?.last_synced_at)}</Field>
          <Field label={t("orders.drainHealth.eventCursor")}>
            {data?.cursor ?? t("orders.drainHealth.cursorNotBootstrapped")}
          </Field>
          <Field label={t("orders.drainHealth.ordersTracked")}>{data?.count ?? 0}</Field>
        </dl>
        {data?.last_error ? (
          <Alert className="mt-4" variant="warning">
            {data.last_error}
          </Alert>
        ) : null}
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("orders.quarantine.title", { count: quarantined.length })}
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          {t("orders.quarantine.description")}
        </Text>
        {quarantined.length > 0 ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("orders.quarantine.table.checkoutForm")}</Table.HeaderCell>
                <Table.HeaderCell>{t("orders.quarantine.table.failingSince")}</Table.HeaderCell>
                <Table.HeaderCell>{t("orders.quarantine.table.lastError")}</Table.HeaderCell>
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
                        {t("orders.actions.repair")}
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <Text className="text-ui-fg-muted" size="small">
            {t("orders.quarantine.empty")}
          </Text>
        )}
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <Heading className="mb-3" level="h2">
          {t("orders.recent.title")}
        </Heading>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("orders.recent.table.checkoutForm")}</Table.HeaderCell>
              <Table.HeaderCell>{t("orders.recent.table.medusaOrder")}</Table.HeaderCell>
              <Table.HeaderCell>{t("orders.recent.table.allegro")}</Table.HeaderCell>
              <Table.HeaderCell>{t("orders.recent.table.derived")}</Table.HeaderCell>
              <Table.HeaderCell>{t("orders.recent.table.total")}</Table.HeaderCell>
              <Table.HeaderCell>{t("orders.recent.table.lastEvent")}</Table.HeaderCell>
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
                      {t("orders.recent.notCreated")}
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
                        {t("orders.recent.unmappedLine", { count: order.line_conflicts?.length })}
                      </Badge>
                    ) : null}
                    {order.last_error ? (
                      <Button
                        disabled={busyForm === order.checkout_form_id}
                        onClick={() => void repair(order.checkout_form_id)}
                        size="small"
                        variant="secondary"
                      >
                        {t("orders.actions.repair")}
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
            {t("orders.recent.empty")}
          </Text>
        ) : null}
      </div>

      <FocusModal onOpenChange={setImportOpen} open={importOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading level="h2">{t("orders.importModal.title")}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col gap-y-4 p-6">
            <Text className="text-ui-fg-subtle" size="small">
              {t("orders.importModal.description")}
            </Text>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="allegro-import-since">{t("orders.importModal.updatedSince")}</Label>
              <Input
                id="allegro-import-since"
                onChange={(changeEvent) => setImportSince(changeEvent.target.value)}
                type="datetime-local"
                value={importSince}
              />
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="allegro-import-until">{t("orders.importModal.updatedUntil")}</Label>
              <Input
                id="allegro-import-until"
                onChange={(changeEvent) => setImportUntil(changeEvent.target.value)}
                type="datetime-local"
                value={importUntil}
              />
            </div>
            <Text className="text-ui-fg-muted" size="small">
              {t("orders.importModal.hint")}
            </Text>

            {importResult ? (
              <Alert
                variant={importResult.failed > 0 || importResult.truncated ? "warning" : "success"}
              >
                {t("orders.importModal.resultSummary", {
                  fetched: importResult.fetched,
                  imported: importResult.imported,
                  created: importResult.created,
                  failed: importResult.failed,
                })}
                {importResult.error ? ` ${importResult.error}` : ""}
              </Alert>
            ) : null}

            <div className="flex gap-x-2">
              <Button
                disabled={importing || !importSince}
                onClick={() => void runImport()}
                size="small"
              >
                {t("orders.importModal.importButton")}
              </Button>
              <Button onClick={() => setImportOpen(false)} size="small" variant="secondary">
                {t("common.close")}
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
  label: "orders.title",
  translationNs: "allegro",
});

export default AllegroOrdersPage;
