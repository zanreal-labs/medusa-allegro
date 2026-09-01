import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";
import { resolveOfferEconomics } from "../../../../workflows/lib/offer-economics";
import type { EconomicsOfferRow } from "../../../../workflows/lib/offer-economics";

/**
 * GET /admin/allegro/offers
 *
 * The offer mapping table. Query parameters:
 *
 * - `conflict=1` - only rows carrying an unresolved mapping conflict.
 * - `drift=1` - only rows whose automation state drifts from the expected rule.
 * - `skus` - an exact set of SKUs (repeatable, `?skus=A&skus=B`), used by the
 *   product-detail widget to fetch just the offers for one product's variants.
 *   Takes precedence over `q`.
 * - `economics=1` - enrich every returned row with what it earns at its live
 *   price: purchase cost, Allegro commission and the resulting margin. Opt-in,
 *   because it costs two extra bulk reads (the category-rate table and the
 *   costs plugin) that the settings table and the product-detail widget do not
 *   need. Without the flag the response is byte-identical to what it always
 *   was.
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
  // An exact SKU set beats a substring search: the product-detail widget asks
  // for precisely its variants' SKUs, and an `$ilike` would pull in unrelated
  // offers that merely contain one of them as a substring.
  const skus = Array.isArray(query.skus)
    ? query.skus.map(String)
    : (typeof query.skus === "string"
      ? [query.skus]
      : []);
  const search = typeof query.q === "string" ? query.q.trim() : "";
  if (skus.length > 0) {
    filters.sku = skus;
  } else if (search) {
    // `%`, `_` and `\` are LIKE metacharacters, so an unescaped search term is a pattern
    // rather than a substring: a lone `%` matched every SKU in the catalogue, and `_` matched
    // any single character. Escaping makes the parameter mean what the UI says it means.
    // `\` goes first, or it would double-escape the escapes added after it.
    const escaped = search.replaceAll('\\', "\\\\").replaceAll(/[%_]/gu, (char) => `\\${char}`);
    filters.sku = { $ilike: `%${escaped}%` };
  }

  const [offers, count] = await allegro.listAndCountAllegroOffers(filters, {
    order: { sku: "ASC" },
    skip: offset,
    take: limit,
  });

  if (!isTruthyFlag(query.economics)) {
    res.json({ count, limit, offers, offset });
    return;
  }

  // Resolved for the whole page in two bulk reads, then attached per row. A
  // row whose economics cannot be worked out still comes back - with the
  // fields it could resolve and the rest absent - so a caller can say WHICH
  // input is missing rather than rendering an undifferentiated blank.
  const economicsBySku = await resolveOfferEconomics(
    req.scope,
    offers as unknown as EconomicsOfferRow[],
  );
  res.json({
    count,
    limit,
    offers: (offers as Record<string, unknown>[]).map((offer) => ({
      ...offer,
      economics: economicsBySku.get(offer.sku as string) ?? {},
    })),
    offset,
  });
}
