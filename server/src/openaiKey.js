// @ts-check
// Stored per-user BYOK OpenAI keys (US-005). The value is encrypted at rest in
// users.openai_key_ciphertext (crypto.js) and only ever decrypted server-side to
// spawn the agent — it is never returned by any read. Correctness-critical
// (backlog/correctness-critical.md); pinned in openai-key-postgres.test.js.
import { db } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';

/**
 * Store (or replace) a user's key, encrypted. Returns the new set-state.
 * @param {string} userId
 * @param {string} plaintext already shape-validated by the caller
 * @returns {Promise<{ set: true, updated_at: string }>}
 */
export async function setUserOpenaiKey(userId, plaintext) {
  const { rows } = await db().query(
    `update users set openai_key_ciphertext = $1, openai_key_updated_at = now()
      where id = $2 returning openai_key_updated_at`,
    [encryptSecret(plaintext), userId]
  );
  return { set: true, updated_at: rows[0].openai_key_updated_at };
}

/**
 * Forget a user's key.
 * @param {string} userId
 */
export async function clearUserOpenaiKey(userId) {
  await db().query(
    `update users set openai_key_ciphertext = null, openai_key_updated_at = null where id = $1`,
    [userId]
  );
}

/**
 * The set-state for the UI: whether a key is stored and when — never the value.
 * @param {string} userId
 * @returns {Promise<{ set: boolean, updated_at: string | null }>}
 */
export async function getUserOpenaiKeyStatus(userId) {
  const { rows } = await db().query(
    `select openai_key_ciphertext is not null as set, openai_key_updated_at from users where id = $1`,
    [userId]
  );
  if (!rows.length) return { set: false, updated_at: null };
  return { set: rows[0].set, updated_at: rows[0].openai_key_updated_at };
}

/**
 * Decrypt a user's stored key for a run. Server-internal only.
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
export async function getUserOpenaiKey(userId) {
  const { rows } = await db().query(
    `select openai_key_ciphertext from users where id = $1`,
    [userId]
  );
  const cipher = rows[0]?.openai_key_ciphertext;
  return cipher ? decryptSecret(cipher) : null;
}

/**
 * Which key a run uses: a per-request key wins over the user's stored key, and
 * there is no third tier (US-039). Null means the run does not start — the
 * instance has no key of its own to spend on a caller who brought none.
 * Pure precedence — the two inputs are resolved by the caller.
 * @param {{ requestKey?: string | null, storedKey?: string | null }} keys
 * @returns {string | null}
 */
export function resolveRunKey({ requestKey, storedKey }) {
  return requestKey || storedKey || null;
}
