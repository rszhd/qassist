// @ts-check
// Stored values behind a test's `secret` declarations (US-064): the credential a
// schedule types when nobody is present, and the rules about where its
// plaintext may exist.
//
// US-035 keeps a secret's value out of `tests.variables` entirely, because it
// arrived per run from someone who was there. A schedule has no such channel, so
// the value is stored — encrypted, in `test_secrets` (017), in the same
// AES-256-GCM envelope the BYOK key (US-005) and the session blob (US-043)
// already use. `variables.js`'s header carries the amended guarantee.
//
// Two rules give this module its shape:
//
//   The ciphertext lives in a table nothing selects into a response. Not a field
//   inside the `tests.variables` jsonb, which every test endpoint returns — that
//   would make masking a discipline repeated at four sites forever, and the
//   fifth site added next year does not inherit a discipline.
//
//   Reading needs no decryption. The editor asks "is a value stored?", which is
//   `select name` — so plaintext exists only between `secretsForTests` and
//   `resolveForRun`, on the paths that actually start a run.
//
// Correctness-critical (backlog/correctness-critical.md). The spec is
// test/test-secrets.test.js plus test-secrets-postgres.test.js for the `bytea`
// round trip pg-mem cannot hold up.
import { db } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';

/** `$1, $2, …` — pg-mem has no array parameter binding, and a batch is short. */
const placeholders = (values, from = 1) => values.map((_, i) => `$${i + from}`).join(', ');

/**
 * Which secret names have a stored value, keyed by test id. The set-state the
 * editor renders and the schedule route validates against — never a value, and
 * never a decryption.
 * @param {string[]} testIds
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function storedSecretNames(testIds) {
  /** @type {Map<string, Set<string>>} */
  const byTest = new Map();
  const ids = [...new Set(testIds.filter(Boolean))];
  if (!ids.length || !db()) return byTest;
  const { rows } = await db().query(
    `select test_id, name from test_secrets where test_id in (${placeholders(ids)})`,
    ids
  );
  for (const row of rows) {
    if (!byTest.has(row.test_id)) byTest.set(row.test_id, new Set());
    byTest.get(row.test_id)?.add(row.name);
  }
  return byTest;
}

/**
 * Annotate declarations with their stored state for a response. `value_set` is
 * the only thing a secret ever tells a caller about its value, and it is added
 * to the row rather than folded into `value` so a client cannot mistake one for
 * the other.
 * @template {{ id: string, variables?: any }} T
 * @param {T[]} tests
 * @returns {Promise<T[]>}
 */
export async function withSecretState(tests) {
  const rows = tests.filter(Boolean);
  if (!rows.length) return tests;
  const names = await storedSecretNames(rows.map((t) => t.id));
  for (const t of rows) {
    if (!Array.isArray(t.variables)) continue;
    const stored = names.get(t.id);
    t.variables = t.variables.map((v) =>
      v && v.secret ? { ...v, value_set: !!stored?.has(v.name) } : v
    );
  }
  return tests;
}

/**
 * Apply a write's three-state intent (`variables.js`'s `secretWrites`) and prune
 * whatever the resulting declaration no longer claims.
 *
 * The prune is the half that is easy to leave out: a variable dropped from the
 * array, or one whose Secret tick was removed, would otherwise leave its value
 * encrypted on disk under a name nothing references — and re-adding that name
 * later would silently resurrect it.
 * @param {string} testId
 * @param {{ set: Record<string, string>, clear: string[] }} writes
 * @param {Array<{name: string, secret: boolean}>} declarations the normalized result of this write
 */
export async function applySecretWrites(testId, writes, declarations) {
  for (const [name, value] of Object.entries(writes.set)) {
    await db().query(
      `insert into test_secrets (test_id, name, value_ciphertext) values ($1, $2, $3)
       on conflict (test_id, name)
       do update set value_ciphertext = excluded.value_ciphertext, updated_at = now()`,
      [testId, name, encryptSecret(value)]
    );
  }
  const keep = declarations.filter((v) => v.secret).map((v) => v.name);
  const drop = writes.clear.filter((name) => !Object.prototype.hasOwnProperty.call(writes.set, name));
  if (drop.length) {
    await db().query(
      `delete from test_secrets where test_id = $1 and name in (${placeholders(drop, 2)})`,
      [testId, ...drop]
    );
  }
  if (!keep.length) {
    await db().query('delete from test_secrets where test_id = $1', [testId]);
    return;
  }
  await db().query(
    `delete from test_secrets where test_id = $1 and name not in (${placeholders(keep, 2)})`,
    [testId, ...keep]
  );
}

/**
 * The decrypted secrets for a batch of runnable tests, keyed by test id.
 *
 * Resolved HERE, before `createRun`, exactly as `sessionsForTests` is and for
 * the same reason: the run engine is synchronous, every trigger path funnels
 * through it, and decrypting is a DB read. The plaintext then lives in the
 * in-memory run object and one child's environment, and nowhere else.
 *
 * A secret that cannot be decrypted resolves to `{ error }` and its test does
 * not run. Fail-closed on purpose — a run started with an empty password types
 * nothing into the field and reports the app as broken, which is the false
 * failure this story exists to remove. AES-GCM makes that state reachable by
 * configuration alone (a rotated KEY_ENCRYPTION_SECRET), with no bug anywhere.
 * @param {{ id: string, variables?: any }[]} tests
 * @returns {Promise<Map<string, { error?: string, values?: Record<string, string> }>>}
 */
export async function secretsForTests(tests) {
  /** @type {Map<string, { error?: string, values?: Record<string, string> }>} */
  const byTest = new Map();
  // Only tests that declare a secret can consume one, so a batch of ordinary
  // tests asks the DB nothing at all.
  const ids = tests
    .filter((t) => Array.isArray(t.variables) && t.variables.some((v) => v && v.secret))
    .map((t) => t.id);
  if (!ids.length || !db()) return byTest;

  const { rows } = await db().query(
    `select test_id, name, value_ciphertext from test_secrets
      where test_id in (${placeholders(ids)})`,
    ids
  );
  for (const row of rows) {
    const entry = byTest.get(row.test_id) || { values: {} };
    if (entry.error) continue;
    try {
      /** @type {any} */ (entry.values)[row.name] = decryptSecret(Buffer.from(row.value_ciphertext));
    } catch {
      // Named, but not by value: the message is read by a scheduler log line.
      byTest.set(row.test_id, {
        error: `the stored value for ${row.name} could not be decrypted — set it again`,
      });
      continue;
    }
    byTest.set(row.test_id, entry);
  }
  return byTest;
}
