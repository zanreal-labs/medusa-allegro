import {
  DEFAULT_STOCK_SYNC_INTERVAL_MS,
  resolveStockSyncSchedule,
} from "../allegro-stock-sync";

describe("resolveStockSyncSchedule", () => {
  it("defaults to the 15-minute reconciliation cadence, unchanged", () => {
    // The plumbing makes a faster cadence EXPRESSIBLE; it does not choose one. Changing
    // this number is a decision about request budget, taken on its own.
    expect(resolveStockSyncSchedule({})).toEqual({
      interval: DEFAULT_STOCK_SYNC_INTERVAL_MS,
    });
    expect(DEFAULT_STOCK_SYNC_INTERVAL_MS).toBe(900_000);
  });

  it("honours a positive ALLEGRO_STOCK_SYNC_INTERVAL_MS override", () => {
    expect(resolveStockSyncSchedule({ ALLEGRO_STOCK_SYNC_INTERVAL_MS: "120000" })).toEqual({
      interval: 120_000,
    });
  });

  it("falls back to the default on a non-numeric or non-positive interval", () => {
    expect(resolveStockSyncSchedule({ ALLEGRO_STOCK_SYNC_INTERVAL_MS: "soon" })).toEqual({
      interval: DEFAULT_STOCK_SYNC_INTERVAL_MS,
    });
    expect(resolveStockSyncSchedule({ ALLEGRO_STOCK_SYNC_INTERVAL_MS: "0" })).toEqual({
      interval: DEFAULT_STOCK_SYNC_INTERVAL_MS,
    });
  });

  it("keeps an existing cron working, and lets it win", () => {
    // Every store already setting the cron - the shipped `.env.template` does - keeps
    // exactly the behaviour it has today.
    expect(
      resolveStockSyncSchedule({
        ALLEGRO_STOCK_SYNC_CRON: "*/15 * * * *",
        ALLEGRO_STOCK_SYNC_INTERVAL_MS: "5000",
      }),
    ).toEqual({ cron: "*/15 * * * *" });
  });
});
