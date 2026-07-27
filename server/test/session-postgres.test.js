// @ts-check
// US-043 — assertion-first spec, part 3: THE ROUND TRIP, against real Postgres.
//
// session-containment.test.js pins containment on pg-mem and stops one step
// short of the claim that matters most for someone who has never used
// Playwright: that a session CAPTURED BY A LOGIN RUN can then be read back out
// and actually start a browser. It cannot go further there, because **pg-mem
// cannot round-trip a `bytea` parameter** — it squeezes the buffer through a
// UTF-8 string, so AES-GCM ciphertext comes back with replacement bytes and
// `decryptSecret` throws (helpers/stored-key.js documents this; US-039 split
// byok-postgres.test.js off for exactly the same reason).
//
// That limitation hides the one defect this file exists to catch: a capture
// path that writes the blob in a form nothing can read back looks *identical*
// to a working one from the outside. The row changes. `captured_at` moves. The
// UI says "from a login run, today". And every test in the project then refuses
// to start, or — with a less careful implementation than this one — starts
// signed out and fails everything for a reason pointing at the goal.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — decisions D1-D15 are listed in the two files above and apply here.
// What only a real server can hold up:
//
//   D16  CAPTURE → STORE → DECRYPT → SPAWN, as one unbroken line, asserted at
//        the far end: the bytes the child opens are the bytes the login run
//        exported. Not "the ciphertext changed", which is what pg-mem allows
//        and which a write of unreadable garbage also satisfies.
//
//   D17  THE CIPHERTEXT IS CIPHERTEXT AT REST even when it arrived via the
//        capture path rather than the paste. Two writers, one column, and the
//        one that runs unattended at 3am is the one nobody watches.
//
//   D18  A SECOND LOGIN RUN REPLACES the first capture, and the run after it
//        gets the NEW bytes. Refresh is the whole point of the login-run route,
//        and an implementation that inserts-if-absent rather than updating
//        would pass every assertion in the other two files.
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
const DB_NAME = `qassist_sess43_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const OPERATOR_KEY = 'sk-proj-' + 'Operator1111operator1111operator1111opera';

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
  console.log(`session-postgres: skipped — ${skip}`);
}

/** @type {any} */ let app;
let artifactsDir = '';
let sessionsDir = '';
let captureDir = '';
let projectId = '';

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const capturedEnv = (runId) =>
  JSON.parse(fs.readFileSync(path.join(captureDir, `${runId}.json`), 'utf8'));

before(async () => {
  if (skip || !pool) return;
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess43-'));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess43-blobs-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess43-cap-'));
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.STRIPE_SECRET_KEY;
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'session_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.QA_CAPTURE_DIR = captureDir;

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool);
  await initDb(pool);
  const { encryptSecret } = await import('../src/crypto.js');
  await pool.query('update users set openai_key_ciphertext = $2 where id = $1', [
    getOperatorUserId(),
    encryptSecret(OPERATOR_KEY),
  ]);
  ({ app } = await import('../src/server.js'));

  projectId = (await request(app).post('/api/projects').set(auth).send({ name: 'shop' }).expect(201))
    .body.id;
});

after(async () => {
  if (pool) await pool.end();
  for (const dir of [artifactsDir, sessionsDir, captureDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (skip) return;
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`).catch(() => {});
  await admin.end();
});

async function seedTest(name, sessionId = null) {
  const { rows } = await pool.query(
    `insert into tests (user_id, name, goal, start_url, max_steps, project_id, browser_session_id)
     values ((select id from users limit 1), $1, 'do the thing', 'https://example.test/', 3, $2, $3)
     returning id`,
    [name, projectId, sessionId]
  );
  return rows[0].id;
}

test('a login run captures a session that later runs can actually use', { skip }, async () => {
  const loginTestId = await seedTest('log in');
  const session = (
    await request(app)
      .post(`/api/projects/${projectId}/sessions`)
      .set(auth)
      .send({ name: 'captured', login_test_id: loginTestId })
      .expect(201)
  ).body;
  assert.equal(session.captured_at, null);

  // The login run fills it.
  await request(app).post(`/api/tests/${loginTestId}/run`).set(auth).send({}).expect(200);
  await pollUntil(async () => {
    const { rows } = await pool.query(
      'select storage_state_ciphertext from browser_sessions where id = $1',
      [session.id]
    );
    return !!rows[0].storage_state_ciphertext;
  });

  // D17: what landed is ciphertext, not the blob. The capture path writes this
  // column unattended, which makes it the writer nobody is watching.
  const stored = (
    await pool.query(
      'select storage_state_ciphertext, cookie_count, source from browser_sessions where id = $1',
      [session.id]
    )
  ).rows[0];
  assert.equal(
    Buffer.from(stored.storage_state_ciphertext).toString('utf8').includes('FRESHLY-CAPTURED'),
    false,
    'the captured session is at rest in the clear'
  );
  assert.equal(stored.cookie_count, 1);
  assert.equal(stored.source, 'login_run');

  // D16: and it decrypts, all the way to the bytes the child opens. This is the
  // leg pg-mem cannot reach, and the one a write of unreadable garbage passes
  // every other assertion in this story without.
  const memberId = await seedTest('behind the login', session.id);
  const runId = (await request(app).post(`/api/tests/${memberId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(path.join(captureDir, `${runId}.json`)));
  const child = capturedEnv(runId);
  assert.equal(child.storage_state_is_file, true, 'the child must be handed a real file');
  assert.match(
    child.storage_state_contents,
    /FRESHLY-CAPTURED/,
    'the file must hold what the login run captured'
  );
});

test('a second login run replaces the first capture', { skip }, async () => {
  const loginTestId = await seedTest('log in again');
  const session = (
    await request(app)
      .post(`/api/projects/${projectId}/sessions`)
      .set(auth)
      .send({ name: 'refreshed twice', login_test_id: loginTestId })
      .expect(201)
  ).body;

  await request(app).post(`/api/tests/${loginTestId}/run`).set(auth).send({}).expect(200);
  const first = await pollUntil(async () => {
    const { rows } = await pool.query(
      'select storage_state_ciphertext, captured_at from browser_sessions where id = $1',
      [session.id]
    );
    return rows[0].storage_state_ciphertext ? rows[0] : null;
  });

  await new Promise((r) => setTimeout(r, 10)); // so captured_at can move
  await request(app).post(`/api/tests/${loginTestId}/run`).set(auth).send({}).expect(200);
  const second = await pollUntil(async () => {
    const { rows } = await pool.query(
      'select storage_state_ciphertext, captured_at, cookie_count from browser_sessions where id = $1',
      [session.id]
    );
    return rows[0].captured_at > first.captured_at ? rows[0] : null;
  });

  // Fresh IV per encrypt, so the bytes differ even for identical plaintext —
  // which is the property that makes "it was rewritten" checkable at all.
  assert.notEqual(
    Buffer.from(second.storage_state_ciphertext).toString('hex'),
    Buffer.from(first.storage_state_ciphertext).toString('hex')
  );
  assert.equal(second.cookie_count, 1, 'an update, not an accumulating insert');

  // And a run after the refresh still gets a usable blob.
  const memberId = await seedTest('after the refresh', session.id);
  const runId = (await request(app).post(`/api/tests/${memberId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(path.join(captureDir, `${runId}.json`)));
  assert.match(capturedEnv(runId).storage_state_contents, /FRESHLY-CAPTURED/);
});

test('a pasted session decrypts on a real server too', { skip }, async () => {
  // The other writer, through the HTTP path pg-mem corrupts. Both writers, one
  // column, and only a real server can prove either reads back.
  const session = (
    await request(app)
      .post(`/api/projects/${projectId}/sessions`)
      .set(auth)
      .send({
        name: 'pasted for real',
        storage_state: {
          cookies: [
            { name: 'sid', value: 'PASTED-BY-HAND', domain: '.example.test', path: '/', expires: -1 },
          ],
        },
      })
      .expect(201)
  ).body;
  assert.ok(session.captured_at, 'a pasted session is captured now');

  const memberId = await seedTest('uses the pasted one', session.id);
  const runId = (await request(app).post(`/api/tests/${memberId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(path.join(captureDir, `${runId}.json`)));
  assert.match(capturedEnv(runId).storage_state_contents, /PASTED-BY-HAND/);
});
