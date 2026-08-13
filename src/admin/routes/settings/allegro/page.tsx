import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  Input,
  StatusBadge,
  Switch,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { formatDate, SYNC_STATUS_COLOR } from "../../../lib/format";
import { sdk } from "../../../lib/sdk";
import type {
  AllegroSummary,
  ConfigField,
  Connection,
  OverviewResponse,
  RuntimeToggle,
  SettingsResponse,
  SummaryResponse,
} from "../../../lib/types";

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

/**
 * One configuration field by key, or undefined before the first load resolves.
 *
 * A small lookup rather than inlining `.find(...)` at each call site: the two
 * "is this inert?" banners below each need two fields, and this keeps that
 * readable.
 */
const findConfigField = (
  data: OverviewResponse | undefined,
  key: ConfigField["key"],
): ConfigField | undefined => data?.configFields.find((field) => field.key === key);

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

/** A field's stored value, as the input shows it. `null` renders as a blank input. */
const formatFieldValue = (value: string | number | null): string =>
  value === null || value === undefined ? "" : String(value);

const AllegroSettingsPage = () => {
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [summary, setSummary] = useState<AllegroSummary | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [disconnectWarning, setDisconnectWarning] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [busyToggle, setBusyToggle] = useState<string | undefined>();
  const [busyField, setBusyField] = useState<string | undefined>();
  /**
   * One text draft per configuration column, keyed by column name.
   *
   * Seeded from the persisted value on first load and left alone afterwards, so
   * editing one field does not get clobbered by a refresh triggered by saving a
   * DIFFERENT field - the same reason the category-rates page keeps its own draft
   * state rather than binding straight to the loaded rows.
   */
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});

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

  // Seeds a draft for every field the FIRST time it is seen. Skips a column already
  // present so a refresh triggered by saving field A never clobbers an in-progress,
  // unsaved edit on field B.
  useEffect(() => {
    if (!data?.configFields) {
      return;
    }
    setFieldDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const field of data.configFields) {
        if (!(field.column in next)) {
          next[field.column] = formatFieldValue(field.persistedValue);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [data?.configFields]);

  // The catalogue roll-up is best-effort: a store that does not use Allegro yet, or a
  // transient failure, just leaves the summary hidden rather than blocking the page.
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
        // Intentionally silent - the summary is a convenience, not load-bearing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleWriter = async (toggle: RuntimeToggle) => {
    // A writer the environment forces off cannot be armed from here - the switch is
    // locked - so this only ever fires for a live toggle.
    setBusyToggle(toggle.column);
    try {
      const response = await sdk.client.fetch<SettingsResponse>("/admin/allegro/settings", {
        body: { [toggle.column]: !toggle.persistedEnabled },
        method: "POST",
      });
      setData((current) =>
        current
          ? { ...current, configFields: response.configFields, toggles: response.toggles }
          : current,
      );
      toast.success(
        `${toggle.label} ${toggle.persistedEnabled ? "disarmed" : "armed"}. It takes effect on the next run.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not change ${toggle.label}.`);
    } finally {
      setBusyToggle(undefined);
    }
  };

  /**
   * Save one configuration field.
   *
   * A blank draft is sent as `null`, which CLEARS the field back to its
   * `medusa-config.ts` fallback - the same "clear" contract the category-rate save
   * already uses. `change_cap` is parsed and range-checked here too, so a bad value
   * shows a toast immediately rather than a round trip just to learn the server
   * rejected it.
   */
  const saveConfigField = async (field: ConfigField) => {
    const draft = (fieldDrafts[field.column] ?? "").trim();

    let value: string | number | null;
    if (draft === "") {
      value = null;
    } else if (field.kind === "number") {
      const parsed = Number(draft);
      if (!Number.isInteger(parsed) || parsed < 1) {
        toast.error(`${field.label} must be a positive integer.`);
        return;
      }
      value = parsed;
    } else {
      value = draft;
    }

    setBusyField(field.column);
    try {
      const response = await sdk.client.fetch<SettingsResponse>("/admin/allegro/settings", {
        body: { [field.column]: value },
        method: "POST",
      });
      setData((current) =>
        current
          ? { ...current, configFields: response.configFields, toggles: response.toggles }
          : current,
      );
      toast.success(
        value === null
          ? `${field.label} cleared. It falls back to the medusa-config.ts value.`
          : `Saved ${field.label}.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not save ${field.label}.`);
    } finally {
      setBusyField(undefined);
    }
  };

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
        <Text className="text-ui-fg-subtle mb-4" size="small">
          Every writer that reaches Allegro has its own switch, armed live from here - a flip takes
          effect on the next run, no redeploy. They are listed separately because "price sync is
          off" does not mean nothing is written. A fresh install ships with every writer disarmed;
          arm each one deliberately once you have connected and mapped your offers. A switch shown
          as forced off is held down by an environment override and cannot be armed here until the
          override is cleared.
        </Text>
        <div className="flex flex-col gap-y-3">
          {(data?.toggles ?? []).map((toggle) => (
            <WriterToggle
              busy={busyToggle === toggle.column}
              key={toggle.key}
              onToggle={() => void toggleWriter(toggle)}
              toggle={toggle}
            />
          ))}
          {data === undefined ? (
            <Text className="text-ui-fg-subtle" size="small">
              Loading...
            </Text>
          ) : null}
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Sync configuration
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          These used to be set only in `medusa-config.ts` and shown here as read-only text. Editing
          a field here persists it and takes effect on the next sync run, no redeploy. Clearing a
          field (blank it and Save) falls back to the `medusa-config.ts` value. A field shown as
          locked is pinned by an environment variable that always wins over both this admin and the
          config file.
        </Text>

        {data &&
        !(
          findConfigField(data, "automationRuleStandard")?.effectiveValue &&
          findConfigField(data, "automationRulePromoted")?.effectiveValue
        ) ? (
          <Alert className="mb-4" variant="warning">
            No two distinct automation rule names resolve yet, so price sync is inert: there are no
            rule names to attach and the plugin never invents one. Set both below, or in
            `medusa-config.ts`. Both must already exist on the Allegro account.
          </Alert>
        ) : null}
        {data &&
        !(
          findConfigField(data, "srpMetadataKey")?.effectiveValue ||
          findConfigField(data, "srpPriceListId")?.effectiveValue
        ) ? (
          <Alert className="mb-4" variant="warning">
            No SRP source resolves yet, so every offer is skipped with reason `missing-srp`. The SRP
            is the price-range ceiling, and there is deliberately no fallback to the current selling
            price - that would let a rule ratchet the price down on every run.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-y-3">
          {(data?.configFields ?? []).map((field) => (
            <ConfigFieldRow
              busy={busyField === field.column}
              draft={fieldDrafts[field.column] ?? formatFieldValue(field.persistedValue)}
              field={field}
              key={field.key}
              onChange={(value) =>
                setFieldDrafts((current) => ({ ...current, [field.column]: value }))
              }
              onSave={() => void saveConfigField(field)}
            />
          ))}
          {data === undefined ? (
            <Text className="text-ui-fg-subtle" size="small">
              Loading...
            </Text>
          ) : null}
        </div>
      </div>

      {summary && summary.total > 0 ? (
        <div className="px-6 py-4">
          <Heading className="mb-2" level="h2">
            Catalogue
          </Heading>
          <Text className="text-ui-fg-subtle mb-3" size="small">
            A roll-up of the offer mapping. The authoritative per-product view is on each product's
            own detail page; the counts here just answer "is anything wrong right now?" and link
            into the offers view filtered to the rows that need attention.
          </Text>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              className="text-ui-fg-interactive txt-compact-small"
              href="/app/settings/allegro/offers"
            >
              {summary.linked} linked
            </a>
            <Text className="text-ui-fg-subtle txt-compact-small">{summary.unlinked} unlinked</Text>
            <a
              className="flex items-center gap-x-1"
              href="/app/settings/allegro/offers?filter=drift"
            >
              <StatusBadge color={summary.drifting > 0 ? "orange" : "grey"}>
                {summary.drifting} drifting
              </StatusBadge>
            </a>
            <a
              className="flex items-center gap-x-1"
              href="/app/settings/allegro/offers?filter=conflict"
            >
              <StatusBadge color={summary.conflicts > 0 ? "red" : "grey"}>
                {summary.conflicts} conflict{summary.conflicts === 1 ? "" : "s"}
              </StatusBadge>
            </a>
          </div>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Offers and orders
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          The cross-catalogue offer table (conflict/drift filters, bulk rediscovery, manual push)
          and the orders quarantine/repair and import window are their own Settings pages, since
          they are operator task-flows rather than a single setting.
        </Text>
        <div className="flex flex-wrap gap-x-6">
          <a
            className="text-ui-fg-interactive txt-compact-small"
            href="/app/settings/allegro/offers"
          >
            Open Allegro offers
          </a>
          <a
            className="text-ui-fg-interactive txt-compact-small"
            href="/app/settings/allegro/orders"
          >
            Open Allegro orders
          </a>
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Category rates
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          The per-category sale commissions that set every price floor are configuration and live on
          their own Settings page.
        </Text>
        <a
          className="text-ui-fg-interactive txt-compact-small"
          href="/app/settings/allegro/category-rates"
        >
          Open category rates
        </a>
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
 * One writer's live switch.
 *
 * The switch reflects and controls the PERSISTED arming. When the environment forces
 * the writer off it is locked and labelled so - the switch still shows what is
 * persisted, but the "forced off" note and the disabled control say the truth about why
 * nothing runs, rather than pretending an armed writer is live. Named after what the
 * writer does, with its override env var on screen so the remedy is visible.
 */
const WriterToggle = ({
  toggle,
  busy,
  onToggle,
}: {
  toggle: RuntimeToggle;
  busy: boolean;
  onToggle: () => void;
}) => (
  <div className="flex items-start justify-between gap-x-4 rounded-lg border px-3 py-3">
    <div className="flex flex-col gap-y-1">
      <div className="flex items-center gap-x-2">
        <span className="txt-compact-small-plus">{toggle.label}</span>
        {toggle.forceDisabled ? (
          <StatusBadge color="red">forced off</StatusBadge>
        ) : (
          <StatusBadge color={toggle.effectiveEnabled ? "green" : "grey"}>
            {toggle.effectiveEnabled ? "armed" : "disarmed"}
          </StatusBadge>
        )}
      </div>
      <span className="text-ui-fg-subtle txt-compact-xsmall">{toggle.description}</span>
      {toggle.forceDisabled ? (
        <span className="text-ui-fg-muted txt-compact-xsmall">
          Forced off by the environment. Clear <code>{toggle.envVar}</code> to control it here.
        </span>
      ) : (
        <code className="text-ui-fg-muted txt-compact-xsmall">{toggle.envVar}</code>
      )}
    </div>
    <Switch
      checked={toggle.persistedEnabled}
      disabled={busy || toggle.forceDisabled}
      onCheckedChange={onToggle}
    />
  </div>
);

/**
 * One editable sync-configuration field.
 *
 * Sibling of `WriterToggle`, same shape: the input binds to the LOCAL draft (not
 * straight to the persisted value, so typing does not fire a save on every
 * keystroke), a `locked` field is disabled with the same "the environment is
 * pinning this" note a forced-off toggle gets, and a `wiringCritical` field gets
 * an extra warning ABOVE the input - re-scoping which Medusa products this
 * plugin matches against Allegro is not a tuning knob, and the input alone does
 * not say that.
 */
const ConfigFieldRow = ({
  field,
  draft,
  busy,
  onChange,
  onSave,
}: {
  field: ConfigField;
  draft: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) => (
  <div className="flex flex-col gap-y-2 rounded-lg border px-3 py-3">
    <div className="flex items-center gap-x-2">
      <span className="txt-compact-small-plus">{field.label}</span>
      {field.locked ? <StatusBadge color="red">locked by environment</StatusBadge> : null}
    </div>
    <span className="text-ui-fg-subtle txt-compact-xsmall">{field.description}</span>
    {field.wiringCritical ? (
      <Alert variant="warning">
        Changing this re-scopes which Medusa products this plugin matches against Allegro offers. A
        wrong value here breaks the mapping silently rather than merely mis-tuning a run.
      </Alert>
    ) : null}
    <div className="flex items-end gap-x-2">
      <Input
        className="max-w-sm"
        disabled={busy || field.locked}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
        placeholder={
          field.configDefault !== null ? `medusa-config.ts: ${field.configDefault}` : "not set"
        }
        type={field.kind === "number" ? "number" : "text"}
        value={draft}
      />
      <Button disabled={busy || field.locked} onClick={onSave} size="small" variant="secondary">
        Save
      </Button>
    </div>
    {field.locked ? (
      <span className="text-ui-fg-muted txt-compact-xsmall">
        Locked by the environment at <code>{field.effectiveValue}</code>. Clear{" "}
        <code>{field.envVar}</code> to control it here.
      </span>
    ) : (
      <code className="text-ui-fg-muted txt-compact-xsmall">{field.envVar}</code>
    )}
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
