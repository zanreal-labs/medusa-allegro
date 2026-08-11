import { randomBytes } from "node:crypto";
import { decodeEncryptionKey, decryptValue, encryptValue, randomToken, safeEqual } from "../crypto";

const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

describe("decodeEncryptionKey", () => {
  it("accepts a base64 32-byte key", () => {
    expect(decodeEncryptionKey(key)).toHaveLength(32);
  });

  it("rejects an empty key", () => {
    expect(() => decodeEncryptionKey("")).toThrow(/is required/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => decodeEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
      /exactly 32 bytes/,
    );
  });
});

describe("encryptValue / decryptValue", () => {
  it("round-trips a value", () => {
    const secret = "allegro-refresh-token-value";
    expect(decryptValue(encryptValue(secret, key), key)).toBe(secret);
  });

  it("round-trips non-ASCII text", () => {
    const secret = "polskie-znaki-ĄĆĘŁŃÓŚŹŻ";
    expect(decryptValue(encryptValue(secret, key), key)).toBe(secret);
  });

  it("uses a fresh IV per value, so the same input never repeats a ciphertext", () => {
    const a = encryptValue("same", key);
    const b = encryptValue("same", key);
    expect(a).not.toBe(b);
    expect(decryptValue(a, key)).toBe(decryptValue(b, key));
  });

  it("packs iv + tag + ciphertext, so the envelope is longer than the payload", () => {
    const raw = Buffer.from(encryptValue("x", key), "base64");
    // 12-byte IV + 16-byte GCM tag + 1 byte of ciphertext.
    expect(raw).toHaveLength(29);
  });

  it("refuses a value sealed with a different key", () => {
    expect(() => decryptValue(encryptValue("secret", key), otherKey)).toThrow();
  });

  it("refuses a tampered envelope", () => {
    const raw = Buffer.from(encryptValue("secret", key), "base64");
    // Flip a bit in the ciphertext; the GCM tag must reject it.
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptValue(raw.toString("base64"), key)).toThrow();
  });

  it("refuses a truncated envelope", () => {
    expect(() => decryptValue(randomBytes(20).toString("base64"), key)).toThrow(
      /truncated or malformed/,
    );
  });
});

describe("safeEqual", () => {
  it("matches identical values", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different values, including different lengths", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("rejects empty values, so a missing cookie never compares equal", () => {
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("randomToken", () => {
  it("is URL-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]+$/);
  });
});
