// @ts-check
// US-005 (BYOK) — assertion-first spec, DB/leak half, against real Postgres.
//
// The stored OpenAI key is a secret at rest, the same class as per-user API
// keys (backlog/correctness-critical.md). The properties here need real DB
// bytea (pg-mem does not round-trip binary faithfully — CLAUDE.md) and the real
// run engine, so this file asks for a Postgres and skips when there isn't one,
// like auth-postgres.test.js. Reviewer's job (assertion-first): tighten these
// BEFORE the implementation. Properties:
//
//   A1 — at rest the column holds ciphertext ONLY: the stored bytea never
//        contains the plaintext key as a substring, and decrypts back to it.
//   A2 — a read never returns the value: the PUT response, the GET status, and
//        /api/auth/me all carry {set, updated_at} and nothing equal to the key.
//   A3 — clearing nulls the column and reports {set:false}.
//   A4 — a malformed key is refused with 400 BEFORE any write (status unchanged).
//   A5 — tenant scoping: one user's set/clear/read never touches another's key.
//   A6 — containment: a resolved run key reaches only the child env
//        OPENAI_API_KEY — never run.goal, run.variables, the persisted runs row,
//        the emitted events, or report_data.json. Request key beats stored key.
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
const DB_NAME = `qassist_byok_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const COOKIE = 'qassist_session';
const SESSION_SECRET = 'test-session-secret-0123456789';
// A distinctive server fallback key, so a test can prove the request/stored key
// — not this one — is what actually reached the agent.
const SERVER_KEY = 'sk-server-fallback-should-not-be-used-000000000000';

const SAMPLE_KEY = 'sk-proj-' + 'Stored1234567890abcdefStored1234567890abcd';

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
  console.log(`openai-key-postgres: skipped — ${skip}`);
}

/** @type {import('express').Express} */
let app;
/** @type {typeof import('../src/auth.js')} */
let auth;
/** @type {typeof import('../src/crypto.js')} */
let crypto;
/** @type {typeof import('../src/runs.js')} */
let engine;
let artifactsDir;
let captureDir;

const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  if (skip || !pool) return;
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok-art-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok-cap-'));
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.WORKER_API_TOKEN = 'legacy-shared-token';
  process.env.OPENAI_API_KEY = SERVER_KEY;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'env_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.REPORTS_ENABLED = '1';
  process.env.ARTIFACTS_DIR = artifactsDir;

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  auth = await import('../src/auth.js');
  crypto = await import('../src/crypto.js');
  engine = await import('../src/runs.js');
  ({ app } = await import('../src/server.js'));
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- A1: ciphertext only at rest ---

test('the stored column holds ciphertext only — no plaintext substring, decrypts back', { skip }, async () => {
  const u = await makeUser('a1@example.com');
  await request(app).put('/api/account/openai-key').set(asUser(u)).send({ key: SAMPLE_KEY }).expect(200);

  const { rows } = await pool.query('select openai_key_ciphertext from users where id = $1', [u]);
  const cipher = rows[0].openai_key_ciphertext;
  assert.ok(Buffer.isBuffer(cipher), 'stored as bytea bytes');
  assert.equal(cipher.includes(Buffer.from(SAMPLE_KEY, 'utf8')), false, 'plaintext is never at rest');
  assert.equal(crypto.decryptSecret(cipher), SAMPLE_KEY, 'but the server can recover it to run');
});

// --- A2: a read never returns the value ---

test('the PUT response, the status, and /me carry {set, updated_at} but never the key', { skip }, async () => {
  const u = await makeUser('a2@example.com');
  const put = await request(app).put('/api/account/openai-key').set(asUser(u)).send({ key: SAMPLE_KEY }).expect(200);
  assert.equal(put.body.set, true);
  assert.ok(put.body.updated_at, 'reports when it was set');
  assert.equal(JSON.stringify(put.body).includes(SAMPLE_KEY), false, 'PUT never echoes the key');

  const status = await request(app).get('/api/account/openai-key').set(asUser(u)).expect(200);
  assert.deepEqual(
    { set: status.body.set, hasValue: JSON.stringify(status.body).includes(SAMPLE_KEY) },
    { set: true, hasValue: false }
  );

  const me = await request(app).get('/api/auth/me').set(asUser(u)).expect(200);
  assert.equal(me.body.openai_key.set, true, '/me surfaces the set state for the UI');
  assert.equal(JSON.stringify(me.body).includes(SAMPLE_KEY), false, '/me never carries the value');
});

// --- A3: clear ---

test('clearing nulls the column and reports set:false', { skip }, async () => {
  const u = await makeUser('a3@example.com');
  await request(app).put('/api/account/openai-key').set(asUser(u)).send({ key: SAMPLE_KEY }).expect(200);
  await request(app).delete('/api/account/openai-key').set(asUser(u)).expect(204);

  const { rows } = await pool.query('select openai_key_ciphertext from users where id = $1', [u]);
  assert.equal(rows[0].openai_key_ciphertext, null, 'the ciphertext is gone, not just flagged');
  const status = await request(app).get('/api/account/openai-key').set(asUser(u)).expect(200);
  assert.equal(status.body.set, false);
});

// --- A4: malformed key refused before any write ---

test('a malformed key is 400 and never written', { skip }, async () => {
  const u = await makeUser('a4@example.com');
  await request(app).put('/api/account/openai-key').set(asUser(u)).send({ key: 'nope' }).expect(400);
  const { rows } = await pool.query('select openai_key_ciphertext from users where id = $1', [u]);
  assert.equal(rows[0].openai_key_ciphertext, null, 'the rejected key left no trace');
  const status = await request(app).get('/api/account/openai-key').set(asUser(u)).expect(200);
  assert.equal(status.body.set, false);
});

// --- A5: tenant scoping ---

test("one user's key is invisible to another, and clear touches only the caller", { skip }, async () => {
  const a = await makeUser('a5a@example.com');
  const b = await makeUser('a5b@example.com');
  await request(app).put('/api/account/openai-key').set(asUser(a)).send({ key: SAMPLE_KEY }).expect(200);

  const bStatus = await request(app).get('/api/account/openai-key').set(asUser(b)).expect(200);
  assert.equal(bStatus.body.set, false, "B sees only B's (unset) key");

  // B clearing does nothing to A.
  await request(app).delete('/api/account/openai-key').set(asUser(b)).expect(204);
  const aStatus = await request(app).get('/api/account/openai-key').set(asUser(a)).expect(200);
  assert.equal(aStatus.body.set, true, "A's key is untouched by B");
});

// --- A6: containment — the resolved key reaches only the child env ---

test('a resolved run key reaches only the child env, and the request key beats the stored one', { skip }, async () => {
  const u = await makeUser('a6@example.com');
  // The user has a stored key; the run supplies a different one per-request.
  await request(app).put('/api/account/openai-key').set(asUser(u)).send({ key: SAMPLE_KEY }).expect(200);
  const REQUEST_KEY = 'sk-proj-' + 'Request9999request9999request9999request99';

  const captureFile = path.join(captureDir, `${randomUUID()}.txt`);
  process.env.QA_CAPTURE_FILE = captureFile;

  // Drive the engine directly with the two things the route resolves: the
  // owning user and the per-request key. Precedence lives in resolveRunKey
  // (pinned purely in openai-key.test.js); here we prove the winner is what the
  // child receives and that it leaks nowhere else.
  const run = engine.createRun({
    goal: 'log in and check the dashboard',
    start_url: 'https://example.test',
    max_steps: 1,
    user_id: u,
    openai_api_key: REQUEST_KEY,
  });
  delete process.env.QA_CAPTURE_FILE;

  await pollUntil(() => fs.existsSync(captureFile));
  const received = fs.readFileSync(captureFile, 'utf8');
  assert.equal(received, REQUEST_KEY, 'the child was spawned with the request key, not the stored/server key');

  // Wait for the run to reach a report so every artifact exists to inspect.
  await pollUntil(() => run.reportStatus === 'ready' || run.reportStatus === 'error');

  const bothKeys = [REQUEST_KEY, SAMPLE_KEY];
  const contains = (/** @type {string} */ hay) => bothKeys.some((k) => hay.includes(k));

  assert.equal(contains(run.goal), false, 'goal is clean');
  assert.equal(contains(JSON.stringify(run.variables || {})), false, 'variables are clean');
  assert.equal(contains(JSON.stringify(run.events || [])), false, 'no event carries a key');

  const { rows } = await pool.query('select * from runs where id = $1', [run.id]);
  assert.equal(contains(JSON.stringify(rows[0])), false, 'no persisted column carries a key');

  const reportData = fs.readFileSync(path.join(artifactsDir, run.id, 'report_data.json'), 'utf8');
  assert.equal(contains(reportData), false, 'report_data.json carries no key');
});
