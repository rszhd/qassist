// @ts-check
// pg-mem's bytea gap, and the two ways round it (US-039 test support).
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
//
// `byteaPool` applies that same trick to the parameters PRODUCT code passes,
// which is what lets a route that stores ciphertext be tested on pg-mem at all.

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
 * A pg-mem pool whose `bytea` parameters survive the trip, by rewriting each
 * Buffer to the hex `decode` form seedStoredKey writes by hand.
 *
 * Without it the corruption is usually silent — the column still holds
 * something, and it still isn't plaintext — but not always: the escaped string
 * the adapter builds is sometimes SQL the parser rejects outright, and whether
 * it is depends only on the random AES-GCM IV. That was BUG-007's paste-endpoint
 * 409 (pg-mem's parse error names a `kw_unique` token, which the route's
 * isUniqueViolation fallback reads as a name clash) and its login-refresh
 * timeout, both roughly one run in twenty and neither correlated with anything.
 *
 * Call `registerDecode` on the same db first.
 * @param {import('pg-mem').IMemoryDb} mem
 */
export function byteaPool(mem) {
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const query = pool.query.bind(pool);
  pool.query = (/** @type {any} */ text, /** @type {any} */ values) => {
    if (typeof text !== 'string' || !Array.isArray(values) || !values.some(Buffer.isBuffer)) {
      return query(text, values);
    }
    // Buffers are inlined and their placeholders dropped; everything else keeps
    // its `$n`, so the parameters after a buffer still resolve by index.
    const inlined = text.replace(/\$(\d+)/g, (placeholder, /** @type {string} */ n) => {
      const value = values[Number(n) - 1];
      return Buffer.isBuffer(value) ? `decode('${value.toString('hex')}', 'hex')` : placeholder;
    });
    return query(inlined, values);
  };
  return pool;
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
