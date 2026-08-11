import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, StatusBadge, Table, Text } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../../../lib/sdk";

/** Mirrors `AllegroConnectionStatus` from the module service. */
interface Connection {
  connected: boolean;
  environment: string;
  accountLogin?: string;
  scope?: string;
  expiresAt?: string;
  connectedAt?: string;
  expired?: boolean;
  refreshTokenMissing?: boolean;
  priceSyncDisabled: boolean;
  scopesRequested: string;
}

interface SyncStateRow {
  id: string;
  provider: string;
  status: "idle" | "running" | "ok" | "error";
  last_synced_at?: string | null;
  last_error?: string | null;
  cursor?: string | null;
  write_scope_missing?: boolean;
}

interface OverviewResponse {
  connection: Connection;
  sync_state: SyncStateRow[];
}

/**
 * The callback route can only pass back a short code, never Allegro's own
 * message - the detail is in the server log. These are the operator-facing
 * translations of that closed set.
 */
const CALLBACK_ERRORS: Record<string, string> = {
  denied: "The authorization was declined on Allegro's consent screen.",
  exchange_failed:
    "Allegro rejected the authorization code. Check the client id, secret, and that the redirect URI registered for the app matches this one exactly. The server log has the reason.",
  missing_code: "Allegro returned no authorization code. Start the connection again.",
  persist_failed:
    "The connection succeeded but the tokens could not be stored. Check `encryptionKey` and the server log.",
  state_mismatch:
    "The security check failed. This happens when the flow takes over 10 minutes, or when it was not started from this browser. Start it again.",
};

const formatDate = (value?: string | null): string => {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
};

const SYNC_STATUS_COLOR: Record<SyncStateRow["status"], "green" | "orange" | "red" | "grey"> = {
  error: "red",
  idle: "grey",
  ok: "green",
  running: "orange",
};

const AllegroSettingsPage = () => {
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const justConnected = params.get("connected") === "1";
  const callbackError = params.get("error") ?? undefined;

  const load = useCallback(async () => {
    try {
      setData(await sdk.client.fetch<OverviewResponse>("/admin/allegro"));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load Allegro status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { authorization_url } = await sdk.client.fetch<{
        authorization_url: string;
      }>("/admin/allegro/oauth/start");
      // A full-page navigation, not a fetch: the browser has to reach Allegro's
      // consent screen, and the state cookie set by the call above only travels
      // back on a top-level navigation.
      window.location.href = authorization_url;
    } catch (error) {
      setBusy(false);
      setLoadError(error instanceof Error ? error.message : "Could not start the connection.");
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await sdk.client.fetch("/admin/allegro/disconnect", { method: "POST" });
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const connection = data?.connection;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Allegro</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Connect the Allegro seller account this store sells through.
          </Text>
        </div>
        {connection?.environment ? (
          <Badge color={connection.environment === "sandbox" ? "orange" : "grey"} size="small">
            {connection.environment}
          </Badge>
        ) : null}
      </div>

      {justConnected ? (
        <div className="px-6 py-4">
          <Alert variant="success">Allegro account connected.</Alert>
        </div>
      ) : null}

      {callbackError ? (
        <div className="px-6 py-4">
          <Alert variant="error">
            {CALLBACK_ERRORS[callbackError] ?? `The connection failed (${callbackError}).`}
          </Alert>
        </div>
      ) : null}

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <Heading level="h2">Connection</Heading>
          {connection ? (
            <StatusBadge color={connection.connected ? "green" : "grey"}>
              {connection.connected ? "Connected" : "Not connected"}
            </StatusBadge>
          ) : null}
        </div>

        {connection === undefined ? (
          <Text className="text-ui-fg-subtle" size="small">
            Loading...
          </Text>
        ) : (
          <div className="flex flex-col gap-y-3">
            {connection.connected ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                <Field label="Account">{connection.accountLogin ?? "unknown"}</Field>
                <Field label="Connected at">{formatDate(connection.connectedAt)}</Field>
                <Field label="Token expires">
                  {formatDate(connection.expiresAt)}
                  {connection.expired ? " (expired, refreshed on next call)" : ""}
                </Field>
                <Field label="Granted scopes">
                  {connection.scope ?? "not reported by Allegro"}
                </Field>
              </dl>
            ) : (
              <Text className="text-ui-fg-subtle" size="small">
                No Allegro account is connected. Connecting opens Allegro's consent screen and
                requests: <code>{connection.scopesRequested}</code>
              </Text>
            )}

            {connection.connected && connection.refreshTokenMissing ? (
              <Alert variant="warning">
                The stored connection has no refresh token, so it stops working once the access
                token expires. Reconnect.
              </Alert>
            ) : null}

            {connection.priceSyncDisabled ? (
              <Alert variant="warning">
                Price sync is disabled (plugin option `priceSyncDisabled`, or
                `ALLEGRO_PRICE_SYNC_DISABLED`). No price-affecting write will be sent to Allegro.
              </Alert>
            ) : null}

            <div className="flex gap-x-2">
              <Button
                disabled={busy}
                onClick={connect}
                variant={connection.connected ? "secondary" : "primary"}
              >
                {connection.connected ? "Reconnect" : "Connect Allegro"}
              </Button>
              {connection.connected ? (
                <Button disabled={busy} onClick={disconnect} variant="danger">
                  Disconnect
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Sync health
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          One row per sync loop. Wave 1 ships no sync loops yet, so this table is empty until offer
          discovery lands.
        </Text>

        {data?.sync_state?.length ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Provider</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Last synced</Table.HeaderCell>
                <Table.HeaderCell>Last error</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.sync_state.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>{row.provider}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={SYNC_STATUS_COLOR[row.status]}>{row.status}</StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{formatDate(row.last_synced_at)}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {row.write_scope_missing
                      ? "Write scope missing: reconnect with offer write access."
                      : (row.last_error ?? "-")}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <Text className="text-ui-fg-muted" size="small">
            No sync state recorded.
          </Text>
        )}
      </div>
    </Container>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-ui-fg-muted txt-compact-small">{label}</dt>
    <dd className="txt-compact-small">{children}</dd>
  </div>
);

export const config = defineRouteConfig({
  label: "Allegro",
});

export default AllegroSettingsPage;
