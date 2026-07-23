import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * @param {string} secret
 * @returns {NonSharedBuffer}
 */
export function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

/**
 * @param {string} text
 * @param {string} secret
 * @returns {string}
 */
export function encrypt(text, secret) {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack iv + authTag + ciphertext together
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * @param {string} ciphertext
 * @param {string} secret
 * @returns {string}
 */
export function decrypt(ciphertext, secret) {
  const key = deriveKey(secret);
  const data = Buffer.from(ciphertext, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.subarray(IV_LENGTH + 16);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
