// @ts-check
// US-064 — assertion-first spec, part 2: THE ROUND TRIP, against real Postgres.
//
// test-secrets.test.js pins the rules on pg-mem and has to seed every stored
// value through the registered `decode` builtin, because **pg-mem cannot
// round-trip a `bytea` parameter** — it squeezes the buffer through a UTF-8
// string, so AES-GCM ciphertext comes back with replacement bytes and
// `decryptSecret` throws (helpers/stored-key.js documents it; US-005 and US-043
// each split a file off for the same reason). `byteaPool` papers over that for
// the product's own parameters, which means the one thing it cannot prove is
// whether the product would have stored something readable WITHOUT the paper.
//
// That is the defect this file exists to catch, and it is invisible from
// outside: a write path that stores unreadable bytes looks identical to a
// working one. The row appears. `value_set` says true. The editor says the
// secret is stored. And then at 02:00 the member is dropped, or — with a less
// careful implementation than this one — the login test types nothing into the
// password field and the report blames the app.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — D1-D14 are in the two files above and apply here. What only a real
// server can hold up:
//
//   D15  STORE → REST → DECRYPT → SPAWN as one unbroken line, asserted at the
//        far end: the bytes the child is handed on QA_VARS are the bytes that
//        went in through the HTTP API. Not "a row changed", which is what
//        pg-mem allows and which a write of garbage also satisfies.
//
//   D16  A ROTATED KEY_ENCRYPTION_SECRET IS THE REAL FORM OF D11. Tampering is
//        the test's stand-in for it; the operator's version is a key rotation
//        or a restore onto a box with a different secret, and AES-GCM's
//        fail-closed guarantee is what turns it into a refused run instead of
//        an empty password field.
//
//   D17  DELETING THE TEST TAKES THE SECRET WITH IT. `on delete cascade` is a
//        real-Postgres property — pg-mem's FK enforcement is not the thing
//        anyone is relying on at 3am — and the failure it prevents is a
//        credential outliving the only row that referenced it, under a
//        `test_id` nothing will ever join to again.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_sec64_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const OPERATOR_KEY = 'sk-proj-' + 'Operator1111operator1111operator1111opera';
const CANARY = 'CANARY-PG-PW-8c04de';

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
  console.log(`test-secrets-postgres: skipped — ${skip}`);
}

/** @type {any} */ let app;
let artifactsDir = '';
let captureDir = '';
let captureFile = '';

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const capturedRuns = () =>
  fs
    .readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

before(async () => {
  if (skip || !pool) return;
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sec64-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sec64-cap-'));
  captureFile = path.join(captureDir, 'qa-vars.jsonl');
  fs.writeFileSync(captureFile, '');
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.STRIPE_SECRET_KEY;
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'vars_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.QA_CAPTURE_FILE = captureFile;

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool);
  await initDb(pool);
  const { encryptSecret } = await import('../src/crypto.js');
  await pool.query('update users set openai_key_ciphertext = $2 where id = $1', [
    getOperatorUserId(),
    encryptSecret(OPERATOR_KEY),
  ]);
  ({ app } = await import('../src/server.js'));
});

after(async () => {
  if (pool) await pool.end();
  for (const dir of [artifactsDir, captureDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (skip) return;
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`).catch(() => {});
  await admin.end();
});

const makeTest = (name, overrides = {}) =>
  request(app)
    .post('/api/tests')
    .set(auth)
    .send({
      name,
      goal: 'log in as admin with {{pw}}',
      start_url: 'https://example.test/login',
      variables: [{ name: 'pw', value: CANARY, secret: true }],
      ...overrides,
    });

test('a secret stored through the API is at rest, and comes back out (D15)', { skip }, async () => {
  const created = (await makeTest('admin login').expect(201)).body;

  const stored = (
    await pool.query('select value_ciphertext from test_secrets where test_id = $1', [created.id])
  ).rows[0];
  assert.equal(
    Buffer.from(stored.value_ciphertext).toString('utf8').includes(CANARY),
    false,
    'the secret is at rest in the clear'
  );

  // The leg pg-mem cannot reach: through the real `bytea` parameter binding,
  // back out, and into the child. A write of unreadable bytes passes every
  // assertion in test-secrets.test.js and fails here.
  const { runId } = (await request(app).post(`/api/tests/${created.id}/run`).set(auth).expect(200))
    .body;
  await pollUntil(async () => capturedRuns().length > 0);
  const [child] = capturedRuns();
  assert.deepEqual(JSON.parse(child.vars), { pw: CANARY });
  assert.equal(child.goal, 'log in as admin with <secret>pw</secret>');

  const row = (await pool.query('select goal, variables from runs where id = $1', [runId])).rows[0];
  assert.deepEqual(row.variables, { pw: '<secret>' });
  assert.doesNotMatch(JSON.stringify(row), new RegExp(CANARY));
});

test('a rotated encryption secret refuses the run, it does not run it empty (D16)', { skip }, async () => {
  const created = (await makeTest('rotated login').expect(201)).body;
  // What a key rotation or a restore onto another box looks like from here:
  // bytes that are no longer ours. AES-GCM fails closed, so this is a throw
  // inside the resolver rather than a wrong plaintext.
  await pool.query(
    `update test_secrets set value_ciphertext = decode(md5(random()::text) || md5(random()::text), 'hex')
      where test_id = $1`,
    [created.id]
  );
  const before = capturedRuns().length;
  const refused = await request(app).post(`/api/tests/${created.id}/run`).set(auth).expect(400);
  assert.match(refused.body.error, /could not be decrypted/i);
  assert.equal(
    (await pool.query('select 1 from runs where test_id = $1', [created.id])).rowCount,
    0,
    'no run row: a refused member is not a run'
  );
  assert.equal(capturedRuns().length, before, 'and nothing was spawned');
});

test('deleting the test takes its stored secrets with it (D17)', { skip }, async () => {
  const created = (await makeTest('disposable login').expect(201)).body;
  assert.equal(
    (await pool.query('select 1 from test_secrets where test_id = $1', [created.id])).rowCount,
    1
  );

  await request(app).delete(`/api/tests/${created.id}`).set(auth).expect(204);
  assert.equal(
    (await pool.query('select 1 from test_secrets where test_id = $1', [created.id])).rowCount,
    0,
    'a credential must not outlive the only row that referenced it'
  );
});

test('the same name on two tests is two independent secrets', { skip }, async () => {
  const a = (await makeTest('shop login').expect(201)).body;
  const b = (await makeTest('admin panel login', {
    variables: [{ name: 'pw', value: 'a-different-one', secret: true }],
  }).expect(201)).body;

  const { decryptSecret } = await import('../src/crypto.js');
  const valueOf = async (id) =>
    decryptSecret(
      (await pool.query('select value_ciphertext from test_secrets where test_id = $1', [id]))
        .rows[0].value_ciphertext
    );
  assert.equal(await valueOf(a.id), CANARY);
  assert.equal(await valueOf(b.id), 'a-different-one');

  // And replacing one leaves the other alone — the key is (test_id, name), so
  // an upsert that forgot half of it would overwrite a stranger's credential.
  await request(app)
    .put(`/api/tests/${b.id}`)
    .set(auth)
    .send({ variables: [{ name: 'pw', value: 'rotated', secret: true }] })
    .expect(200);
  assert.equal(await valueOf(a.id), CANARY);
  assert.equal(await valueOf(b.id), 'rotated');
});
