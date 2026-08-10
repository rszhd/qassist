// @ts-check
// US-081's conditional write, which only a real Postgres can hold up.
//
// `storeLearned` is an `insert … on conflict do update … where
// test_memory.fingerprint = $2`. Two runs of one test can be in flight together
// and a test can be edited while a run is going, so the `where` is what refuses
// a run that started before the edit: without it the row looks freshly learned
// while its advice describes an app the test no longer points at, and nothing
// about that is visible afterwards.
//
// pg-mem cannot prove any of it. Its `on conflict do update` accepts the
// statement and its handling of a WHERE on the conflict target is not
// Postgres's, so a refusal that never happens still reads green there — which is
// the exact shape `docs/testing.md` warns about: SQL whose *correctness* needs
// real database semantics gets a real server.
//
// Same isolation as `scheduler-postgres.test.js`: a throwaway database, created
// and dropped here, so these writes cannot reach the caller's data and the real
// `db/migrations/*.sql` are exercised against a real server on the way in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_memory_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
  console.log(`test-memory-postgres: skipped — ${skip}`);
}

let userId = '';
/** @type {any} */
let runPersistence;

before(async () => {
  if (skip || !pool) return;
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  runPersistence = await import('../src/runPersistence.js');
  const { rows } = await pool.query('select id from users limit 1');
  userId = rows[0].id;
});

after(async () => {
  if (!pool) return;
  await pool.end(); // a database with a live connection cannot be dropped
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

const notebook = (text) => ({
  successful_approach: [{ id: text.slice(0, 4), text, steps: [1], run_id: 'r' }],
  avoid_next_time: [],
  orientation: [],
});

/** A saved test, and one finished run of it carrying the fingerprint it started with. */
async function seed(fingerprint) {
  const testId = randomUUID();
  await pool.query(
    `insert into tests (id, user_id, name, goal, start_url, max_steps)
     values ($1, $2, 'billing', 'check the invoice', 'https://billing.example.test/', 60)`,
    [testId, userId]
  );
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status,
                       memory_used, memory_fingerprint)
     values ($1, $2, $3, 'check the invoice', 'https://billing.example.test/', 60, 'passed',
             false, $4)`,
    [runId, testId, userId, fingerprint]
  );
  return {
    id: runId,
    test_id: testId,
    memory_fingerprint: fingerprint,
    persisted: Promise.resolve(),
  };
}

const memoryOf = async (testId) =>
  (await pool.query('select * from test_memory where test_id = $1', [testId])).rows[0] || null;

test('a run teaches the inputs it ran with', { skip }, async () => {
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  const run = await seed('fingerprint-a');
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;

  const stored = await memoryOf(run.test_id);
  assert.equal(stored.fingerprint, 'fingerprint-a');
  assert.equal(stored.learned.successful_approach[0].text, 'Open Billing from the account menu');
});

test('a run that started before an edit cannot teach the inputs it never ran with', { skip }, async () => {
  // The sharp edge. The row now belongs to `fingerprint-b`; this run began under
  // `fingerprint-a` and knows nothing about the change. A blind upsert would
  // write, and the result would be a freshly-stamped notebook describing an app
  // the test no longer points at — invisible afterwards, because everything
  // about the row looks right.
  const run = await seed('fingerprint-a');
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;

  await pool.query('update test_memory set fingerprint = $2 where test_id = $1', [
    run.test_id,
    'fingerprint-b',
  ]);

  run.persisted = Promise.resolve();
  runPersistence.storeLearned(run, notebook('Open Billing from the workspace sidebar'));
  await run.persisted;

  const stored = await memoryOf(run.test_id);
  assert.equal(stored.fingerprint, 'fingerprint-b', 'the row still belongs to the edited test');
  assert.equal(
    stored.learned.successful_approach[0].text,
    'Open Billing from the account menu',
    'the stale run wrote nothing'
  );
});

test('a refused write is silent, not an error', { skip }, async () => {
  // Zero rows matched is the intended outcome, not a failure to report: the test
  // changed under this run, and the next one learns it fresh. A rejection here
  // would turn an optimisation into a reason a run ends badly.
  const run = await seed('fingerprint-a');
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;
  await pool.query('update test_memory set fingerprint = $2 where test_id = $1', [
    run.test_id,
    'fingerprint-b',
  ]);

  run.persisted = Promise.resolve();
  runPersistence.storeLearned(run, notebook('something else'));
  await assert.doesNotReject(() => run.persisted);
});

test('a deleted test takes its notebook with it', { skip }, async () => {
  const run = await seed('fingerprint-a');
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;

  await pool.query('delete from tests where id = $1', [run.test_id]);
  assert.equal(await memoryOf(run.test_id), null, 'disposable, and the cascade says so');
});
