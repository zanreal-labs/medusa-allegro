import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import type AllegroModuleService from "../../../../modules/allegro/service";

/**
 * The commission rates that set every price floor.
 *
 * Maintained by hand, and there is no API alternative: Allegro's fee calculator
 * (`POST /pricing/offer-fee-preview`) rejects the offer bodies a seller can build
 * from their own live offers, so a sweep over a real catalogue returns errors rather
 * than rates. Discovery creates a row for every category the catalogue references
 * with NULL rates; this route is how an operator fills them in from the published fee
 * table.
 *
 * NULL is a meaningful value here and stays writable as one. An unknown rate has to
 * remain distinguishable from a zero one, because a break-even that reads a missing
 * rate as 0% turns a loss-making price into an acceptable floor - so clearing a rate
 * back to NULL correctly makes price sync skip the category again rather than
 * flooring it at cost.
 */

/** GET /admin/allegro/category-rates */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const rates = await allegro.listAllegroCategoryRates({}, { order: { category_id: "ASC" } });
  res.json({ category_rates: rates });
}

/**
 * A rate as a percentage.
 *
 * Percentages, not fractions, because that is how Allegro publishes its fee table and
 * therefore how an operator reads it off the page. The conversion to a fraction
 * happens once, inside the break-even calculation.
 *
 * `null` clears the rate. Anything outside 0-100 is rejected: a rate of 950 (a
 * mistyped 9.5) would produce a nonsensical floor, and one at or above 100 has no
 * finite break-even at all, so it would silently skip the whole category with a
 * reason that points at the data rather than at the typo.
 */
const parseRate = (value: unknown, field: string): number | null => {
  if (value === null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field}\` must be a number or null (got "${String(value)}").`,
    );
  }
  if (parsed < 0 || parsed >= 100) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field}\` must be a percentage between 0 and 100 (got ${parsed}). A rate at or above 100% has no finite break-even.`,
    );
  }
  return parsed;
};

/**
 * POST /admin/allegro/category-rates
 *
 * `{ category_id, commission_rate?, promoted_commission_rate?, name? }`. Only the
 * keys present in the body are written, so setting one rate does not clear the other -
 * a category commonly has its standard rate filled in well before its promoted one.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const categoryId = typeof body.category_id === "string" ? body.category_id.trim() : "";
  if (!categoryId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "`category_id` is required.");
  }

  const patch: Record<string, unknown> = {};
  if ("commission_rate" in body) {
    patch.commission_rate = parseRate(body.commission_rate, "commission_rate");
  }
  if ("promoted_commission_rate" in body) {
    patch.promoted_commission_rate = parseRate(
      body.promoted_commission_rate,
      "promoted_commission_rate",
    );
  }
  if (typeof body.name === "string" && body.name.trim()) {
    patch.name = body.name.trim();
  }

  const [existing] = await allegro.listAllegroCategoryRates(
    { category_id: categoryId },
    { take: 1 },
  );
  if (existing) {
    await allegro.updateAllegroCategoryRates([
      { id: (existing as { id: string }).id, ...patch },
    ] as never);
  } else {
    // Creating from here is deliberate. Discovery only sees a category once an offer
    // references it, so an operator preparing rates ahead of a listing would otherwise
    // have nowhere to put them.
    await allegro.createAllegroCategoryRates([{ category_id: categoryId, ...patch }] as never);
  }

  const [updated] = await allegro.listAllegroCategoryRates(
    { category_id: categoryId },
    { take: 1 },
  );
  res.json({ category_rate: updated });
}
