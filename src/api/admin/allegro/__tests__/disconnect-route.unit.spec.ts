import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ALLEGRO_MODULE } from "../../../../modules/allegro";
import { POST } from "../disconnect/route";

/**
 * The disconnect route's contract is "the local rows go away no matter what".
 * These tests pin that down for every way the remote revocation can fail, and
 * pin the revocation order, because the refresh token is the credential worth
 * killing first.
 */

const disconnectedStatus = {
  connected: false,
  environment: "production",
  priceSyncDisabled: false,
  scopesRequested: "allegro:api:sale:offers:read",
};

interface HarnessOptions {
  loadToken?: jest.Mock;
  revoke?: jest.Mock;
}

const harness = (options: HarnessOptions = {}) => {
  const revoked: { token: string; hint?: string }[] = [];
  const revoke =
    options.revoke ??
    jest.fn((token: string, hint?: string) => {
      revoked.push({ hint, token });
      return Promise.resolve();
    });

  const service = {
    deleteConnection: jest.fn(() => Promise.resolve()),
    getConnectionStatus: jest.fn(() => Promise.resolve(disconnectedStatus)),
    getOAuth: jest.fn(() => Promise.resolve({ revoke })),
    loadToken:
      options.loadToken ??
      jest.fn(() =>
        Promise.resolve({
          accessToken: "AT",
          expiresAt: Date.now() + 3_600_000,
          refreshToken: "RT",
        }),
      ),
  };

  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };

  const req = {
    scope: { resolve: (key: string) => (key === ALLEGRO_MODULE ? service : logger) },
  } as unknown as MedusaRequest;

  const bodies: Record<string, unknown>[] = [];
  const res = {
    json: (body: Record<string, unknown>) => bodies.push(body),
  } as unknown as MedusaResponse;

  return { bodies, req, res, revoke, revoked, service, warnings };
};

describe("POST /admin/allegro/disconnect", () => {
  it("revokes the refresh token before the access token", async () => {
    const h = harness();

    await POST(h.req, h.res);

    expect(h.revoked).toEqual([
      { hint: "refresh_token", token: "RT" },
      { hint: "access_token", token: "AT" },
    ]);
  });

  it("deletes the local connection and reports the fresh status", async () => {
    const h = harness();

    await POST(h.req, h.res);

    expect(h.service.deleteConnection).toHaveBeenCalledTimes(1);
    expect(h.bodies[0]).toEqual({ connection: disconnectedStatus });
  });

  it("revokes only the access token when there is no refresh token", async () => {
    const h = harness({
      loadToken: jest.fn(() =>
        Promise.resolve({ accessToken: "AT", expiresAt: Date.now() + 3_600_000 }),
      ),
    });

    await POST(h.req, h.res);

    expect(h.revoked).toEqual([{ hint: "access_token", token: "AT" }]);
  });

  it("deletes locally even when both revocations reject", async () => {
    const h = harness({ revoke: jest.fn(() => Promise.reject(new Error("allegro unreachable"))) });

    await POST(h.req, h.res);

    // Both were attempted: `Promise.allSettled`, not a bail on the first.
    expect(h.revoke).toHaveBeenCalledTimes(2);
    expect(h.service.deleteConnection).toHaveBeenCalledTimes(1);
    expect(h.warnings).toHaveLength(2);
    for (const warning of h.warnings) {
      expect(warning).toContain("allegro unreachable");
    }
  });

  it("tells the operator to revoke by hand when a revocation rejected", async () => {
    const h = harness({ revoke: jest.fn(() => Promise.reject(new Error("nope"))) });

    await POST(h.req, h.res);

    expect(String(h.bodies[0]?.warning)).toContain("Allegro developer panel");
  });

  it("logs and reports a loadToken failure instead of silently skipping revocation", async () => {
    // The usual cause is an `encryptionKey` that no longer opens the envelope.
    // Swallowing it left the operator believing a live refresh token was killed.
    const h = harness({
      loadToken: jest.fn(() => Promise.reject(new Error("unable to authenticate data"))),
    });

    await POST(h.req, h.res);

    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.service.deleteConnection).toHaveBeenCalledTimes(1);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("could not be read");
    expect(h.warnings[0]).toContain("unable to authenticate data");
    expect(String(h.bodies[0]?.warning)).toContain("Allegro developer panel");
  });

  it("omits the warning entirely when everything worked", async () => {
    const h = harness();

    await POST(h.req, h.res);

    expect(h.bodies[0]).not.toHaveProperty("warning");
    expect(h.warnings).toEqual([]);
  });

  it("does not reach Allegro at all when nothing is stored", async () => {
    const h = harness({ loadToken: jest.fn(() => Promise.resolve()) });

    await POST(h.req, h.res);

    expect(h.service.getOAuth).not.toHaveBeenCalled();
    expect(h.service.deleteConnection).toHaveBeenCalledTimes(1);
    expect(h.bodies[0]).not.toHaveProperty("warning");
  });
});
