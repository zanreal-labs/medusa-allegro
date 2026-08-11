import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { importAllegroOrdersWindow } from "../../../../../workflows/import-allegro-orders-window";

/**
 * POST /admin/allegro/orders/import
 *
 * `{ "since": "<iso>", "until"?: "<iso>", "page_limit"?: n, "max_pages"?: n }`.
 *
 * The only route to an order the event journal never named. Allegro retains roughly
 * 60 days of events, so a drain disabled longer than that, a restored or fresh
 * database, or a lost cursor all leave orders otherwise unreachable - and a new
 * installation deliberately bootstraps its cursor without consuming anything, so this
 * is also how history is brought in.
 *
 * The window is bounded and chosen by the operator rather than being a cursor that
 * drifts. It never moves the event cursor: an import fills a gap BEHIND it, and moving
 * it would skip live events the drain has not consumed.
 */

/** A timestamp Allegro will accept, and that is not obviously a mistake. */
const parseTimestamp = (value: unknown, field: string, required: boolean): string | undefined => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`${field}\` is required and must be an ISO timestamp.`,
      );
    }
    return undefined;
  }
  const raw = String(value);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field}\` must be an ISO timestamp (got "${raw}").`,
    );
  }
  return new Date(parsed).toISOString();
};

const parseBoundedInt = (
  value: unknown,
  field: string,
  { max, min }: { min: number; max: number },
): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field}\` must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
};

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const since = parseTimestamp(body.since, "since", true) as string;
  const until = parseTimestamp(body.until, "until", false);
  if (until && Date.parse(until) <= Date.parse(since)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`until` must be later than `since`, otherwise the window is empty.",
    );
  }

  const result = await importAllegroOrdersWindow(req.scope, {
    // Capped: one invocation holds the orders claim for its whole duration, which
    // blocks the per-minute drain from importing anything new in the meantime. A large
    // import is several calls with a moving `since`, not one unbounded run.
    maxPages: parseBoundedInt(body.max_pages, "max_pages", { max: 100, min: 1 }),
    pageLimit: parseBoundedInt(body.page_limit, "page_limit", { max: 100, min: 1 }),
    since,
    ...(until ? { until } : {}),
  });

  res.json(result);
}
