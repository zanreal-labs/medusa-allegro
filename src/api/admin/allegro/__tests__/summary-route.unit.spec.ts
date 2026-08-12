import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { GET } from "../summary/route";

/**
 * The offer roll-up behind the product-list status widget. What is worth
 * asserting is the count-to-filter mapping (linked is offer_id != null, not a
 * status string) and that `unlinked` is derived, never queried, so it can never
 * disagree with `total - linked`.
 */

interface Counts {
  total: number;
  linked: number;
  drifting: number;
  conflicts: number;
}

const harness = (counts: Counts) => {
  const countFor = (filters: Record<string, unknown>): number => {
    if (filters.offer_id) {
      return counts.linked;
    }
    if (filters.price_automation_drift) {
      return counts.drifting;
    }
    if (filters.conflict) {
      return counts.conflicts;
    }
    return counts.total;
  };

  const service = {
    listAndCountAllegroOffers: (filters: Record<string, unknown> = {}) =>
      Promise.resolve([[], countFor(filters)]),
  };

  const bodies: unknown[] = [];
  const res = { json: (body: unknown) => bodies.push(body) } as unknown as MedusaResponse;
  const req = {
    scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : undefined) },
  } as unknown as MedusaRequest;

  return { bodies, req, res };
};

describe("GET /admin/allegro/summary", () => {
  it("rolls up linked / drifting / conflicts and derives unlinked", async () => {
    const h = harness({ conflicts: 1, drifting: 2, linked: 7, total: 10 });

    await GET(h.req, h.res);

    expect(h.bodies[0]).toEqual({
      summary: { conflicts: 1, drifting: 2, linked: 7, total: 10, unlinked: 3 },
    });
  });

  it("never reports a negative unlinked count", async () => {
    // A transient race between the total and linked counts must not surface as
    // "-2 unlinked"; the derived figure floors at zero.
    const h = harness({ conflicts: 0, drifting: 0, linked: 5, total: 3 });

    await GET(h.req, h.res);

    expect((h.bodies[0] as { summary: { unlinked: number } }).summary.unlinked).toBe(0);
  });
});
