// @ts-check
// US-039 — assertion-first spec, POSITIVE half, against real Postgres: what a
// caller who HAS a key can do. byok-only.test.js pins every refusal; on its own
// that is satisfied by an implementation that refuses everyone, so this file is
// the other half of the claim and the two are only meaningful together.
//
// It needs a real server because **pg-mem cannot store an encrypted key**: it
// round-trips `bytea` through a string, so an AES-GCM ciphertext comes back
// with UTF-8 replacement bytes (72 in, 120 out) and decryptSecret throws
// "unable to authenticate data". Every property below turns on a stored key
// actually decrypting, so under pg-mem they would all fail for a reason that
// has nothing to do with this story. Skips when there is no Postgres, like
// scheduler-postgres.test.js and openai-key-postgres.test.js.
//
// Deliberately the AUTH-OFF single-token self-host, because that is the
// deployment the story's argument rests on ("auth-off mode already has a user
// row"): if the seeded operator cannot store a key and run on it, removing the
// server key strands every self-hoster. The multi-user tenancy properties are
// already pinned by openai-key-postgres.test.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — decisions D1–D9 are listed in byok-only.test.js and apply here.
// Two more that this file is the only place to pin:
//
//   D10 The child env carries the RUN's key and nothing else. `startRun` spreads
//       `...process.env` into the spawn, so `OPENAI_API_KEY: run.openai_api_key`
//       alone is NOT enough — a null lets the server's own ambient
//       OPENAI_API_KEY through the spread and quietly restores the fallback at
//       the one layer that actually spends money. Verified as a live defect:
//       against today's code the "inherits nothing" assertion below reports the
//       ambient key. The implementation must set the key explicitly and REMOVE
//       it when there is none.
//       [REVIEW: confirm the child must see NO OPENAI_API_KEY rather than an
//       empty string — an empty string fails at the OpenAI client with a
//       clearer error than a stale key would.]
//
//   D11 In auth-off mode the key lands on the SEEDED OPERATOR row
//       (getOperatorUserId()), via the existing currentUserId() fallback — no
//       new user, no new column, no per-instance singleton row. Asserted at the
//       database, not just through the API: "it stored somewhere" and "it stored
//       on the row every auth-off request resolves to" are different claims and
//       only the second makes runs work.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import pg from 'pg';
import { RUN_PATHS, seedRunTargets } from './helpers/run-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_byok39_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const TOKEN = 'test-token';
const bearer = { Authorization: `Bearer ${TOKEN}` };
// Present throughout, and must fund nothing (AC #6).
const SERVER_KEY = 'sk-proj-' + 'ServerFallbackMustNeverFundARun0123456789';
const OPERATOR_KEY = 'sk-proj-' + 'Operator1111operator1111operator1111opera';
const KEYLESS_ERROR = 'no OpenAI key: add yours in Settings';

/** @type {pg.Pool | null} */
let pool = null;
/** @type {boolean | string} */
let skip = false;

try {
  const admin = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 2000 });
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const url = new URL(CONNECTION);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString() });
} catch (err) {
  skip = `no Postgres at ${new URL(CONNECTION).host} (${err.code || err.message})`;
  console.log(`byok-postgres: skipped — ${skip}`);
}

/** @type {import('express').Express} */
let app;
/** @type {typeof import('../src/crypto.js')} */
let crypto;
/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {(now?: number) => Promise<any>} */
let tick;
let operatorId = '';
let artifactsDir = '';
let captureDir = '';
/** @type {any} */
let fx;

before(async () => {
  if (skip || !pool) return;
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok39-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok39-cap-'));
  // The self-host default, spelled out: one shared token, no magic-link auth.
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.MAX_CONCURRENT_PER_USER;
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.OPENAI_API_KEY = SERVER_KEY;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'env_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool);
  await initDb(pool);
  operatorId = /** @type {string} */ (getOperatorUserId());
  crypto = await import('../src/crypto.js');
  engine = await import('../src/runs.js');
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));
  fx = await seedRunTargets(pool, operatorId);
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

// --- harness -----------------------------------------------------------------

const startAdHoc = () =>
  request(app)
    .post('/api/runs')
    .set(bearer)
    .send({ goal: 'log in', start_url: 'https://example.test', max_steps: 1 });

const storeKey = (key = OPERATOR_KEY) =>
  request(app).put('/api/account/openai-key').set(bearer).send({ key });

const clearKey = () => request(app).delete('/api/account/openai-key').set(bearer);

async function drain(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = engine.counts();
    if (!active && !queued) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Run `fn` with a fresh capture file and return the OPENAI_API_KEY the child saw. */
async function keyTheChildSaw(fn) {
  const captureFile = path.join(captureDir, `${randomUUID()}.txt`);
  process.env.QA_CAPTURE_FILE = captureFile;
  try {
    await fn();
    await pollUntil(() => fs.existsSync(captureFile));
    return fs.readFileSync(captureFile, 'utf8');
  } finally {
    delete process.env.QA_CAPTURE_FILE;
    await drain();
  }
}

// --- B1: the operator has somewhere to put a key (D7, D11) -------------------

test('the account key surface is reachable with auth off — not 404 (D7)', { skip }, async () => {
  const res = await request(app).get('/api/account/openai-key').set(bearer).expect(200);
  assert.equal(res.body.set, false, 'a fresh instance has no key yet');
  assert.equal(res.body.key, undefined, 'the value is never returned, in any mode');
});

test('with no stored key a run is refused, though OPENAI_API_KEY is set (AC #6)', { skip }, async () => {
  assert.equal(process.env.OPENAI_API_KEY, SERVER_KEY, 'the fallback is configured…');
  const res = await startAdHoc().expect(503);
  assert.equal(res.body.error, KEYLESS_ERROR, '…and funds nothing');
  assert.doesNotMatch(res.body.error, /\.env|restart|docker compose/i, 'the .env instruction is gone');
});

test('the stored key lands on the seeded operator row, encrypted (D11)', { skip }, async () => {
  await storeKey().expect(200);

  const { rows } = await pool.query(
    'select id, openai_key_ciphertext from users where openai_key_ciphertext is not null'
  );
  assert.equal(rows.length, 1, 'exactly one row holds a key');
  assert.equal(rows[0].id, operatorId, 'and it is the row every auth-off request resolves to');
  assert.equal(
    rows[0].openai_key_ciphertext.includes(Buffer.from(OPERATOR_KEY, 'utf8')),
    false,
    'stored as ciphertext, never plaintext'
  );
  assert.equal(crypto.decryptSecret(rows[0].openai_key_ciphertext), OPERATOR_KEY);

  const status = await request(app).get('/api/account/openai-key').set(bearer).expect(200);
  assert.equal(status.body.set, true);
});

// --- B2: every start path works for a keyed caller ---------------------------
// The mirror of byok-only.test.js's refusal table: an implementation that
// refuses everyone satisfies that file and fails this one.

for (const [name, make] of RUN_PATHS) {
  test(`${name} — starts for a caller with a stored key`, { skip }, async () => {
    await storeKey().expect(200);
    const { url, body } = make(fx);
    const res = await request(app).post(url).set(bearer).send(body || {});
    assert.ok(res.status >= 200 && res.status < 300, `expected success, got ${res.status}`);
    await drain();
  });
}

// --- B3: the child gets that key, and only that key (D10) --------------------

test('the child is spawned with the stored key, not the server one (D10)', { skip }, async () => {
  await storeKey().expect(200);
  const seen = await keyTheChildSaw(() => startAdHoc().expect(200));
  assert.equal(seen, OPERATOR_KEY, 'the stored key funded the run');
});

test('a run with no resolved key spawns with no OPENAI_API_KEY at all (D10)', { skip }, async () => {
  // The gate makes this unreachable over HTTP, which is exactly why it is
  // asserted at the engine: `...process.env` in startRun would otherwise hand
  // the child the server's ambient key and restore the fallback one layer down,
  // where the money is actually spent.
  const seen = await keyTheChildSaw(async () => {
    engine.createRun({
      goal: 'unfunded',
      start_url: 'https://example.test',
      max_steps: 1,
      openai_api_key: null,
    });
  });
  assert.equal(seen, '', 'the child inherited nothing — the spread must not leak the ambient key');
});

// --- B4: the scheduler fires for an owner who has one (D5) -------------------

test('a due schedule whose owner has a key still fires (D5)', { skip }, async () => {
  await storeKey().expect(200);
  await pool.query('delete from schedules');
  const now = Date.UTC(2026, 6, 25, 12, 0, 0);
  await pool.query(
    `insert into schedules (user_id, test_id, kind, interval_hours, tz, next_run_at, enabled)
     values ($1, $2, 'hourly', 1, 'UTC', $3, true)`,
    [operatorId, fx.testId, new Date(now - 1000)]
  );

  const result = await tick(now);
  assert.equal(result.keyless, 0, 'nothing to skip');
  assert.equal(result.fired, 1);
  assert.equal(result.runs, 1, 'a stored key is all a scheduled run ever needed');
  await drain();
});

// --- B5: clearing puts it back to refusing -----------------------------------

test('clearing the key refuses runs again — the server key never takes over', { skip }, async () => {
  await storeKey().expect(200);
  await clearKey().expect(204);
  const res = await startAdHoc().expect(503);
  assert.equal(res.body.error, KEYLESS_ERROR);
});
