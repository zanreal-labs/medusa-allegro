import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ALLEGRO_SYNC_PROVIDERS } from "../../../../modules/allegro/service";
import { runOfferDiscovery } from "../../../../workflows/discover-allegro-offers";
import { drainAllegroOrders } from "../../../../workflows/drain-allegro-orders";
import { pushAllegroStock } from "../../../../workflows/push-allegro-stock";
import { runPriceAutomationMonitor } from "../../../../workflows/run-price-automation-monitor";
import { syncAllegroPrices } from "../../../../workflows/sync-allegro-prices";

/**
 * POST /admin/allegro/sync
 *
 * `{ "provider": "offers" | "price-automation" | "prices" | "stock" | "orders" }`.
 * Runs one loop now.
 *
 * Safe to press at any time, and safe to press twice: every loop takes the same
 * single-flight claim its schedule does, so a manual run colliding with a scheduled
 * one is reported as retryable rather than interleaving with it. The kill switches
 * still apply - a manual run is not an override, because the switch exists to stop
 * writes and a button is not a reason to make them.
 *
 * Answers 200 with the loop's own summary, including for a skip. Each loop's summary
 * already distinguishes "did nothing because disabled" from "did nothing because there
 * was nothing to do", which is exactly what an operator pressing this needs to see.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { provider?: unknown };
  const provider = typeof body.provider === "string" ? body.provider : "";

  switch (provider) {
    case ALLEGRO_SYNC_PROVIDERS.OFFERS: {
      const { result } = await runOfferDiscovery(req.scope);
      res.json({ provider, result });
      return;
    }
    case ALLEGRO_SYNC_PROVIDERS.PRICE_AUTOMATION: {
      res.json({ provider, result: await runPriceAutomationMonitor(req.scope) });
      return;
    }
    case ALLEGRO_SYNC_PROVIDERS.PRICES: {
      res.json({ provider, result: await syncAllegroPrices(req.scope) });
      return;
    }
    case ALLEGRO_SYNC_PROVIDERS.STOCK: {
      res.json({ provider, result: await pushAllegroStock(req.scope) });
      return;
    }
    case ALLEGRO_SYNC_PROVIDERS.ORDERS: {
      res.json({ provider, result: await drainAllegroOrders(req.scope) });
      return;
    }
    default: {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `\`provider\` must be one of: ${Object.values(ALLEGRO_SYNC_PROVIDERS).join(", ")}.`,
      );
    }
  }
}
