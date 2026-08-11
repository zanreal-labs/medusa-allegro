import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Self-contained AES-256-GCM envelope for the Allegro OAuth tokens.
 *
 * The plugin stores a live refresh token, which is a long-lived credential for
 * the seller's whole Allegro account. It must never sit in the database in
 * plaintext, so every value is sealed with the plugin's `encryptionKey` before
 * it is written and opened again on read.
 *
 * Deliberately `node:crypto` only: a plugin should not drag a KMS client or a
 * crypto library into a host project just to protect two strings. If you need
 * envelope encryption with a managed key, wrap these helpers rather than
 * replacing them - the packing format below is stable.
 *
 * Packing format (single base64 string):
 *
 *   base64( iv[12] || authTag[16] || ciphertext[..] )
 *
 * A fresh random IV is generated per value, so encrypting the same token twice
 * yields different ciphertext, and the GCM tag makes tampering detectable.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Decode and validate the configured key.
 *
 * The key is a base64-encoded 32-byte value. Anything shorter is rejected
 * loudly rather than stretched: silently accepting a weak key is how an
 * integration ends up with tokens that are encrypted in name only.
 */
export const decodeEncryptionKey = (encryptionKey: string): Buffer => {
  const trimmed = (encryptionKey ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "medusa-allegro: `encryptionKey` is required. Generate one with `openssl rand -base64 32`.",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error("medusa-allegro: `encryptionKey` must be base64-encoded.");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `medusa-allegro: \`encryptionKey\` must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  return key;
};

/** Seal a UTF-8 string. Returns the packed base64 envelope. */
export const encryptValue = (plaintext: string, encryptionKey: string): string => {
  const key = decodeEncryptionKey(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
};

/**
 * Open a packed envelope produced by `encryptValue`.
 *
 * Throws when the envelope is truncated, was sealed with a different key, or
 * was modified in storage. Callers that want "treat an unreadable token as not
 * connected" should catch this rather than have the helper return undefined -
 * an unreadable token is a real operational event worth surfacing.
 */
export const decryptValue = (packed: string, encryptionKey: string): string => {
  const key = decodeEncryptionKey(encryptionKey);
  const raw = Buffer.from(packed, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("medusa-allegro: encrypted value is truncated or malformed.");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
};

/**
 * Constant-time comparison for the OAuth `state` round-trip.
 *
 * A plain `===` on a secret leaks its prefix through timing. The lengths are
 * compared first because `timingSafeEqual` throws on a length mismatch, and a
 * length difference is not itself a secret.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a ?? "", "utf-8");
  const right = Buffer.from(b ?? "", "utf-8");
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
};

/** A URL-safe random token, used for the OAuth CSRF `state`. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
