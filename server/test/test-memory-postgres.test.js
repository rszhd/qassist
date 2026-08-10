// @ts-check
// US-081's notebook write, on a real Postgres.
//
// What is left here after the conditional write was removed: the upsert itself,
// the `jsonb` round trip, and the cascade. pg-mem passes all three whether or not
// they are right — it stores jsonb loosely and its `on conflict do update` is not
// Postgres's — so the assertions live where the real engine can answer them.
//
// The refusal this file used to exist for is gone with the fingerprint: a run in
// flight while its test is edited now teaches what it saw, because an edit no
// longer invalidates anything.
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

/** A saved test and one finished run of it. */
async function seed() {
  const testId = randomUUID();
  await pool.query(
    `insert into tests (id, user_id, name, goal, start_url, max_steps)
     values ($1, $2, 'billing', 'check the invoice', 'https://billing.example.test/', 60)`,
    [testId, userId]
  );
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status, memory_used)
     values ($1, $2, $3, 'check the invoice', 'https://billing.example.test/', 60, 'passed', false)`,
    [runId, testId, userId]
  );
  return { id: runId, test_id: testId, persisted: Promise.resolve() };
}

const memoryOf = async (testId) =>
  (await pool.query('select * from test_memory where test_id = $1', [testId])).rows[0] || null;

test('a passing run writes its notebook, and a later one replaces it', { skip }, async () => {
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  const run = await seed();
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;
  const first = await memoryOf(run.test_id);
  assert.equal(first.learned.successful_approach[0].text, 'Open Billing from the account menu');
  assert.ok(first.learned_at, 'and says when');

  // The upsert. One row per test, so two runs of one test cannot leave two
  // notebooks to choose between — the merge that decided what this holds already
  // happened in `agent/run_memory.py`.
  run.persisted = Promise.resolve();
  runPersistence.storeLearned(run, notebook('Open Billing from the workspace sidebar'));
  await run.persisted;
  const second = await memoryOf(run.test_id);
  assert.equal(second.learned.successful_approach[0].text, 'Open Billing from the workspace sidebar');
  assert.equal((await pool.query('select count(*) from test_memory')).rows[0].count, '1');
});

test('a lesson survives the jsonb round trip with its provenance', { skip }, async () => {
  // The panel keys on `id` and the eviction backstop reads `learned_at`, so a
  // round trip that loses either is a notebook that cannot be edited or trimmed.
  const run = await seed();
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;
  const [item] = (await memoryOf(run.test_id)).learned.successful_approach;
  assert.equal(item.id, 'Open');
  assert.deepEqual(item.steps, [1]);
  assert.equal(item.run_id, 'r');
});

test('a deleted test takes its notebook with it', { skip }, async () => {
  const run = await seed();
  runPersistence.storeLearned(run, notebook('Open Billing from the account menu'));
  await run.persisted;

  await pool.query('delete from tests where id = $1', [run.test_id]);
  assert.equal(await memoryOf(run.test_id), null, 'disposable, and the cascade says so');
});
