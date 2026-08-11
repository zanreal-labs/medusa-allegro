import { randomBytes } from "node:crypto";
import type { AllegroPluginOptions } from "../../../lib/options";
import AllegroModuleService from "../service";
import { STALE_CLAIM_MS } from "../service";

/**
 * The single-flight claim, against a fake `allegro_sync_state` table.
 *
 * Everything asserted here is service logic rather than database behaviour: which
 * conditional update is issued, what the affected-row count is taken to mean, and what a
 * run is allowed to write once it no longer owns the claim. The fake table honours the
 * SELECTOR - that is the whole point, since a fake that ignored `claim_token` or
 * `updated_at` would make every one of these tests pass vacuously.
 */

const KEY = randomBytes(32).toString("base64");

const options = (): AllegroPluginOptions => ({
  appName: "MedusaAllegro",
  appVersion: "0.1.0",
  clientId: "client-id",
  clientSecret: "client-secret",
  docsUrl: "https://example.com/allegro",
  encryptionKey: KEY,
});

interface StateRow {
  id: string;
  provider: string;
  status: string;
  cursor: string | null;
  counts: unknown;
  failures: unknown;
  last_error: string | null;
  last_synced_at: Date | null;
  write_scope_missing: boolean;
  updated_at: Date;
  claim_token: string | null;
  claim_heartbeat_at: Date | null;
}

const stateRow = (over: Partial<StateRow> = {}): StateRow => ({
  claim_heartbeat_at: null,
  claim_token: null,
  counts: null,
  cursor: null,
  failures: null,
  id: "algsync_1",
  last_error: null,
  last_synced_at: null,
  provider: "prices",
  status: "idle",
  updated_at: new Date("2026-06-01T00:00:00.000Z"),
  write_scope_missing: false,
  ...over,
});

/**
 * In-memory `allegro_sync_state`, with a selector that is actually applied.
 *
 * `updated_at` is bumped on every update, mirroring Medusa's DML `onUpdate` - the claim's
 * atomicity rests on that bump, so a fake that skipped it would hide a real regression.
 */
const fakeStates = (initial: StateRow[] = []) => {
  const rows: StateRow[] = [...initial];
  const updates: { selector: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  let clock = new Date("2026-06-01T00:00:00.000Z").getTime();

  const matches = (row: StateRow, selector: Record<string, unknown>): boolean =>
    Object.entries(selector).every(([key, value]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (value instanceof Date && actual instanceof Date) {
        return value.getTime() === actual.getTime();
      }
      return actual === value;
    });

  return {
    advanceClock: (ms: number) => {
      clock += ms;
    },
    create: (data: Partial<StateRow>[]) => {
      const created = data.map((entry, index) => {
        const row = stateRow({ id: `algsync_${rows.length + index + 1}`, ...entry });
        rows.push(row);
        return { ...row };
      });
      return Promise.resolve(created);
    },
    list: (filters: Record<string, unknown> = {}, config: { take?: number } = {}) => {
      let out = rows.filter((row) => matches(row, filters));
      if (config.take !== undefined) {
        out = out.slice(0, config.take);
      }
      return Promise.resolve(out.map((row) => ({ ...row })));
    },
    rows,
    update: (input: { data: Record<string, unknown>; selector: Record<string, unknown> }) => {
      updates.push(input);
      const affected: StateRow[] = [];
      for (const [index, row] of rows.entries()) {
        if (!matches(row, input.selector)) {
          continue;
        }
        // The ORM-managed bump the claim depends on.
        clock += 1000;
        rows[index] = { ...row, ...input.data, updated_at: new Date(clock) } as StateRow;
        affected.push(rows[index] as StateRow);
      }
      return Promise.resolve(affected.map((row) => ({ ...row })));
    },
    updates,
  };
};

const makeService = (
  table: ReturnType<typeof fakeStates>,
  logger?: { warn: (message: string) => void },
) => {
  const service = new AllegroModuleService(
    {
      baseRepository: {
        getFreshManager: () => ({}),
        serialize: <T>(value: T) => Promise.resolve(value),
        transaction: async <T>(work: (manager: unknown) => Promise<T>) => await work({}),
      },
      logger,
    } as never,
    options(),
  );
  Object.assign(service as unknown as Record<string, unknown>, {
    createAllegroSyncStates: table.create,
    listAllegroSyncStates: table.list,
    updateAllegroSyncStates: table.update,
  });
  return service;
};

describe("claimSyncRun", () => {
  it("mints a fencing token and marks the row running", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);

    const claim = await service.claimSyncRun("prices");

    expect(claim.acquired).toBe(true);
    expect(claim.token).toEqual(expect.any(String));
    expect(table.rows[0]).toMatchObject({ claim_token: claim.token, status: "running" });
    // The heartbeat is stamped at claim time, so staleness is measured from a real
    // liveness signal from the very first moment.
    expect(table.rows[0]?.claim_heartbeat_at).toBeInstanceOf(Date);
  });

  it("conditions the claim on updated_at, so a concurrent claimant loses", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);

    await service.claimSyncRun("prices");
    const [firstUpdate] = table.updates;
    expect(firstUpdate?.selector).toMatchObject({ provider: "prices" });
    expect(firstUpdate?.selector.updated_at).toBeInstanceOf(Date);
  });

  it("refuses when a live run holds the claim", async () => {
    const table = fakeStates([
      stateRow({ claim_heartbeat_at: new Date(), claim_token: "other", status: "running" }),
    ]);
    const service = makeService(table);

    const claim = await service.claimSyncRun("prices");

    expect(claim.acquired).toBe(false);
    expect(claim.token).toBeUndefined();
    // The incumbent's token is untouched.
    expect(table.rows[0]?.claim_token).toBe("other");
  });

  it("measures staleness from the HEARTBEAT, not from when the claim was taken", async () => {
    // The bug this closes: `updated_at` was bumped when the claim was taken and then not
    // again until the run finished, so any run slower than the window was taken over
    // MID-FLIGHT and two runs pushed to Allegro at once. The slow cases are routine - 100
    // sequential order refreshes, a 120s poll per stock command, a full-catalogue price run.
    const longAgo = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
    const table = fakeStates([
      stateRow({
        // Claim taken long ago...
        claim_heartbeat_at: new Date(),
        claim_token: "incumbent",
        status: "running",
        // ...but the holder said it was alive a moment ago.
        updated_at: longAgo,
      }),
    ]);
    const service = makeService(table);

    const claim = await service.claimSyncRun("prices");

    expect(claim.acquired).toBe(false);
    expect(table.rows[0]?.claim_token).toBe("incumbent");
  });

  it("takes over a claim whose heartbeat has gone stale", async () => {
    const warnings: string[] = [];
    const table = fakeStates([
      stateRow({
        claim_heartbeat_at: new Date(Date.now() - STALE_CLAIM_MS - 1000),
        claim_token: "crashed",
        status: "running",
      }),
    ]);
    const service = makeService(table, { warn: (message) => warnings.push(message) });

    const claim = await service.claimSyncRun("prices");

    expect(claim.acquired).toBe(true);
    expect(claim.token).not.toBe("crashed");
    expect(warnings.some((line) => line.includes("stale"))).toBe(true);
  });

  it("falls back to updated_at for a row written before the heartbeat column existed", async () => {
    const table = fakeStates([
      stateRow({
        claim_heartbeat_at: null,
        claim_token: "legacy",
        status: "running",
        updated_at: new Date(Date.now() - STALE_CLAIM_MS - 1000),
      }),
    ]);
    const service = makeService(table);

    expect((await service.claimSyncRun("prices")).acquired).toBe(true);
  });
});

describe("touchSyncClaim", () => {
  it("extends the claim while the token still matches", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");
    const before = table.rows[0]?.claim_heartbeat_at;

    const held = await service.touchSyncClaim("prices", claim.token as string);

    expect(held).toBe(true);
    expect(table.rows[0]?.claim_heartbeat_at).not.toBe(before);
  });

  it("reports the claim LOST when the token no longer matches", async () => {
    // What a taken-over run sees. It must stop writing at once: the row belongs to the run
    // that replaced it, and any further Allegro command would be concurrent with that run's.
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");

    // Somebody else takes over.
    await table.update({ data: { claim_token: "usurper" }, selector: { provider: "prices" } });

    expect(await service.touchSyncClaim("prices", claim.token as string)).toBe(false);
  });
});

describe("writeSyncState fencing", () => {
  it("writes while the token matches", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");

    const written = await service.writeSyncState(
      "prices",
      { last_error: null, status: "ok" },
      { token: claim.token },
    );

    expect(written).toBe(true);
    expect(table.rows[0]).toMatchObject({ status: "ok" });
  });

  it("refuses to write once the claim has been taken over", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");
    await table.update({ data: { claim_token: "usurper" }, selector: { provider: "prices" } });

    const written = await service.writeSyncState(
      "prices",
      { last_error: "stale run's opinion", status: "ok" },
      { token: claim.token },
    );

    expect(written).toBe(false);
    // The successor's state is intact: no counters, cursor or status from the dead run.
    expect(table.rows[0]).toMatchObject({ claim_token: "usurper", last_error: null });
  });

  it("writes unconditionally when no token is supplied", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);

    expect(await service.writeSyncState("prices", { status: "ok" })).toBe(true);
  });
});

describe("writeSyncStateIfUnclaimed", () => {
  it("leaves a live claim completely alone", async () => {
    // The finding this closes. A pre-claim early exit wrote `status: "idle"` on the shared
    // row unconditionally. On a row held by a run in flight that RELEASES its claim, so the
    // next tick acquires it and two runs execute concurrently - the exact failure
    // single-flight exists to prevent, reached by the code meant to report a skip.
    const table = fakeStates([
      stateRow({ claim_heartbeat_at: new Date(), claim_token: "incumbent", status: "running" }),
    ]);
    const service = makeService(table);

    const written = await service.writeSyncStateIfUnclaimed("prices", {
      last_error: "price sync is disabled",
      status: "idle",
    });

    expect(written).toBe(false);
    expect(table.rows[0]).toMatchObject({
      claim_token: "incumbent",
      last_error: null,
      status: "running",
    });
  });

  it("records the reason when no run holds the claim", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);

    const written = await service.writeSyncStateIfUnclaimed("prices", {
      last_error: "price sync is disabled",
      status: "idle",
    });

    expect(written).toBe(true);
    expect(table.rows[0]).toMatchObject({
      last_error: "price sync is disabled",
      status: "idle",
    });
  });

  it("writes over a claim whose heartbeat has gone stale", async () => {
    const table = fakeStates([
      stateRow({
        claim_heartbeat_at: new Date(Date.now() - STALE_CLAIM_MS - 1000),
        claim_token: "crashed",
        status: "running",
      }),
    ]);
    const service = makeService(table);

    expect(
      await service.writeSyncStateIfUnclaimed("prices", { last_error: "disabled", status: "idle" }),
    ).toBe(true);
  });
});

describe("releaseSyncRun", () => {
  it("clears the token so a dead run's heartbeat cannot resurrect the claim", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");

    await service.releaseSyncRun("prices", { token: claim.token });

    expect(table.rows[0]).toMatchObject({ claim_token: null, status: "idle" });
    expect(await service.touchSyncClaim("prices", claim.token as string)).toBe(false);
  });

  it("records an error status when given one", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");

    await service.releaseSyncRun("prices", { lastError: "boom", token: claim.token });

    expect(table.rows[0]).toMatchObject({ last_error: "boom", status: "error" });
  });

  it("cannot release a claim it no longer holds", async () => {
    const table = fakeStates([stateRow()]);
    const service = makeService(table);
    const claim = await service.claimSyncRun("prices");
    await table.update({ data: { claim_token: "usurper" }, selector: { provider: "prices" } });

    expect(await service.releaseSyncRun("prices", { token: claim.token })).toBe(false);
    expect(table.rows[0]).toMatchObject({ claim_token: "usurper", status: "running" });
  });
});
