import { buildAllegroAlert } from "../admin-notification";
import type { AllegroAlertKind } from "../admin-notification";

describe("buildAllegroAlert", () => {
  it("shapes a feed notification like core's admin feeds, with an allegro.* trigger", () => {
    const alert = buildAllegroAlert({ kind: "promotion_half_applied", resourceId: "promo_1" });
    expect(alert).toMatchObject({
      channel: "feed",
      resource_id: "promo_1",
      template: "admin-ui",
      to: "",
      trigger_type: "allegro.promotion_half_applied",
    });
    expect(alert.data.title).toBeTruthy();
    expect(alert.data.description).toBeTruthy();
  });

  it("names a trigger medusa-slack's ALERT_CLASSES already classifies, per kind", () => {
    const kinds: AllegroAlertKind[] = [
      "promotion_half_applied",
      "promotion_no_coverage",
      "write_scope_missing",
      "price_sync_systemic",
      "stock_push_failed",
    ];
    for (const kind of kinds) {
      expect(buildAllegroAlert({ kind, resourceId: "r" }).trigger_type).toBe(`allegro.${kind}`);
    }
  });

  it("describes a failed stock push as the oversell it is, not as stale data", () => {
    const alert = buildAllegroAlert({
      detail: "2 SKU(s): SKU-1, SKU-2. Reason: Allegro HTTP 429",
      kind: "stock_push_failed",
      resourceId: "stock",
    });

    expect(alert.trigger_type).toBe("allegro.stock_push_failed");
    expect(alert.data.title).toBe("Allegro stock update failed");
    // The commercial fact first - these offers may be advertising stock we do not
    // have - then the affected SKUs, then the reassurance that a sweep will fix the
    // number, so nobody hand-edits quantities while one is about to.
    expect(alert.data.description).toContain("may be advertising stock the store no longer has");
    expect(alert.data.description).toContain("SKU-1, SKU-2");
    expect(alert.data.description).toContain("reconciliation will retry");
  });

  it("keys idempotency on kind + resource, so a sweep re-raise collapses to one entry", () => {
    const a = buildAllegroAlert({ kind: "write_scope_missing", resourceId: "acct" });
    const b = buildAllegroAlert({ detail: "seen again", kind: "write_scope_missing", resourceId: "acct" });
    expect(a.idempotency_key).toBe(b.idempotency_key);
    // A different condition about the same resource must NOT collapse into it.
    const c = buildAllegroAlert({ kind: "price_sync_systemic", resourceId: "acct" });
    expect(c.idempotency_key).not.toBe(a.idempotency_key);
  });

  it("appends caller detail to the standard description when given", () => {
    const alert = buildAllegroAlert({
      detail: "3 of 10 auctions applied",
      kind: "promotion_half_applied",
      resourceId: "promo_1",
    });
    expect(alert.data.description).toContain("3 of 10 auctions applied");
  });
});
