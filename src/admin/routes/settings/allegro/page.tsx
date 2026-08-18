import { defineRouteConfig } from "@medusajs/admin-sdk";
import { LockClosedSolidMini } from "@medusajs/icons";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Select,
  StatusBadge,
  Switch,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
 * message - the detail is in the server log. This maps that closed set of
 * codes onto the `settings.callbackErrors` translation keys; an unrecognized
 * code falls back to `settings.callbackErrors.unknown`.
 */
const CALLBACK_ERROR_KEYS: Record<string, string> = {
  denied: "denied",
  exchange_failed: "exchangeFailed",
  missing_code: "missingCode",
  persist_failed: "persistFailed",
  state_mismatch: "stateMismatch",
};

const describeCallbackError = (t: TFunction, code: string): string => {
  const key = CALLBACK_ERROR_KEYS[code];
  return key
    ? t(`settings.callbackErrors.${key}`)
    : t("settings.callbackErrors.unknown", { code });
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

const connectionLabel = (t: TFunction, connection: Connection): string => {
  if (!connection.connected) {
    return t("settings.connection.status.notConnected");
  }
  return connection.credentialsUnreadable
    ? t("settings.connection.status.unreadable")
    : t("settings.connection.status.connected");
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
): ConfigField | undefined =>
  data?.configFields.find((field) => field.key === key);

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

const formatCounters = (
  t: TFunction,
  provider: string,
  counts?: Record<string, unknown> | null,
): string => {
  if (!counts) {
    return t("settings.syncHealth.noRunRecorded");
  }
  const keys = PROVIDER_COUNTERS[provider] ?? Object.keys(counts).slice(0, 4);
  const parts = keys
    .filter((key) => typeof counts[key] === "number")
    .map((key) => `${key}: ${counts[key] as number}`);
  return parts.length > 0 ? parts.join(", ") : t("settings.syncHealth.noCountersRecorded");
};

/** A field's stored value, as the input shows it. `null` renders as a blank input. */
const formatFieldValue = (value: string | number | null): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * The value a control starts on.
 *
 * A picker starts on the EFFECTIVE value, not the persisted one: there is always
 * a mode in force, and showing an empty picker on a store that has never touched
 * the setting would suggest no mode is chosen. A text box starts on the persisted
 * value, because blank there genuinely means "nothing entered here".
 */
const initialDraft = (field: ConfigField): string =>
  field.kind === "choice"
    ? formatFieldValue(field.effectiveValue)
    : formatFieldValue(field.persistedValue);

const AllegroSettingsPage = () => {
  const { t } = useTranslation("allegro");
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [summary, setSummary] = useState<AllegroSummary | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [disconnectWarning, setDisconnectWarning] = useState<
    string | undefined
  >();
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
      setLoadError(
        error instanceof Error
          ? error.message
          : t("settings.errors.loadFailed"),
      );
    }
  }, [t]);

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
          next[field.column] = initialDraft(field);
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
      const response = await sdk.client.fetch<SettingsResponse>(
        "/admin/allegro/settings",
        {
          body: { [toggle.column]: !toggle.persistedEnabled },
          method: "POST",
        },
      );
      setData((current) =>
        current
          ? {
              ...current,
              configFields: response.configFields,
              toggles: response.toggles,
            }
          : current,
      );
      toast.success(
        t(
          toggle.persistedEnabled ? "settings.writers.toastDisarmed" : "settings.writers.toastArmed",
          { label: toggle.label },
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings.writers.toastChangeFailed", { label: toggle.label }),
      );
    } finally {
      setBusyToggle(undefined);
    }
  };

  /**
   * Save one configuration field.
   *
   * A blank draft is sent as `null`, which CLEARS the field back to the default
   * the plugin was installed with - the same "clear" contract the category-rate
   * save already uses. `change_cap` is parsed and range-checked here too, so a bad
   * value shows a toast immediately rather than a round trip just to learn the
   * server rejected it.
   */
  const saveConfigField = async (field: ConfigField) => {
    const draft = (fieldDrafts[field.column] ?? "").trim();

    let value: string | number | null;
    if (draft === "") {
      value = null;
    } else if (field.kind === "number") {
      const parsed = Number(draft);
      if (!Number.isInteger(parsed) || parsed < 1) {
        toast.error(t("settings.pricing.mustBePositiveInteger", { label: field.label }));
        return;
      }
      value = parsed;
    } else {
      value = draft;
    }

    setBusyField(field.column);
    try {
      const response = await sdk.client.fetch<SettingsResponse>(
        "/admin/allegro/settings",
        {
          body: { [field.column]: value },
          method: "POST",
        },
      );
      setData((current) =>
        current
          ? {
              ...current,
              configFields: response.configFields,
              toggles: response.toggles,
            }
          : current,
      );
      toast.success(
        value === null
          ? t("settings.pricing.toastCleared", { label: field.label })
          : t("settings.pricing.toastSaved", { label: field.label }),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings.pricing.toastSaveFailed", { label: field.label }),
      );
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
      setLoadError(
        error instanceof Error
          ? error.message
          : t("settings.errors.connectFailed"),
      );
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setDisconnectWarning(undefined);
    try {
      // The route answers with a `warning` when it deleted the local rows but
      // could not revoke at Allegro. Nothing can retry that afterwards - the
      // tokens are gone - so the hint has to reach the operator here.
      const result = await sdk.client.fetch<{ warning?: string }>(
        "/admin/allegro/disconnect",
        {
          method: "POST",
        },
      );
      setDisconnectWarning(result?.warning);
      await load();
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : t("settings.errors.disconnectFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const connection = data?.connection;
  /**
   * The mode in force, read from the same resolved field the picker binds to.
   *
   * The banners below are mode-specific because the advice is: telling a
   * fixed-price store to configure two automation rule names it will never use is
   * how a settings screen teaches people to ignore its warnings.
   */
  const pricingMode = findConfigField(data, "pricingMode")?.effectiveValue;
  /**
   * The persistent reconnect banner.
   *
   * Raised from ANY provider row, because the 403 is one condition about the stored
   * token rather than a fact about a particular loop: whichever loop hit it first, the
   * remedy is the same reconnect, and the others will hit it too.
   */
  const writeScopeMissing = (data?.sync_state ?? []).some(
    (row) => row.write_scope_missing,
  );

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">{t("settings.title")}</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            {t("settings.subtitle")}
          </Text>
        </div>
        {connection?.environment ? (
          <Badge
            color={connection.environment === "sandbox" ? "orange" : "grey"}
            size="small"
          >
            {connection.environment}
          </Badge>
        ) : null}
      </div>

      {justConnected ? (
        <div className="px-6 py-4">
          <Alert variant="success">{t("settings.justConnected")}</Alert>
        </div>
      ) : null}

      {callbackError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{describeCallbackError(t, callbackError)}</Alert>
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
          <Heading level="h2">{t("settings.connection.title")}</Heading>
          {connection ? (
            <StatusBadge color={connectionColor(connection)}>
              {connectionLabel(t, connection)}
            </StatusBadge>
          ) : null}
        </div>

        {connection === undefined ? (
          <Text className="text-ui-fg-subtle" size="small">
            {t("common.loading")}
          </Text>
        ) : (
          <div className="flex flex-col gap-y-3">
            {connection.connected ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                <Field label={t("settings.connection.account")}>
                  {connection.accountLogin ?? (
                    // "unknown" read as "something went wrong". The name is
                    // missing for one specific, fixable reason: the login comes
                    // from GET /me, which Allegro refuses without
                    // `allegro:api:profile:read`, and a connection made before
                    // that scope was requested has no name stored. Everything
                    // else about the connection is fine, so say which it is.
                    <span className="text-ui-fg-subtle">
                      {t("settings.connection.accountNotStored")}
                    </span>
                  )}
                </Field>
                <Field label={t("settings.connection.connectedAt")}>
                  {formatDate(connection.connectedAt)}
                </Field>
                <Field label={t("settings.connection.tokenExpires")}>
                  {formatDate(connection.expiresAt)}
                  {connection.expired
                    ? t("settings.connection.expiredSuffix")
                    : ""}
                </Field>
                <Field label={t("settings.connection.grantedScopes")}>
                  {connection.scope ?? t("settings.connection.scopeNotReported")}
                </Field>
              </dl>
            ) : (
              <Text className="text-ui-fg-subtle" size="small">
                {t("settings.connection.notConnectedPrefix")}{" "}
                <code>{connection.scopesRequested}</code>
              </Text>
            )}

            {connection.connected && connection.credentialsUnreadable ? (
              <Alert variant="error">{t("settings.connection.credentialsUnreadableAlert")}</Alert>
            ) : null}

            {connection.connected && connection.refreshTokenMissing ? (
              <Alert variant="warning">{t("settings.connection.refreshTokenMissingAlert")}</Alert>
            ) : null}

            {writeScopeMissing ? (
              <Alert variant="error">
                {t("settings.connection.writeScopeMissingPrefix")}
                <code> allegro:api:sale:offers:write</code>.{" "}
                {t("settings.connection.writeScopeMissingSuffix")}
              </Alert>
            ) : null}

            <div className="flex gap-x-2">
              <Button
                disabled={busy}
                onClick={connect}
                variant={connection.connected ? "secondary" : "primary"}
              >
                {connection.connected
                  ? t("settings.connection.reconnectButton")
                  : t("settings.connection.connectButton")}
              </Button>
              {connection.connected ? (
                <Button disabled={busy} onClick={disconnect} variant="danger">
                  {t("settings.connection.disconnectButton")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("settings.writers.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          {t("settings.writers.description")}
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
              {t("common.loading")}
            </Text>
          ) : null}
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("settings.pricing.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          {t("settings.pricing.description")}
        </Text>

        {data &&
        pricingMode === "automation_rule" &&
        !(
          findConfigField(data, "automationRuleStandard")?.effectiveValue &&
          findConfigField(data, "automationRulePromoted")?.effectiveValue
        ) ? (
          <Alert className="mb-4" variant="warning">
            {t("settings.pricing.automationRuleWarning")}
          </Alert>
        ) : null}
        {data && pricingMode === "fixed_price" ? (
          <Alert className="mb-4" variant="info">
            {t("settings.pricing.fixedPriceInfo")}
          </Alert>
        ) : null}
        {data && pricingMode === "monitor" ? (
          <Alert className="mb-4" variant="info">
            {t("settings.pricing.monitorInfo")}
          </Alert>
        ) : null}
        {data &&
        pricingMode !== "monitor" &&
        !(
          findConfigField(data, "srpMetadataKey")?.effectiveValue ||
          findConfigField(data, "srpPriceListId")?.effectiveValue
        ) ? (
          <Alert className="mb-4" variant="warning">
            {t("settings.pricing.missingSrpWarning")}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-y-3">
          {(data?.configFields ?? []).map((field) => (
            <ConfigFieldRow
              busy={busyField === field.column}
              draft={fieldDrafts[field.column] ?? initialDraft(field)}
              field={field}
              key={field.key}
              onChange={(value) =>
                setFieldDrafts((current) => ({
                  ...current,
                  [field.column]: value,
                }))
              }
              onSave={() => void saveConfigField(field)}
            />
          ))}
          {data === undefined ? (
            <Text className="text-ui-fg-subtle" size="small">
              {t("common.loading")}
            </Text>
          ) : null}
        </div>
      </div>

      {summary && summary.total > 0 ? (
        <div className="px-6 py-4">
          <Heading className="mb-2" level="h2">
            {t("settings.catalogue.title")}
          </Heading>
          <Text className="text-ui-fg-subtle mb-3" size="small">
            {t("settings.catalogue.description")}
          </Text>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              className="text-ui-fg-interactive txt-compact-small"
              href="/app/settings/allegro/offers"
            >
              {t("common.counts.linked", { count: summary.linked })}
            </a>
            <Text className="text-ui-fg-subtle txt-compact-small">
              {t("common.counts.unlinked", { count: summary.unlinked })}
            </Text>
            <a
              className="flex items-center gap-x-1"
              href="/app/settings/allegro/offers?filter=drift"
            >
              <StatusBadge color={summary.drifting > 0 ? "orange" : "grey"}>
                {t("common.counts.drifting", { count: summary.drifting })}
              </StatusBadge>
            </a>
            <a
              className="flex items-center gap-x-1"
              href="/app/settings/allegro/offers?filter=conflict"
            >
              <StatusBadge color={summary.conflicts > 0 ? "red" : "grey"}>
                {t("common.counts.conflict", { count: summary.conflicts })}
              </StatusBadge>
            </a>
          </div>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("settings.offersOrders.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          {t("settings.offersOrders.description")}
        </Text>
        <div className="flex flex-wrap gap-x-6">
          <a
            className="text-ui-fg-interactive txt-compact-small"
            href="/app/settings/allegro/offers"
          >
            {t("settings.offersOrders.openOffers")}
          </a>
          <a
            className="text-ui-fg-interactive txt-compact-small"
            href="/app/settings/allegro/orders"
          >
            {t("settings.offersOrders.openOrders")}
          </a>
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("settings.categoryRatesSection.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-3" size="small">
          {t("settings.categoryRatesSection.description")}
        </Text>
        <a
          className="text-ui-fg-interactive txt-compact-small"
          href="/app/settings/allegro/category-rates"
        >
          {t("settings.categoryRatesSection.openLink")}
        </a>
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("settings.syncHealth.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-4" size="small">
          {t("settings.syncHealth.description")}
        </Text>

        {data?.sync_state?.length ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("settings.syncHealth.table.provider")}</Table.HeaderCell>
                <Table.HeaderCell>{t("settings.syncHealth.table.status")}</Table.HeaderCell>
                <Table.HeaderCell>{t("settings.syncHealth.table.lastRun")}</Table.HeaderCell>
                <Table.HeaderCell>{t("settings.syncHealth.table.counters")}</Table.HeaderCell>
                <Table.HeaderCell>{t("settings.syncHealth.table.lastError")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.sync_state.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <div className="flex flex-col">
                      <span className="txt-compact-small-plus">
                        {row.provider}
                      </span>
                      <span className="text-ui-fg-muted txt-compact-xsmall">
                        {t(`settings.syncHealth.providerDescription.${row.provider}`, {
                          defaultValue: "",
                        })}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={SYNC_STATUS_COLOR[row.status]}>
                      {row.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell className="txt-compact-xsmall">
                    {formatDate(row.last_synced_at)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                    {formatCounters(t, row.provider, row.counts)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle txt-compact-xsmall">
                    {row.write_scope_missing
                      ? t("settings.syncHealth.writeScopeMissingCell")
                      : (row.last_error ?? "-")}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <Text className="text-ui-fg-muted" size="small">
            {t("settings.syncHealth.empty")}
          </Text>
        )}
      </div>
    </Container>
  );
};

/**
 * The one line shown when, and only when, something is being held from outside
 * this screen.
 *
 * An override is an exceptional state, not a caption. A variable name printed
 * under every control is a deployment detail leaking into a product surface: it
 * tells someone whose settings are working perfectly about a variable they have
 * no reason to touch, and it buries the one case where the name IS the remedy.
 * So the name appears here - in the locked state, next to the sentence that
 * explains what the lock is doing - and nowhere else.
 */
const OverrideLock = ({
  children,
  envVar,
}: {
  children: React.ReactNode;
  envVar: string;
}) => {
  const { t } = useTranslation("allegro");
  return (
    <div className="text-ui-fg-muted txt-compact-xsmall flex items-start gap-x-1.5">
      <LockClosedSolidMini className="text-ui-fg-muted mt-0.5 shrink-0" />
      <span>
        {children} {t("common.overrideLock.prefix")} <code>{envVar}</code>{" "}
        {t("common.overrideLock.suffix")}
      </span>
    </div>
  );
};

/**
 * One writer's live switch.
 *
 * The switch reflects and controls the PERSISTED arming. When something outside
 * this screen forces the writer off it is locked and says so - the switch still
 * shows what is persisted, but the lock and the disabled control tell the truth
 * about why nothing runs, rather than pretending an armed writer is live.
 */
const WriterToggle = ({
  toggle,
  busy,
  onToggle,
}: {
  toggle: RuntimeToggle;
  busy: boolean;
  onToggle: () => void;
}) => {
  const { t } = useTranslation("allegro");
  return (
    <div className="flex items-start justify-between gap-x-4 rounded-lg border px-3 py-3">
      <div className="flex flex-col gap-y-1">
        <div className="flex items-center gap-x-2">
          <span className="txt-compact-small-plus">{toggle.label}</span>
          {toggle.forceDisabled ? (
            <StatusBadge color="red">{t("settings.writers.forcedOffBadge")}</StatusBadge>
          ) : (
            <StatusBadge color={toggle.effectiveEnabled ? "green" : "grey"}>
              {toggle.effectiveEnabled
                ? t("settings.writers.armedBadge")
                : t("settings.writers.disarmedBadge")}
            </StatusBadge>
          )}
        </div>
        <span className="text-ui-fg-subtle txt-compact-xsmall">
          {toggle.description}
        </span>
        {toggle.forceDisabled ? (
          <OverrideLock envVar={toggle.envVar}>
            {t("settings.writers.forcedOffText")}
          </OverrideLock>
        ) : null}
      </div>
      <Switch
        checked={toggle.persistedEnabled}
        disabled={busy || toggle.forceDisabled}
        onCheckedChange={onToggle}
      />
    </div>
  );
};

/**
 * One editable sync-configuration field.
 *
 * Sibling of `WriterToggle`, same shape: the control binds to the LOCAL draft (not
 * straight to the persisted value, so typing does not fire a save on every
 * keystroke), a `locked` field is disabled with the same lock a forced-off toggle
 * gets, and a `wiringCritical` field gets an extra warning ABOVE the control -
 * re-scoping which Medusa products this plugin matches against Allegro is not a
 * tuning knob, and an input alone does not say that.
 *
 * A `choice` field renders a picker rather than a text box, and one deliberate
 * difference follows from that: it has no blank state and therefore no "clear"
 * path. Every option carries a real value, because a `Select.Item` with an empty
 * value crashes the page on mount - and because "no pricing mode" is not a state
 * this plugin can be in.
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
}) => {
  const { t } = useTranslation("allegro");
  const chosen = field.choices?.find((choice) => choice.value === draft);
  return (
    <div className="flex flex-col gap-y-2 rounded-lg border px-3 py-3">
      <div className="flex items-center gap-x-2">
        <span className="txt-compact-small-plus">{field.label}</span>
        {field.locked ? (
          <StatusBadge color="red">{t("settings.pricing.lockedBadge")}</StatusBadge>
        ) : null}
      </div>
      <span className="text-ui-fg-subtle txt-compact-xsmall">
        {field.description}
      </span>
      {field.wiringCritical ? (
        <Alert variant="warning">{t("settings.pricing.wiringCriticalWarning")}</Alert>
      ) : null}
      <div className="flex items-end gap-x-2">
        {field.kind === "choice" ? (
          <Select
            disabled={busy || field.locked}
            onValueChange={onChange}
            value={draft}
          >
            <Select.Trigger className="max-w-sm">
              <Select.Value placeholder={t("settings.pricing.choosePlaceholder")} />
            </Select.Trigger>
            <Select.Content>
              {(field.choices ?? []).map((choice) => (
                <Select.Item key={choice.value} value={choice.value}>
                  {choice.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        ) : (
          <Input
            className="max-w-sm"
            disabled={busy || field.locked}
            onChange={(changeEvent) => onChange(changeEvent.target.value)}
            placeholder={t("settings.pricing.leaveBlankPlaceholder")}
            type={field.kind === "number" ? "number" : "text"}
            value={draft}
          />
        )}
        <Button
          disabled={busy || field.locked}
          onClick={onSave}
          size="small"
          variant="secondary"
        >
          {t("common.save")}
        </Button>
      </div>
      {chosen ? (
        <span className="text-ui-fg-subtle txt-compact-xsmall">
          {chosen.description}
        </span>
      ) : null}
      {field.locked ? (
        <OverrideLock envVar={field.envVar}>
          {t("settings.pricing.lockedTextPrefix")} <code>{field.effectiveValue}</code>{" "}
          {t("settings.pricing.lockedTextSuffix")}
        </OverrideLock>
      ) : null}
    </div>
  );
};

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <dt className="text-ui-fg-muted txt-compact-small">{label}</dt>
    <dd className="txt-compact-small">{children}</dd>
  </div>
);

export const config = defineRouteConfig({
  label: "settings.title",
  translationNs: "allegro",
});

export default AllegroSettingsPage;
