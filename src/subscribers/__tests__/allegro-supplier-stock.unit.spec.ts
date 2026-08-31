import allegroSupplierStockSubscriber, { config } from "../allegro-supplier-stock";
import { MAX_SUPPLIER_SKUS } from "../../lib/sync/supplier-stock";
import { enqueueStockPush } from "../../workflows/lib/stock-push-queue";

jest.mock("../../workflows/lib/stock-push-queue", () => ({
  enqueueStockPush: jest.fn(),
}));

const enqueued = enqueueStockPush as jest.MockedFunction<typeof enqueueStockPush>;

const fakeContainer = () => {
  const logs: string[] = [];
  const record = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };
  return {
    logs,
    resolve: (key: string) => {
      if (key === "logger") {
        return {
          debug: record("debug"),
          error: record("error"),
          info: record("info"),
          warn: record("warn"),
        };
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  };
};

const fire = async (
  container: ReturnType<typeof fakeContainer>,
  data: unknown,
): Promise<void> => {
  await allegroSupplierStockSubscriber({
    container,
    event: { data, name: "marken.stock.changed" },
  } as never);
};

beforeEach(() => {
  enqueued.mockClear();
});

describe("allegroSupplierStockSubscriber", () => {
  it("queues a push for the SKUs the supplier moved", async () => {
    const container = fakeContainer();

    await fire(container, { skus: ["SKU-1", "SKU-2"] });

    // The SAME queue the sale path uses, which is the design rule: one debounce, one
    // claim, one write path, so a supplier change and a sale are indistinguishable
    // downstream and coalesce with each other.
    expect(enqueued).toHaveBeenCalledWith(container, ["SKU-1", "SKU-2"]);
  });

  it("does nothing, and says why, on a payload it cannot read", async () => {
    const container = fakeContainer();

    await fire(container, { stock: "changed" });

    expect(enqueued).not.toHaveBeenCalled();
    // The reason has to reach a human: this is a version-boundary problem between two
    // separately-installable plugins, and nothing else would surface it.
    expect(container.logs.join("\n")).toContain("no `skus` array");
  });

  it("never throws, so a bad payload cannot fail the supplier's own sync", async () => {
    const container = fakeContainer();

    await expect(fire(container, null)).resolves.toBeUndefined();
    await expect(fire(container, undefined)).resolves.toBeUndefined();
    expect(enqueued).not.toHaveBeenCalled();
  });

  it("survives the queue itself throwing", async () => {
    const container = fakeContainer();
    enqueued.mockImplementationOnce(() => {
      throw new Error("queue exploded");
    });

    await expect(fire(container, { skus: ["SKU-1"] })).resolves.toBeUndefined();
    expect(container.logs.join("\n")).toContain("could not queue a push");
  });

  it("reports a truncated announcement rather than swallowing it", async () => {
    const container = fakeContainer();
    const skus = Array.from({ length: MAX_SUPPLIER_SKUS + 3 }, (_, i) => `SKU-${i}`);

    await fire(container, { skus });

    expect(enqueued.mock.calls[0]?.[1]).toHaveLength(MAX_SUPPLIER_SKUS);
    // The remainder keeps a stale quantity until the sweep, which an operator must be
    // able to see.
    expect(container.logs.join("\n")).toContain("3 were not queued");
  });

  it("subscribes to the supplier plugin's event by name only", () => {
    // The entire coupling. If this string ever disagrees with the emitter, the fast
    // path goes silent and only the 15-minute sweep remains - which is precisely why
    // it is asserted on both sides.
    expect(config.event).toBe("marken.stock.changed");
  });
});
