import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * GET /admin/allegro/offers
 *
 * The offer mapping table. Query parameters:
 *
 * - `conflict=1` - only rows carrying an unresolved mapping conflict.
 * - `drift=1` - only rows whose automation state drifts from the expected rule.
 * - `q` - a SKU substring.
 * - `limit` / `offset` - pagination, capped so a catalogue-sized response cannot be
 *   requested by accident.
 *
 * `conflict` and `drift` are the two filters worth having as first-class flags:
 * they are the two states that mean "part of this catalogue is not being synced",
 * and both are invisible in a page-by-page scan of a large table.
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
    // `$ne: null` rather than listing the four codes: a code added later must show up
    // in this filter without anyone remembering to update it.
    filters.conflict = { $ne: null };
  }
  if (isTruthyFlag(query.drift)) {
    filters.price_automation_drift = true;
  }
  const search = typeof query.q === "string" ? query.q.trim() : "";
  if (search) {
    filters.sku = { $ilike: `%${search}%` };
  }

  const [offers, count] = await allegro.listAndCountAllegroOffers(filters, {
    order: { sku: "ASC" },
    skip: offset,
    take: limit,
  });

  res.json({ count, limit, offers, offset });
}
