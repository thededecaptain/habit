import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class EncryptionConfigError extends Error {
  constructor(message = "HABIT_ENCRYPTION_KEY is not configured.") {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

/**
 * HABIT_ENCRYPTION_KEY: 32-byte key, base64-encoded (Railway env on the web service).
 *
 * Rotation: there is no key-version prefix or dual-decrypt. Changing
 * HABIT_ENCRYPTION_KEY makes every stored Klaviyo key undecryptable.
 * Merchants must reconnect Klaviyo (re-paste the private API key).
 * Webhook URLs are stored in plaintext and are unaffected.
 */
function loadKey(): Buffer {
  const raw = process.env.HABIT_ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionConfigError(
      "HABIT_ENCRYPTION_KEY is not set. Cannot store API keys.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionConfigError(
      "HABIT_ENCRYPTION_KEY must be 32 bytes encoded as base64.",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  const key = loadKey();
  const payload = Buffer.from(ciphertext, "base64");
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Invalid ciphertext.");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
