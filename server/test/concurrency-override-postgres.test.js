// @ts-check
// US-058 — assertion-first spec, part 3: the COLUMN and the LOADERS, against
// real Postgres.
//
// Real Postgres and not pg-mem, for two reasons that are the same reason twice.
// The whole safety story for `max_concurrent_runs` is a CHECK constraint —
// `> 0`, which is what keeps a capacity feature from quietly becoming an
// account suspension (D14) — and pg-mem's constraint handling is exactly the
// area `docs/testing.md` says not to trust: it will happily accept a row a real
// server refuses, so a test that "proves" zero is rejected there proves nothing
// about the box. And the loader reads an integer column that may be NULL for
// most rows; pg-mem's typing of a nullable int through the pg driver is not the
// thing to bet the resolution order on.
//
// Isolation is a throwaway database created and dropped here, exactly as
// scheduler-postgres.test.js does it and for the same reason: the migration
// runner finds its bookkeeping table through the search path, so a schema-scoped
// run would decide the schema was already migrated. Migrating a fresh database
// is also how `db/migrations/012_*.sql` gets exercised against a real server at
// all.
//
// REVIEWER — what this file is signing off, beyond the shared decisions in
// concurrency-override.test.js's header:
//
//   * the migration is `012_user_concurrency_override.sql`, one column on
//     `users`: `max_concurrent_runs int check (max_concurrent_runs > 0)`.
//     Nullable, no default, no backfill — every existing row is already in the
//     "no override" state, which is what makes this inert on a self-host.
//     [REVIEW: the column NAME especially. `users.max_concurrent_runs` reads
//     well next to `MAX_CONCURRENT_PER_USER`, but it is a column an operator
//     types by hand and it is permanent.]
//
//   * `writeUserConcurrencyCap` is the ONE statement in the codebase that
//     writes this column, the way `activateByEmail` is for `activated_at`. It
//     writes through to the in-process cache as well, so the server that
//     performs the write never needs a reload — and `npm run concurrency`,
//     which runs in its own process, is the case where that does nothing and
//     the refresh-on-submit of D12 is what carries it.
//
//   * D13 is asserted, not just written down: a cap ABOVE
//     MAX_CONCURRENT_SESSIONS is stored without complaint. If you would rather
//     it were refused, that refusal has to live in the script (a constraint
//     cannot see an env var) and this assertion inverts.
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
const DB_NAME = `qassist_cap_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
  console.log(`concurrency-override-postgres: skipped — ${skip}`);
}

/** @type {typeof import('../src/concurrency.js')} */
let caps;
let operatorId;
/** @type {string} */
let otherId;

before(async () => {
  if (skip || !pool) return;
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  // An instance default, so "the override wins" is a claim with something to
  // win against once the loader has run.
  process.env.MAX_CONCURRENT_SESSIONS = '4';
  process.env.MAX_CONCURRENT_PER_USER = '2';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  caps = await import('../src/concurrency.js');

  const { rows } = await pool.query('select id from users limit 1');
  operatorId = rows[0].id;
  const { rows: other } = await pool.query(
    `insert into users (email) values ('other@example.test') returning id`
  );
  otherId = other[0].id;
});

after(async () => {
  if (!pool) return;
  await pool.end(); // a database with a live connection cannot be dropped
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

test('012 adds a nullable column and leaves every existing row without an override', { skip }, async () => {
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  const { rows } = await pool.query(
    `select data_type, is_nullable, column_default
       from information_schema.columns
      where table_name = 'users' and column_name = 'max_concurrent_runs'`
  );
  assert.equal(rows.length, 1, 'the migration ran');
  assert.equal(rows[0].data_type, 'integer');
  assert.equal(rows[0].is_nullable, 'YES', 'null is the no-override state');
  assert.equal(rows[0].column_default, null, 'no default: the column adds nothing to a self-host');

  const { rows: existing } = await pool.query(
    'select count(*)::int as n from users where max_concurrent_runs is not null'
  );
  assert.equal(existing[0].n, 0, 'the seeded operator is not silently given an override');
});

test('zero and negative caps are refused by the database (D14)', { skip }, async () => {
  // "May not run" is a suspension wearing a capacity feature's clothes, and the
  // 429 the engine would produce says "wait for one to finish" — which for a
  // cap of 0 is never true. Refuse it where it cannot be got around.
  for (const bad of [0, -1]) {
    await assert.rejects(
      () => pool.query('update users set max_concurrent_runs = $1 where id = $2', [bad, otherId]),
      /check constraint/i,
      `${bad} must be refused`
    );
  }

  // 1 is the floor, and it is a legitimate throttle.
  await pool.query('update users set max_concurrent_runs = 1 where id = $1', [otherId]);
  const { rows } = await pool.query('select max_concurrent_runs from users where id = $1', [otherId]);
  assert.equal(rows[0].max_concurrent_runs, 1);

  // And null is always allowed: clearing an override is not a write of 0.
  await pool.query('update users set max_concurrent_runs = null where id = $1', [otherId]);
  const { rows: cleared } = await pool.query(
    'select max_concurrent_runs from users where id = $1',
    [otherId]
  );
  assert.equal(cleared[0].max_concurrent_runs, null);
});

test('writeUserConcurrencyCap persists AND writes through to the live resolution', { skip }, async () => {
  assert.equal(caps.getUserConcurrencyCap(otherId), 2, 'the instance default, before any override');

  await caps.writeUserConcurrencyCap(otherId, 5);

  const { rows } = await pool.query('select max_concurrent_runs from users where id = $1', [otherId]);
  assert.equal(rows[0].max_concurrent_runs, 5, 'persisted');
  assert.equal(
    caps.getUserConcurrencyCap(otherId),
    5,
    'and visible immediately in-process — no reload, no restart'
  );

  // D13: 5 is above MAX_CONCURRENT_SESSIONS (4). Accepted, and a no-op at the
  // gate, because the global cap wins in canStart either way. One truth, one
  // place; the script is what warns.
  assert.ok(5 > Number(process.env.MAX_CONCURRENT_SESSIONS), 'the fixture is above the global cap');

  await caps.writeUserConcurrencyCap(otherId, null);
  assert.equal(caps.getUserConcurrencyCap(otherId), 2, 'cleared, back to the instance default');
});

test('loadUserConcurrencyCaps loads every override at boot and only overrides', { skip }, async () => {
  await pool.query('update users set max_concurrent_runs = 3 where id = $1', [otherId]);
  await pool.query('update users set max_concurrent_runs = null where id = $1', [operatorId]);

  // Wipe the cache the way a fresh process starts, so this proves the LOAD and
  // not the write-through the previous test already proved.
  caps.setUserConcurrencyCap(otherId, null);
  caps.setUserConcurrencyCap(operatorId, null);

  const loaded = await caps.loadUserConcurrencyCaps();
  assert.equal(loaded, 1, 'one overridden user — the loader does not carry the whole users table');
  assert.equal(caps.getUserConcurrencyCap(otherId), 3);
  assert.equal(caps.getUserConcurrencyCap(operatorId), 2, 'a null row is not cached as a cap');
});

test('refreshUserConcurrencyCap picks up a write made by another process (D12)', { skip }, async () => {
  await caps.writeUserConcurrencyCap(otherId, 3);
  assert.equal(caps.getUserConcurrencyCap(otherId), 3);

  // What `npm run concurrency` does from inside its own process: the row moves,
  // the server's cache does not. This is the exact staleness the refresh exists
  // to close, so it is written as a raw UPDATE rather than through the helper.
  await pool.query('update users set max_concurrent_runs = 1 where id = $1', [otherId]);
  assert.equal(caps.getUserConcurrencyCap(otherId), 3, 'still stale — nothing told this process');

  const fresh = await caps.refreshUserConcurrencyCap(otherId);
  assert.equal(fresh, 1);
  assert.equal(caps.getUserConcurrencyCap(otherId), 1, 'the operator gets their lever with no restart');

  // Clearing propagates the same way — a refresh that only ever raises would
  // leave a lifted throttle in force forever.
  await pool.query('update users set max_concurrent_runs = null where id = $1', [otherId]);
  assert.equal(await caps.refreshUserConcurrencyCap(otherId), null);
  assert.equal(caps.getUserConcurrencyCap(otherId), 2, 'back to the instance default');
});

test('a refresh for an unknown user resolves to the instance default, never a throw (D11)', { skip }, async () => {
  const ghost = randomUUID();
  assert.equal(await caps.refreshUserConcurrencyCap(ghost), null);
  assert.equal(caps.getUserConcurrencyCap(ghost), 2);
});
