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

/**
 * A margin as one compact label: `KWOTA (PROCENT)`, e.g. `"42,10 zł (27%)"`.
 *
 * The shape the owner asked for verbatim, and one helper rather than two call
 * sites gluing strings because the amount and the percentage are two readings
 * of the same fact - they have to round and localise together everywhere they
 * appear (the Catalog column, the product card, the variant card).
 *
 * Deliberately without the anchor price. With margins sitting beside a price
 * column the anchor is implied, and repeating it is exactly the "za dużo
 * zbędnych informacji" this admin is being trimmed of.
 *
 * `Intl` formats the money so it follows the admin's own locale rather than
 * this plugin inventing a symbol table, and falls back to `"12.34 PLN"` for a
 * currency it will not accept. The percentage is a whole number on purpose: a
 * trailing decimal reads as noise in a dense column.
 */
export const formatMarginLabel = (
  amount: number | undefined,
  fraction: number | undefined,
  currency: string | null,
  /** BCP 47 tag; defaults to the runtime's locale. */
  locale?: string,
): string => {
  if (
    amount === undefined ||
    !Number.isFinite(amount) ||
    fraction === undefined ||
    !Number.isFinite(fraction)
  ) {
    return "-";
  }
  return `${formatMoney(amount, currency, locale)} (${formatPercentCompact(fraction, locale)})`;
};

/** Money in the admin's locale, falling back to `"12.34 XYZ"` for a currency `Intl` rejects. */
export const formatMoney = (
  amount: number,
  currency: string | null,
  locale?: string,
): string => {
  const code = (currency ?? "").trim().toUpperCase();
  // `Intl` throws a RangeError on anything that is not a well-formed ISO 4217
  // code, and an offer legitimately can carry no currency, so the throw is a
  // normal path rather than an exceptional one.
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(locale, { currency: code, style: "currency" }).format(amount);
    } catch {
      // Fall through to the plain rendering below.
    }
  }
  const plain = amount.toFixed(2);
  return code ? `${plain} ${code}` : plain;
};

/** A ratio as a whole-number percentage (`0.271` -> `"27%"`), in the admin's locale. */
export const formatPercentCompact = (fraction: number, locale?: string): string => {
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      style: "percent",
    }).format(fraction);
  } catch {
    return `${Math.round(fraction * 100)}%`;
  }
};
