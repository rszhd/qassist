// @ts-check
// Seed a stored BYOK key into a pg-mem database (US-039 test support).
//
// pg-mem cannot round-trip a bytea PARAMETER: the adapter squeezes the buffer
// through a UTF-8 string, so AES-GCM ciphertext (which has high bytes) comes
// back with replacement characters and decryptSecret throws. The product's own
// write path (PUT /api/account/openai-key) therefore corrupts on pg-mem — the
// end-to-end store-then-run flow is byok-postgres.test.js on a real server.
//
// But a function REGISTERED on pg-mem returns a Buffer that is stored as-is,
// never serialized. So a test whose subject is not key storage itself — the
// scheduler's slot math, billing's gates — can seed a decryptable key by
// registering `decode` and writing the ciphertext as hex inside the SQL text.

import { DataType } from 'pg-mem';

/**
 * Register the `decode(text, format)` builtin pg-mem lacks. Call once per
 * database, before seedStoredKey.
 * @param {import('pg-mem').IMemoryDb} mem
 */
export function registerDecode(mem) {
  mem.public.registerFunction({
    name: 'decode',
    args: [DataType.text, DataType.text],
    returns: DataType.bytea,
    implementation: (/** @type {string} */ value, /** @type {BufferEncoding} */ format) =>
      Buffer.from(value, format),
  });
}

/**
 * Give `userId` a stored, decryptable OpenAI key. KEY_ENCRYPTION_SECRET must be
 * in the env before this runs (crypto.js reads it at import time).
 * @param {any} pool
 * @param {string} userId
 * @param {string} [key]
 */
export async function seedStoredKey(pool, userId, key = 'sk-proj-' + 'Seeded0000seeded0000seeded0000seeded0000s') {
  const { encryptSecret } = await import('../../src/crypto.js');
  const hex = encryptSecret(key).toString('hex');
  await pool.query(
    `update users set openai_key_ciphertext = decode('${hex}', 'hex'), openai_key_updated_at = now()
      where id = $1`,
    [userId]
  );
  return key;
}
