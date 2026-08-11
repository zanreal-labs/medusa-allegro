import { AllegroClient } from "../client";

const client = (fetchImpl: typeof fetch): AllegroClient =>
  new AllegroClient({
    accessToken: "token",
    accessTokenExpiresAt: Date.now() + 60_000,
    appName: "test",
    appVersion: "1",
    clientId: "id",
    clientSecret: "secret",
    docsUrl: "https://example.com",
    fetch: fetchImpl,
  });

const json = (body: unknown): Response => Response.json(body, { status: 200 });

describe("changeOfferQuantity", () => {
  it("sends a stable FIXED quantity command for every offer", async () => {
    const fetchImpl = jest.fn(async () => json({ id: "command-1" })) as unknown as typeof fetch;

    await client(fetchImpl).changeOfferQuantity({
      commandId: "command-1",
      offerIds: ["offer-1", "offer-2"],
      value: 0,
    });

    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toContain("/sale/offer-quantity-change-commands/command-1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      modification: { changeType: "FIXED", value: 0 },
      offerCriteria: [
        {
          offers: [{ id: "offer-1" }, { id: "offer-2" }],
          type: "CONTAINS_OFFERS",
        },
      ],
    });
  });

  it("rejects invalid quantities and oversized commands before a request", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const sdk = client(fetchImpl);

    await expect(
      sdk.changeOfferQuantity({ commandId: "c", offerIds: ["o"], value: -1 }),
    ).rejects.toThrow("non-negative integer");
    await expect(
      sdk.changeOfferQuantity({
        commandId: "c",
        offerIds: Array.from({ length: 1001 }, (_, index) => String(index)),
        value: 1,
      }),
    ).rejects.toThrow("between 1 and 1,000");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a fractional quantity, which Allegro would round silently", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;

    await expect(
      client(fetchImpl).changeOfferQuantity({ commandId: "c", offerIds: ["o"], value: 1.5 }),
    ).rejects.toThrow("non-negative integer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty offer list, which would send a command that matches nothing", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;

    await expect(
      client(fetchImpl).changeOfferQuantity({ commandId: "c", offerIds: [], value: 1 }),
    ).rejects.toThrow("between 1 and 1,000");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pollOfferQuantityCommand", () => {
  it("polls until all tasks are terminal", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        json({ completedAt: null, id: "c", taskCount: { failed: 0, success: 0, total: 2 } }),
      )
      .mockResolvedValueOnce(
        json({ completedAt: null, id: "c", taskCount: { failed: 0, success: 2, total: 2 } }),
      ) as unknown as typeof fetch;

    const report = await client(fetchImpl).pollOfferQuantityCommand("c", {
      sleep: async () => {},
    });

    expect(report.taskCount?.success).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
