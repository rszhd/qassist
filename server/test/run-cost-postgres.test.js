// @ts-check
// The two halves of US-046's cost storage that only a real Postgres can hold up.
//
// **The type.** `total_cost` is `numeric`, and `pg` returns numeric as a
// STRING — deliberately, because numeric is arbitrary-precision and a double
// cannot hold all of it. pg-mem hands back a JavaScript number instead, so
// every assertion in `run-cost.test.js` passes there whether or not the read
// path converts. Untouched, the same run answers `0.041` while it is live in
// the relay and `"0.041000"` once it is only a row, and a client summing a page
// of history concatenates strings into nonsense.
//
// **The constraint.** `runs_cost_known_has_a_number` is what stops the pair
// this story exists to prevent — `cost_known` false beside a number, or true
// beside a null — from ever being written by a later caller who read one column
// and not the other. pg-mem enforces its own idea of a check constraint; what
// ships is Postgres's.
//
// Same isolation as `scheduler-postgres.test.js`: a throwaway database, created
// and dropped here, so these writes cannot reach the caller's data and the real
// `db/migrations/*.sql` are exercised against a real server on the way in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_cost_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** @type {import('express').Express} */
let app;
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
  console.log(`run-cost-postgres: skipped — ${skip}`);
}

let userId = '';

before(async () => {
  if (skip || !pool) return;
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  const { rows } = await pool.query('select id from users limit 1');
  userId = rows[0].id;
  ({ app } = await import('../src/server.js'));
});

after(async () => {
  if (!pool) return;
  await pool.end(); // a database with a live connection cannot be dropped
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

/** Insert a finished run carrying the given cost columns. */
async function insertRun(costKnown, totalCost) {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status,
                       prompt_tokens, completion_tokens, total_tokens,
                       total_cost, cost_known)
     values ($1, $2, 'buy a thing', 'https://shop.example.test/', 60, 'passed',
             12000, 800, 12800, $3, $4)`,
    [id, userId, totalCost, costKnown]
  );
  return id;
}

test('a stored cost comes back as a string, and the read path is what fixes it', { skip }, async () => {
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  const id = await insertRun(true, 0.041);
  const { rows } = await pool.query('select total_cost, cost_known from runs where id = $1', [id]);

  // The driver's behaviour, pinned so a future reader knows the conversion in
  // `shapeRun` is load-bearing rather than defensive. If pg ever returns a
  // number here this assertion fails, and the conversion becomes a no-op that
  // can then be removed on purpose instead of by accident.
  assert.equal(typeof rows[0].total_cost, 'string');
  assert.equal(Number(rows[0].total_cost), 0.041);
  assert.equal(rows[0].cost_known, true);
});

test('numeric holds the cost exactly, where a float would drift', { skip }, async () => {
  // Six decimal places of a per-token price, summed over a nightly suite, is
  // the whole reason this column is not float8.
  const id = await insertRun(true, 0.000001);
  const { rows } = await pool.query('select total_cost from runs where id = $1', [id]);
  assert.equal(rows[0].total_cost, '0.000001');
});

test('an unknown cost cannot be stored with a number beside it', { skip }, async () => {
  // The story's failure mode, refused by the row itself. A later writer that
  // reads `usage.total_cost` and forgets `usage.cost_known` fails loudly here
  // instead of quietly putting $0.00 into someone's history.
  await assert.rejects(
    () => insertRun(false, 0.041),
    /runs_cost_known_has_a_number/,
    'cost_known false with a number must be refused'
  );
});

test('a known cost cannot be stored without a number', { skip }, async () => {
  // The mirror, and the one that would render as "$" with nothing after it.
  await assert.rejects(
    () => insertRun(true, null),
    /runs_cost_known_has_a_number/,
    'cost_known true with a null must be refused'
  );
});

test('the unmeasured pair is legal, because it is what every old row is', { skip }, async () => {
  const id = await insertRun(false, null);
  const { rows } = await pool.query('select total_cost, cost_known from runs where id = $1', [id]);
  assert.equal(rows[0].total_cost, null);
  assert.equal(rows[0].cost_known, false);
});

// ── The History total (tier 2) ───────────────────────────────────────────────
//
// Its behaviour is pinned next door in `run-cost.test.js`. What is here is the
// half pg-mem would wave through: `sum(numeric)` is a STRING out of `pg` for
// the same reason a single `total_cost` is, and money that accumulates in a
// double drifts on the third addition. Both produce a total that is very nearly
// right, which is the only kind of wrong this story is about.

/** Insert a finished run into one window, with the cost columns stated. */
async function insertAt(when, tokens, cost, known) {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status,
                       created_at, finished_at, total_tokens, total_cost, cost_known)
     values ($1, $2, 'api', 'g', 'https://shop.example.test/', 60, 'passed',
             $3, $3, $4, $5, $6)`,
    [id, userId, when.toISOString(), tokens, cost, known]
  );
  return id;
}

/** A private hour to seed into, expressed as the filter that selects it. */
let hour = 0;
function nextWindow() {
  const start = new Date(Date.UTC(2019, 0, 1) + hour++ * 3600e3);
  return {
    at: new Date(start.getTime() + 60e3),
    query:
      `since=${start.toISOString()}` +
      `&until=${new Date(start.getTime() + 3600e3).toISOString()}`,
  };
}

async function history(window) {
  const { body } = await request(app)
    .get(`/api/runs?${window.query}`)
    .set({ Authorization: 'Bearer test-token' })
    .expect(200);
  return body;
}

test('the History total leaves as a number, not the string sum(numeric) returns', { skip }, async () => {
  // The same trap `shapeRun` already handles for one row, one level up and easy
  // to miss because the row beside it is already converted. Untouched, the
  // total reaches the browser as "0.750000" and `total.toFixed(2)` throws — or
  // worse, a client adding it to something else concatenates.
  const w = nextWindow();
  await insertAt(w.at, 1000, 0.25, true);
  await insertAt(w.at, 1000, 0.5, true);

  const body = await history(w);
  assert.equal(typeof body.usage.total_cost, 'number', 'a string here is the bug');
  assert.equal(body.usage.total_cost, 0.75);
  assert.equal(typeof body.usage.priced_runs, 'number');
});

test('the total accumulates exactly, where a float would drift', { skip }, async () => {
  // Three tenths of a dollar. In float8 this sum is 0.30000000000000004, and
  // that is what `numeric` on the column is for — asserted through the API,
  // because the column being numeric proves nothing if the sum is cast on the
  // way out. A nightly suite adds forty of these every night.
  const w = nextWindow();
  for (let i = 0; i < 3; i++) await insertAt(w.at, 1000, 0.1, true);

  const body = await history(w);
  assert.equal(body.usage.total_cost, 0.3);
  assert.equal(body.usage.priced_runs, 3);
});

test('an all-unpriced set sums to null through a real driver too', { skip }, async () => {
  // `sum()` over no rows is null in Postgres, and the whole rule is that it
  // must stay null. pg-mem agrees today; this is the one that will still be
  // true if it stops agreeing.
  const w = nextWindow();
  await insertAt(w.at, 1000, null, false);
  await insertAt(w.at, 2000, null, false);

  const body = await history(w);
  assert.equal(body.usage.total_cost, null);
  assert.equal(body.usage.priced_runs, 0);
  assert.equal(body.usage.total_tokens, 3000, 'tokens do not go quiet with cost');
});
