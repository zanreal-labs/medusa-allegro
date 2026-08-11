import type { AllegroAppIdentity } from "./types";

const SEGMENT_BLOCKLIST = /[\s()<>@,;:\\"/[\]?={}]/u;

const requireField = (
  value: string | undefined,
  field: keyof AllegroAppIdentity,
  context: string,
): string => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new Error(
      `${context}: ${field} is required. Allegro mandates a custom User-Agent identifying your app - provide appName, appVersion, and docsUrl.`,
    );
  }
  return trimmed;
};

const assertValidDocsUrl = (url: string, context: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}: docsUrl must be a valid absolute URL (got "${url}").`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${context}: docsUrl must use http(s) protocol (got "${parsed.protocol}").`);
  }
  return parsed.toString();
};

const assertTokenSafe = (value: string, field: string, context: string): void => {
  if (SEGMENT_BLOCKLIST.test(value)) {
    throw new Error(
      `${context}: ${field} contains characters that are not valid in a User-Agent token (whitespace or HTTP separators).`,
    );
  }
};

/**
 * Build the Allegro-mandated User-Agent string from app identity fields.
 *
 * Format: `<appName>/<appVersion> (+<docsUrl>)`
 *
 * The `+` prefix on the docs URL is mandated by Allegro (see allegro-api#13126);
 * their User-Agent validator rejects the parenthetical without it.
 *
 * Throws on missing or malformed fields so apps cannot silently fall back to
 * runtime defaults (which Allegro rejects).
 */
export const buildAllegroUserAgent = (
  identity: AllegroAppIdentity,
  context = "Allegro SDK",
): string => {
  const appName = requireField(identity.appName, "appName", context);
  const appVersion = requireField(identity.appVersion, "appVersion", context);
  const docsUrl = assertValidDocsUrl(requireField(identity.docsUrl, "docsUrl", context), context);
  assertTokenSafe(appName, "appName", context);
  assertTokenSafe(appVersion, "appVersion", context);
  return `${appName}/${appVersion} (+${docsUrl})`;
};
