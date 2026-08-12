import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, StatusBadge, Table, Text } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { formatDate, SYNC_STATUS_COLOR } from "../../../lib/format";
import { sdk } from "../../../lib/sdk";
import type { Connection, OverviewResponse } from "../../../lib/types";

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

/**
 * A row whose tokens will not decrypt is not a working connection, so the badge
 * says so. Reporting a green "Connected" next to an error alert sends the
 * operator looking at Allegro instead of at their own `encryptionKey`.
 */
const connectionColor = (connection: Connection): "green" | "red" | "grey" => {
  if (!connection.connected) {
    return "grey";
  }
  return connection.credentialsUnreadable ? "red" : "green";
};

const connectionLabel = (connection: Connection): string => {
  if (!connection.connected) {
    return "Not connected";
  }
  return connection.credentialsUnreadable ? "Unreadable credentials" : "Connected";
};

/** What each provider row is, in one line, so the table needs no legend. */
const PROVIDER_DESCRIPTION: Record<string, string> = {
  offers: "Maps SKUs to offers, sweeps promotion state, discovers categories. Read-only.",
  orders: "Drains the order event journal into Medusa orders.",
  "price-automation": "Observes each offer's pricing rule and its drift. Read-only.",
  prices: "Attaches price-automation rules and asserts the break-even/SRP bounds.",
  stock: "Pushes Medusa available quantity to Allegro.",
};

/**
 * The counters worth showing per provider, in order.
 *
 * A curated list rather than every key: the summaries carry a dozen counters each and
 * a wall of numbers is not readable. These are the ones that answer "did this run do
 * anything, and should I worry?".
 */
const PROVIDER_COUNTERS: Record<string, string[]> = {
  offers: ["offersListed", "matched", "unlinked", "unmatchedVariants"],
  orders: ["eventsRead", "refreshed", "statusChanged", "failed"],
  "price-automation": ["scanned", "drift", "transitions"],
  prices: ["scanned", "synced", "alreadyInSync", "failed"],
  stock: ["eligible", "synced", "alreadyInSync", "failed"],
};

const formatCounters = (provider: string, counts?: Record<string, unknown> | null): string => {
  if (!counts) {
    return "no run recorded";
  }
  const keys = PROVIDER_COUNTERS[provider] ?? Object.keys(counts).slice(0, 4);
  const parts = keys
    .filter((key) => typeof counts[key] === "number")
    .map((key) => `${key}: ${counts[key] as number}`);
  return parts.length > 0 ? parts.join(", ") : "no counters recorded";
};

const AllegroSettingsPage = () => {
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [disconnectWarning, setDisconnectWarning] = useState<string | undefined>();
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
    setDisconnectWarning(undefined);
    try {
      // The route answers with a `warning` when it deleted the local rows but
      // could not revoke at Allegro. Nothing can retry that afterwards - the
      // tokens are gone - so the hint has to reach the operator here.
      const result = await sdk.client.fetch<{ warning?: string }>("/admin/allegro/disconnect", {
        method: "POST",
      });
      setDisconnectWarning(result?.warning);
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const connection = data?.connection;
  /**
   * The persistent reconnect banner.
   *
   * Raised from ANY provider row, because the 403 is one condition about the stored
   * token rather than a fact about a particular loop: whichever loop hit it first, the
   * remedy is the same reconnect, and the others will hit it too.
   */
  const writeScopeMissing = (data?.sync_state ?? []).some((row) => row.write_scope_missing);

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

      {disconnectWarning ? (
        <div className="px-6 py-4">
          <Alert variant="warning">{disconnectWarning}</Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <Heading level="h2">Connection</Heading>
          {connection ? (
            <StatusBadge color={connectionColor(connection)}>
              {connectionLabel(connection)}
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

            {connection.connected && connection.credentialsUnreadable ? (
              <Alert variant="error">
                The stored tokens cannot be decrypted with the current `encryptionKey`, so every
                Allegro call will fail. This happens when the key is rotated or mistyped after the
                account was connected. Restore the original key, or reconnect to store the tokens
                under the current one.
              </Alert>
            ) : null}

            {connection.connected && connection.refreshTokenMissing ? (
              <Alert variant="warning">
                The stored connection has no refresh token, so it stops working once the access
                token expires. Reconnect.
              </Alert>
            ) : null}

            {writeScopeMissing ? (
              <Alert variant="error">
                The stored token cannot write offers: Allegro answered 403 on a price or quantity
                command. No retry fixes this - reconnect Allegro so the grant includes
                <code> allegro:api:sale:offers:write</code>. Until then the write loops no-op safely
                and this banner stays up.
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
          Writers
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          Four writers reach Allegro, each with its own switch. They are listed separately because
          "price sync is off" does not mean nothing is written.
        </Text>
        <div className="flex flex-wrap gap-2">
          <KillSwitch
            disabled={data?.kill_switches.priceSyncDisabled}
            envVar="ALLEGRO_PRICE_SYNC_DISABLED"
            label="Price writes"
          />
          <KillSwitch
            disabled={data?.kill_switches.stockSyncDisabled}
            envVar="ALLEGRO_STOCK_SYNC_DISABLED"
            label="Quantity writes"
          />
          <KillSwitch
            disabled={data?.kill_switches.ordersSyncDisabled}
            envVar="ALLEGRO_ORDERS_SYNC_DISABLED"
            label="Order drain"
          />
          <KillSwitch
            disabled={data?.kill_switches.invoiceAttachDisabled}
            envVar="ALLEGRO_INVOICE_ATTACH_DISABLED"
            label="Invoice attach"
          />
        </div>
        {data && !data.options.automationRules ? (
          <Alert className="mt-4" variant="warning">
            The `automationRules` option is not configured, so price sync is inert: there are no
            rule names to attach and the plugin never invents one. Set the two rule names that
            already exist on the Allegro account.
          </Alert>
        ) : null}
        {data?.options.automationRules ? (
          <Text className="text-ui-fg-muted mt-3" size="small">
            Rules: <code>{data.options.automationRules.standard}</code> for a standard offer,{" "}
            <code>{data.options.automationRules.promoted}</code> when promoted. Both must exist on
            the Allegro account; a missing or renamed rule aborts the whole run with nothing
            written.
          </Text>
        ) : null}
        {data && !(data.options.srpMetadataKey || data.options.srpPriceListId) ? (
          <Alert className="mt-4" variant="warning">
            No SRP source is configured (`srpMetadataKey` or `srpPriceListId`), so every offer is
            skipped with reason `missing-srp`. The SRP is the price-range ceiling, and there is
            deliberately no fallback to the current selling price - that would let a rule ratchet
            the price down on every run.
          </Alert>
        ) : null}
        <Text className="text-ui-fg-muted mt-3" size="small">
          Change cap: {data?.options.changeCap ?? "-"} command(s) per price run. Marketplace:{" "}
          <code>{data?.options.marketplaceId ?? "-"}</code>. Sales channel:{" "}
          {data?.options.salesChannelId ?? data?.options.salesChannelName ?? "whole catalogue"}.
        </Text>
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <Heading className="mb-2" level="h2">
          Sync health
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          One row per loop. A row that has never run has no state yet; a loop that ran and did
          nothing still records its counters, which is how "nothing to do" stays distinguishable
          from "quietly broken".
        </Text>

        {data?.sync_state?.length ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Provider</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Last run</Table.HeaderCell>
                <Table.HeaderCell>Counters</Table.HeaderCell>
                <Table.HeaderCell>Last error</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.sync_state.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <div className="flex flex-col">
                      <span className="txt-compact-small-plus">{row.provider}</span>
                      <span className="text-ui-fg-muted txt-compact-xsmall">
                        {PROVIDER_DESCRIPTION[row.provider] ?? ""}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={SYNC_STATUS_COLOR[row.status]}>{row.status}</StatusBadge>
                  </Table.Cell>
                  <Table.Cell className="txt-compact-xsmall">
                    {formatDate(row.last_synced_at)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                    {formatCounters(row.provider, row.counts)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
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
            No sync state recorded. Each loop creates its row on its first run.
          </Text>
        )}
      </div>
    </Container>
  );
};

/**
 * One writer's switch state.
 *
 * Named after what it stops rather than after the option, because that is what an
 * operator is deciding about, and it shows the env var so the remedy is on screen.
 */
const KillSwitch = ({
  label,
  disabled,
  envVar,
}: {
  label: string;
  disabled?: boolean;
  envVar: string;
}) => (
  <div className="flex flex-col gap-y-1 rounded-lg border px-3 py-2">
    <div className="flex items-center gap-x-2">
      <StatusBadge color={disabled ? "red" : "green"}>
        {disabled ? "disabled" : "armed"}
      </StatusBadge>
      <span className="txt-compact-small-plus">{label}</span>
    </div>
    <code className="text-ui-fg-muted txt-compact-xsmall">{envVar}</code>
  </div>
);

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
