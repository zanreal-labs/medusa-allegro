import {
  ADMIN_FEED_CHANNEL,
  ADMIN_FEED_TEMPLATE,
  STOCK_PUSH_FAILED_TRIGGER,
  buildStockPushFailedNotification,
  summarizeSkus,
} from "../stock-notify";

describe("buildStockPushFailedNotification", () => {
  it("names the affected SKUs and says what the operator should conclude", () => {
    const notification = buildStockPushFailedNotification({
      now: 0,
      reason: "Allegro HTTP 429",
      skus: ["SKU-1", "SKU-2"],
    });

    expect(notification.channel).toBe(ADMIN_FEED_CHANNEL);
    expect(notification.template).toBe(ADMIN_FEED_TEMPLATE);
    expect(notification.trigger_type).toBe(STOCK_PUSH_FAILED_TRIGGER);
    expect(notification.data.title).toBe("Allegro stock update failed");
    // The commercial fact, not the internal loop: these products may be advertising a
    // quantity they no longer have.
    expect(notification.data.description).toContain("SKU-1, SKU-2");
    expect(notification.data.description).toContain("Allegro HTTP 429");
    // And the fallback, so nobody hand-edits quantities while a sweep is about to fix
    // them.
    expect(notification.data.description).toContain("reconciliation will retry");
  });

  it("keeps re-alerting while a fault lasts, instead of deduping itself into silence", () => {
    const skus = ["SKU-1"];
    const first = buildStockPushFailedNotification({ bucketMs: 1000, now: 0, reason: "x", skus });
    const same = buildStockPushFailedNotification({ bucketMs: 1000, now: 999, reason: "x", skus });
    const later = buildStockPushFailedNotification({ bucketMs: 1000, now: 1000, reason: "x", skus });

    // Medusa dedupes permanently on the key, so a key without a time bucket would alert
    // once and then go quiet for as long as the oversell window stayed open.
    expect(same.idempotency_key).toBe(first.idempotency_key);
    expect(later.idempotency_key).not.toBe(first.idempotency_key);
  });

  it("keys on the SKU SET, however the events that dirtied it were ordered", () => {
    const a = buildStockPushFailedNotification({ now: 0, reason: "x", skus: ["B", "A"] });
    const b = buildStockPushFailedNotification({ now: 0, reason: "x", skus: ["A", "B"] });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});

describe("summarizeSkus", () => {
  it("elides a bulk movement rather than printing an unreadable list", () => {
    expect(summarizeSkus(["A", "B", "C"], 2)).toBe("A, B and 1 more");
    expect(summarizeSkus(["A", "B"], 2)).toBe("A, B");
  });
});
