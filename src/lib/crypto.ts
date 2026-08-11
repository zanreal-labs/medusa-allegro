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
 * The only two spellings of a 32-byte base64 value.
 *
 * 32 bytes encode to 43 payload characters plus one `=` of padding. The standard
 * alphabet is what `openssl rand -base64 32` emits; the URL-safe one is what
 * several secret managers hand back, and its padding is conventionally dropped,
 * hence the optional `=`.
 *
 * The encoding has to be checked BEFORE decoding, because `Buffer.from(s,
 * "base64")` never throws: it silently skips every character outside the
 * alphabet and stops at the first padding it finds. Without these patterns,
 * `"not-a-key-!!!$$$" + 40 more junk characters` decodes to something 32 bytes
 * long and is accepted as a key.
 */
const KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const KEY_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}=?$/;

/**
 * Decode and validate the configured key.
 *
 * The key is a base64-encoded 32-byte value. Anything else is rejected loudly
 * rather than stretched or silently repaired: accepting a weak key is how an
 * integration ends up with tokens that are encrypted in name only. The
 * all-zero key gets its own rejection because it is the value a lazily encoded
 * placeholder (`"A".repeat(43)`) decodes to, and it is a perfectly well-formed
 * 32 bytes that AES will happily use.
 */
export const decodeEncryptionKey = (encryptionKey: string): Buffer => {
  const trimmed = (encryptionKey ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "medusa-allegro: `encryptionKey` is required. Generate one with `openssl rand -base64 32`.",
    );
  }

  if (!(KEY_BASE64_PATTERN.test(trimmed) || KEY_BASE64URL_PATTERN.test(trimmed))) {
    throw new Error(
      `medusa-allegro: \`encryptionKey\` must be a base64-encoded ${KEY_BYTES}-byte value (43 characters plus "="). Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  const key = Buffer.from(trimmed, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `medusa-allegro: \`encryptionKey\` must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  if (key.every((byte) => byte === 0)) {
    throw new Error(
      `medusa-allegro: \`encryptionKey\` decodes to ${KEY_BYTES} zero bytes, which is a placeholder rather than a key. Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  return key;
};

/**
 * Seal a UTF-8 string. Returns the packed base64 envelope.
 *
 * The empty string is rejected rather than sealed. Its envelope is exactly
 * `IV || tag` with no ciphertext, which `decryptValue` cannot tell apart from a
 * truncated envelope and therefore refuses - so encrypting it would produce a
 * value that can never be read back. A caller with nothing to store should
 * write NULL instead (which is what the nullable token columns are for).
 */
export const encryptValue = (plaintext: string, encryptionKey: string): string => {
  if (!plaintext) {
    throw new Error(
      "medusa-allegro: refusing to encrypt an empty value - it would seal into an envelope that cannot be decrypted. Store NULL instead.",
    );
  }
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
