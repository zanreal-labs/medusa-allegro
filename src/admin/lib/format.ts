import type { PricePushRow, SyncStatus } from "./types";

/** Shared formatting for the Allegro admin pages. */

export const formatDate = (value?: string | null): string => {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
};

/** How long ago, for a quarantine entry where the age is the actionable part. */
export const formatAge = (value?: string | null): string => {
  if (!value) {
    return "unknown";
  }
  const then = Date.parse(value);
  if (!Number.isFinite(then)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
};

export const SYNC_STATUS_COLOR: Record<SyncStatus, "green" | "orange" | "red" | "grey"> = {
  error: "red",
  idle: "grey",
  ok: "green",
  running: "orange",
};

/**
 * A rate as an operator typed it: a percentage, or a blank for "not set".
 *
 * The blank matters. An unset rate is not 0% - it is the reason price sync skips the
 * category - so rendering it as "0" would tell the operator the opposite of the truth.
 */
export const formatRate = (value?: number | string | null): string => {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
};

/** Human label for a mapping conflict code. */
export const CONFLICT_LABEL: Record<string, string> = {
  "duplicate-sku": "Duplicate SKU",
  "missing-external-id": "No sygnatura",
  "no-offer": "Offer gone",
  "no-variant": "No variant",
  "sku-mismatch": "SKU mismatch",
};

/**
 * Badge colour for an observed price mode. Shared by the offers page and the
 * product-detail widget so the same state reads the same way on both.
 */
export const PRICE_MODE_COLOR: Record<string, "green" | "orange" | "red" | "grey" | "blue"> = {
  automated: "green",
  ended: "grey",
  fixed: "orange",
  paused: "orange",
  unknown: "grey",
};

/** Badge colour for a push-history result. */
export const PUSH_RESULT_COLOR: Record<
  PricePushRow["result"],
  "green" | "orange" | "red" | "grey"
> = {
  failed: "red",
  observed: "grey",
  skipped: "orange",
  success: "green",
};
