// @ts-check
// Reversible encryption for secrets stored at rest — currently users' BYOK
// OpenAI keys (US-005). AES-256-GCM: confidentiality plus an auth tag, so a
// tampered or truncated ciphertext fails closed (decrypt throws) rather than
// returning attacker-chosen bytes. This is a correctness-critical surface
// (backlog/correctness-critical.md); the properties are pinned in
// openai-key.test.js (round-trip, fresh IV, tamper) before this code.
//
// Stored layout (one bytea column): iv(12) || authTag(16) || ciphertext.
import crypto from 'node:crypto';
import { KEY_ENCRYPTION_SECRET } from './config.js';

const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
// A stable, domain-separated 256-bit key derived from the configured secret.
// scrypt with a fixed salt is deterministic (the secret is the entropy), so the
// same secret always decrypts what it encrypted, across restarts and instances.
const DERIVED_KEY = KEY_ENCRYPTION_SECRET
  ? crypto.scryptSync(KEY_ENCRYPTION_SECRET, 'qassist:key-encryption:v1', 32)
  : null;

/** Whether stored-key encryption is available (the secret is configured). */
export function keyEncryptionEnabled() {
  return DERIVED_KEY !== null;
}

/**
 * Encrypt a secret string for storage. Returns the bytea payload.
 * @param {string} plaintext
 * @returns {Buffer}
 */
export function encryptSecret(plaintext) {
  if (!DERIVED_KEY) throw new Error('KEY_ENCRYPTION_SECRET is not set');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', DERIVED_KEY, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * Decrypt a stored payload. Throws if the key is wrong or the bytes were
 * tampered/truncated — it never returns a wrong plaintext.
 * @param {Buffer} payload
 * @returns {string}
 */
export function decryptSecret(payload) {
  if (!DERIVED_KEY) throw new Error('KEY_ENCRYPTION_SECRET is not set');
  if (!Buffer.isBuffer(payload) || payload.length <= IV_LEN + TAG_LEN) {
    throw new Error('ciphertext is too short to be valid');
  }
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', DERIVED_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(body, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Cheap up-front sanity check on an OpenAI key's shape, so an obviously wrong
 * value is refused before it is ever encrypted, stored, or handed to the agent.
 * Not a validity check — only OpenAI can confirm that on the first call.
 * @param {string} key
 * @returns {boolean}
 */
export function validOpenaiKeyShape(key) {
  return typeof key === 'string' && /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}
