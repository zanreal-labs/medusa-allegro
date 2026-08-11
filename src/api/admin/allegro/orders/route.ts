import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listQuarantined } from "../../../../lib/sync/failure-state";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { ALLEGRO_SYNC_PROVIDERS } from "../../../../modules/allegro/service";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * GET /admin/allegro/orders
 *
 * The orders-sync surface: the bookkeeping rows, plus the quarantined checkout forms
 * read off the state row.
 *
 * The quarantine list is the important half. A quarantined order was SKIPPED so the
 * event cursor could keep moving, which is the right trade only while it stays
 * visible - and it is only durably visible here, because a run summary vanishes on the
 * next render. Each entry carries the error and how long it has been failing, so an
 * operator can decide between repairing it and importing a window.
 *
 * Query parameters: `conflict=1` for orders with an unmapped line, `error=1` for
 * orders carrying a last error, `totalMismatch=1` for orders whose Medusa total disagrees
 * with what Allegro says the buyer paid, plus `limit` / `offset`.
 *
 * `totalMismatchCount` is returned unconditionally, alongside the quarantine list and for
 * the same reason: a disputed total is a standing to-do that no run summary preserves, and an
 * operator has to be able to see there IS one without already filtering for it.
 */

const MAX_LIMIT = 200;

const parsePositiveInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
};

const isTruthyFlag = (value: unknown): boolean =>
  value === "1" || value === "true" || value === "yes";

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const query = req.query as Record<string, unknown>;

  const limit = parsePositiveInt(query.limit, 50, MAX_LIMIT);
  const offset = parsePositiveInt(query.offset, 0, Number.MAX_SAFE_INTEGER);

  const filters: Record<string, unknown> = {};
  if (isTruthyFlag(query.conflict)) {
    filters.line_conflicts = { $ne: null };
  }
  if (isTruthyFlag(query.error)) {
    filters.last_error = { $ne: null };
  }
  if (isTruthyFlag(query.totalMismatch)) {
    // `$ne: null` rather than naming the code, so a code added later shows up here without
    // anyone remembering to update the filter.
    filters.conflict = { $ne: null };
  }

  const [state, [orders, count], totalMismatchCount] = await Promise.all([
    allegro.getSyncState(ALLEGRO_SYNC_PROVIDERS.ORDERS),
    allegro.listAndCountAllegroOrders(filters, {
      // Newest event first: the orders somebody is looking for are the recent ones.
      order: { last_event_at: "DESC" },
      skip: offset,
      take: limit,
    }),
    allegro.listAndCountAllegroOrders({ conflict: { $ne: null } }, { take: 0 }).then(
      ([, mismatches]) => mismatches,
    ),
  ]);

  res.json({
    count,
    cursor: state?.cursor ?? null,
    last_error: state?.last_error ?? null,
    last_synced_at: state?.last_synced_at ?? null,
    limit,
    offset,
    orders,
    quarantined: listQuarantined(state?.failures),
    status: state?.status ?? "idle",
    totalMismatchCount,
  });
}
