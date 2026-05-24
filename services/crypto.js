/**
 * services/crypto.js
 *
 * Owns: AES-256-GCM field-level encryption/decryption for health data.
 * Does NOT own: key management, session security, TLS configuration.
 *
 * Used by: server.js (runtime read/write), migration scripts (backfill).
 *
 * Format: "iv:authTag:ciphertext" (all hex, colon-separated).
 * IV: 96-bit random (GCM best practice).
 * Key: 32-byte hex from ENCRYPTION_KEY env var.
 */

const crypto = require('crypto');

/**
 * Load and validate the encryption key.
 * Call once at startup — throws if key is present but invalid.
 * Returns null if key is absent (dev fallback — warns, does not crash).
 */
function loadEncryptionKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    console.warn('[crypto] WARNING: ENCRYPTION_KEY is not set. Health data will NOT be encrypted. Set this in production!');
    return null;
  }
  if (hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

const ENCRYPTION_KEY = loadEncryptionKey();

/**
 * Encrypt a value with AES-256-GCM.
 *
 * Returns "iv:authTag:ciphertext" as hex, or null if value is null/undefined.
 * Falls back to plaintext storage if ENCRYPTION_KEY is not set (dev only).
 *
 * @param {string|number|null} value
 * @returns {string|null}
 */
function encrypt(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!ENCRYPTION_KEY) return str; // dev fallback

  const iv = crypto.randomBytes(12); // 96-bit IV
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a value encrypted with encrypt().
 *
 * Returns the original string, or null on failure.
 * Returns value as-is if it does not match the "iv:authTag:ciphertext" format
 * (handles legacy plaintext values gracefully).
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function decrypt(value) {
  if (value === null || value === undefined) return null;
  if (!ENCRYPTION_KEY) return value; // dev fallback

  const parts = String(value).split(':');
  if (parts.length !== 3) {
    // Not our format — legacy plaintext, return as-is
    return value;
  }

  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('[crypto] Decryption failed:', e.message);
    return null;
  }
}

/**
 * Decrypt an integer field.
 * Returns integer or null.
 *
 * @param {string|null} value
 * @returns {number|null}
 */
function decryptInt(value) {
  const str = decrypt(value);
  if (str === null || str === undefined) return null;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

/**
 * Check if a value is already encrypted (in our iv:authTag:ciphertext format).
 * Used by backfill migration to skip already-encrypted values.
 *
 * @param {string|null} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  // IV = 24 hex chars (12 bytes), authTag = 32 hex chars (16 bytes), ciphertext = variable
  return parts[0].length === 24 && parts[1].length === 32 && parts[2].length > 0;
}

module.exports = { encrypt, decrypt, decryptInt, isEncrypted, ENCRYPTION_KEY };
