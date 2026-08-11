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

  it("accepts a base64url 32-byte key, padded or not", () => {
    const raw = randomBytes(32);
    expect(decodeEncryptionKey(raw.toString("base64url"))).toHaveLength(32);
    expect(decodeEncryptionKey(`${raw.toString("base64url")}=`)).toHaveLength(32);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => decodeEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
      /base64-encoded 32-byte value/,
    );
  });

  it('rejects the "A".repeat(43) placeholder, which decodes to an all-zero key', () => {
    // Buffer.from(_, "base64") happily turns this into 32 zero bytes, and AES
    // will use it. Length alone is not a validity check.
    expect(() => decodeEncryptionKey("A".repeat(43))).toThrow(/zero bytes/);
    expect(() => decodeEncryptionKey(`${"A".repeat(43)}=`)).toThrow(/zero bytes/);
  });

  it("rejects mangled base64 instead of silently dropping the invalid characters", () => {
    // 44 characters, so a length check would pass; "$" is not in either
    // alphabet, and Buffer.from would just skip it.
    const mangled = `$$$${randomBytes(32).toString("base64").slice(3)}`;
    expect(mangled).toHaveLength(44);
    expect(() => decodeEncryptionKey(mangled)).toThrow(/base64-encoded 32-byte value/);
  });

  it("rejects a key that mixes the two alphabets", () => {
    expect(() => decodeEncryptionKey(`+_${"A".repeat(41)}=`)).toThrow(
      /base64-encoded 32-byte value/,
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

  it("refuses to seal an empty value, rather than produce an unreadable envelope", () => {
    // An empty plaintext packs to iv + tag with no ciphertext, which
    // decryptValue cannot distinguish from a truncated envelope.
    expect(() => encryptValue("", key)).toThrow(/empty value/);
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
