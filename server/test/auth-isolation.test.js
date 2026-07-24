// @ts-check
// US-021 — assertion-first spec for the two DB-backed correctness surfaces of
// multi-user auth (correctness-critical): the single-use / expiry login-link
// consume, and cross-tenant isolation. Runs the real migrations on pg-mem and
// drives the real app, exactly like control-plane.test.js.
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
// The two properties they defend:
//
//   C — consuming a login link is atomic, single-use and expiry-bounded: the
//       same secret can be redeemed at most once, never after it expires, and
//       a first redemption creates the user (signup == login).
//   I — a request only ever reaches its own user's rows and artifacts. A user
//       authenticated as A can neither read nor act on B's test, run, report or
//       recording; the response is 404 (existence is not revealed), and with
//       AUTH_ENABLED an unauthenticated request — including one bearing the
//       legacy WORKER_API_TOKEN — is refused.
//
// NOTE FOR REVIEW: the atomic single-use claim under *concurrent* redemption is
// the same class as the scheduler claim — pg-mem cannot prove it (its query
// engine is not concurrent). If we keep this test, it pins the logic; a real
// double-redeem race wants a scheduler-postgres.test.js-style real-Postgres
// test. Flagging rather than silently relying on pg-mem here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-session-secret-0123456789';
const COOKIE = 'qassist_session'; // the session cookie name (assert against auth.SESSION_COOKIE once it exists)

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
let artifactsDir;

/** A signed-cookie header for a userId, as a browser would send it. */
const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-auth-test-'));
  // AUTH_ENABLED requires DB + mail sender + session secret; set all so the app
  // boots in multi-user mode. WORKER_API_TOKEN is set on purpose: the spec
  // requires it to be *rejected* while auth is on.
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.WORKER_API_TOKEN = 'legacy-shared-token';
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  auth = await import('../src/auth.js');
  ({ app } = await import('../src/server.js'));
});

/** Insert a user directly and return its id. */
async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

// --- C: login-link consume ---

test('a login link is single-use: the second redemption fails', async () => {
  const token = await auth.createLoginToken('alice@example.com');
  const first = await auth.consumeLoginToken(token);
  assert.equal(first?.email, 'alice@example.com');
  const second = await auth.consumeLoginToken(token);
  assert.equal(second, null);
});

test('an expired login link cannot be consumed', async () => {
  const token = await auth.createLoginToken('bob@example.com', { now: 0 });
  const consumed = await auth.consumeLoginToken(token, {
    now: auth.LOGIN_TOKEN_TTL_MS + 1,
  });
  assert.equal(consumed, null);
});

test('first consume creates the user (signup == login)', async () => {
  const email = 'newcomer@example.com';
  const before = await pool.query('select 1 from users where email = $1', [email]);
  assert.equal(before.rowCount, 0);
  const token = await auth.createLoginToken(email);
  const { userId } = /** @type {any} */ (await auth.consumeLoginToken(token));
  const after = await pool.query('select id from users where email = $1', [email]);
  assert.equal(after.rows[0].id, userId);
});

// --- I: cross-tenant isolation ---

test('with AUTH_ENABLED, an unauthenticated request is refused', async () => {
  await request(app).get('/api/tests').expect(401);
});

test('the legacy WORKER_API_TOKEN bearer is rejected while auth is on', async () => {
  await request(app)
    .get('/api/tests')
    .set('Authorization', 'Bearer legacy-shared-token')
    .expect(401);
});

test('a user sees only their own tests', async () => {
  const a = await makeUser('a-tests@example.com');
  const b = await makeUser('b-tests@example.com');

  const made = await request(app)
    .post('/api/tests')
    .set(asUser(a))
    .send({ name: 'A test', goal: 'do a thing', start_url: 'https://a.example.com' })
    .expect(201);
  const testId = made.body.id;

  const aList = await request(app).get('/api/tests').set(asUser(a)).expect(200);
  assert.ok(aList.body.tests.some((/** @type {any} */ t) => t.id === testId));

  const bList = await request(app).get('/api/tests').set(asUser(b)).expect(200);
  assert.ok(!bList.body.tests.some((/** @type {any} */ t) => t.id === testId));

  // Direct fetch of A's test as B must 404 — not 403, which would confirm it exists.
  await request(app).get(`/api/tests/${testId}`).set(asUser(b)).expect(404);
  await request(app).get(`/api/tests/${testId}`).set(asUser(a)).expect(200);
});

test("a user cannot read another user's run, report or recording", async () => {
  const a = await makeUser('a-runs@example.com');
  const b = await makeUser('b-runs@example.com');

  // A finished run owned by A, with a report + recording on disk.
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status,
                       report_status, has_recording, finished_at)
     values ($1, $2, 'api', 'g', 'https://a.example.com', 60, 'passed', 'ready', true, now())`,
    [runId, a]
  );
  const dir = path.join(artifactsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.pdf'), '%PDF-1.4 test');
  fs.writeFileSync(path.join(dir, 'recording.mp4'), 'not really an mp4');

  // A reaches all three.
  assert.ok((await request(app).get('/api/runs').set(asUser(a))).body.runs.some(
    (/** @type {any} */ r) => r.id === runId
  ));
  await request(app).get(`/api/runs/${runId}`).set(asUser(a)).expect(200);
  await request(app).get(`/api/runs/${runId}/report.pdf`).set(asUser(a)).expect(200);
  await request(app).get(`/api/runs/${runId}/recording`).set(asUser(a)).expect(200);

  // B reaches none: the list excludes it, and each artifact 404s.
  assert.ok(!(await request(app).get('/api/runs').set(asUser(b))).body.runs.some(
    (/** @type {any} */ r) => r.id === runId
  ));
  await request(app).get(`/api/runs/${runId}`).set(asUser(b)).expect(404);
  await request(app).get(`/api/runs/${runId}/report.pdf`).set(asUser(b)).expect(404);
  await request(app).get(`/api/runs/${runId}/recording`).set(asUser(b)).expect(404);
});
