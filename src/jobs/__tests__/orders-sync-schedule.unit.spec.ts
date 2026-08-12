import { DEFAULT_ORDERS_SYNC_INTERVAL_MS, resolveOrdersSyncSchedule } from "../allegro-orders-sync";

describe("resolveOrdersSyncSchedule", () => {
  it("defaults to a 20s interval, so a fresh order is drained sub-minute", () => {
    expect(resolveOrdersSyncSchedule({})).toEqual({
      interval: DEFAULT_ORDERS_SYNC_INTERVAL_MS,
    });
    expect(DEFAULT_ORDERS_SYNC_INTERVAL_MS).toBe(20_000);
  });

  it("honours a positive ALLEGRO_ORDERS_SYNC_INTERVAL_MS override", () => {
    expect(resolveOrdersSyncSchedule({ ALLEGRO_ORDERS_SYNC_INTERVAL_MS: "5000" })).toEqual({
      interval: 5000,
    });
  });

  it("falls back to the default on a non-numeric or non-positive interval", () => {
    // A nonsensical value must not schedule a nonsensical cadence.
    expect(resolveOrdersSyncSchedule({ ALLEGRO_ORDERS_SYNC_INTERVAL_MS: "nope" })).toEqual({
      interval: DEFAULT_ORDERS_SYNC_INTERVAL_MS,
    });
    expect(resolveOrdersSyncSchedule({ ALLEGRO_ORDERS_SYNC_INTERVAL_MS: "0" })).toEqual({
      interval: DEFAULT_ORDERS_SYNC_INTERVAL_MS,
    });
  });

  it("switches to a cron expression when ALLEGRO_ORDERS_SYNC_CRON is set, and it wins", () => {
    // The two are mutually exclusive in Medusa's scheduler; a set cron takes precedence.
    expect(
      resolveOrdersSyncSchedule({
        ALLEGRO_ORDERS_SYNC_CRON: "* * * * *",
        ALLEGRO_ORDERS_SYNC_INTERVAL_MS: "5000",
      }),
    ).toEqual({ cron: "* * * * *" });
  });
});
