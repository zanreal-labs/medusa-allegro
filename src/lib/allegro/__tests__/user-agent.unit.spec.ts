import { AllegroClient } from "../client";
import { buildAllegroUserAgent } from "../user-agent";

const validIdentity = {
  appName: "MyApp",
  appVersion: "1.2.3",
  docsUrl: "https://example.com/docs",
};

describe("buildAllegroUserAgent", () => {
  it("composes the User-Agent in Allegro-required format", () => {
    expect(buildAllegroUserAgent(validIdentity)).toBe("MyApp/1.2.3 (+https://example.com/docs)");
  });

  it("normalises docsUrl through the URL parser", () => {
    expect(buildAllegroUserAgent({ ...validIdentity, docsUrl: "https://example.com/docs " })).toBe(
      "MyApp/1.2.3 (+https://example.com/docs)",
    );
  });

  it("trims whitespace around tokens", () => {
    expect(
      buildAllegroUserAgent({
        appName: "  MyApp  ",
        appVersion: "  1.0  ",
        docsUrl: "https://example.com/docs",
      }),
    ).toBe("MyApp/1.0 (+https://example.com/docs)");
  });

  it.each([
    ["appName", { ...validIdentity, appName: "" }],
    ["appVersion", { ...validIdentity, appVersion: "" }],
    ["docsUrl", { ...validIdentity, docsUrl: "" }],
  ])("throws when %s is empty", (_label, identity) => {
    expect(() => buildAllegroUserAgent(identity)).toThrow(/is required/u);
  });

  it("rejects whitespace inside appName", () => {
    expect(() => buildAllegroUserAgent({ ...validIdentity, appName: "My App" })).toThrow(
      /User-Agent token/u,
    );
  });

  it("rejects HTTP separators inside appVersion", () => {
    expect(() => buildAllegroUserAgent({ ...validIdentity, appVersion: "1.0/beta" })).toThrow(
      /User-Agent token/u,
    );
  });

  it("rejects non-URL docsUrl", () => {
    expect(() => buildAllegroUserAgent({ ...validIdentity, docsUrl: "not a url" })).toThrow(
      /valid absolute URL/u,
    );
  });

  it("rejects non-http protocols", () => {
    expect(() =>
      buildAllegroUserAgent({ ...validIdentity, docsUrl: "ftp://example.com/docs" }),
    ).toThrow(/http\(s\) protocol/u);
  });
});

describe("AllegroClient construction with app identity", () => {
  it("throws on missing identity fields", () => {
    expect(
      () =>
        new AllegroClient({
          appName: "",
          appVersion: "1.0",
          clientId: "cid",
          clientSecret: "sec",
          docsUrl: "https://example.com/docs",
        }),
    ).toThrow(/appName is required/u);
  });

  it("exposes the composed User-Agent via getUserAgent()", () => {
    const c = new AllegroClient({
      accessToken: "PRESET",
      accessTokenExpiresAt: Date.now() + 60_000,
      appName: "MyApp",
      appVersion: "1.0",
      clientId: "cid",
      clientSecret: "sec",
      docsUrl: "https://example.com/docs",
    });
    expect(c.getUserAgent()).toBe("MyApp/1.0 (+https://example.com/docs)");
  });
});
