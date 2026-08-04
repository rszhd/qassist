// @ts-check
// The scheduling surfaces that only a real Postgres can hold up: the claim
// (US-010) and, below it, the empty-target count the schedules list returns
// (BUG-006).
//
// Every other test here runs on pg-mem, which stores timestamps at
// millisecond precision — the precision a JS Date already has. A claim that
// compares `next_run_at` for equality therefore round-trips perfectly there
// and passes whether or not it depends on that precision. Postgres keeps
// microseconds, so a `next_run_at` the database wrote comes back truncated and
// matches nothing: the schedule silently stops firing, forever. That gap is
// only visible against a real server, so this file asks for one and skips when
// there isn't one — the compose `db` service is enough.
//
// Isolation is a throwaway database, created and dropped here rather than a
// schema inside the configured one: the migration runner finds its bookkeeping
// table through the search path, so a schema-scoped run would decide the
// schema was already migrated and write every row into the database it was
// borrowing. A separate database cannot reach the caller's data at all, and
// migrating it exercises `db/migrations/*.sql` against real Postgres.
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
const DB_NAME = `qassist_sched_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** @type {pg.Pool | null} */
let pool = null;
/**
 * False when Postgres answered; otherwise the reason these tests are skipped.
 * @type {boolean | string}
 */
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
  console.log(`scheduler-postgres: skipped — ${skip}`);
}

/** @type {(now?: number) => Promise<{ fired: number, runs: number, skipped: number, unstarted: number, empty: number, blocked: number, pending: number, keyless: number }>} */
let tick;
/** @type {import('express').Express} */
let app;
let userId;
const auth = { Authorization: 'Bearer test-token' };

before(async () => {
  if (skip || !pool) return;
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  ({ tick } = await import('../src/scheduler.js'));
  // Safe to import: startScheduler() is inside the serve-only block, so nothing
  // ticks on a timer behind the claim test below.
  ({ app } = await import('../src/server.js'));

  const { rows } = await pool.query('select id from users limit 1');
  userId = rows[0].id;
  // BYOK-only (US-039): the claim under test is only reached when the owner has
  // a stored key — a keyless owner is skipped right after it.
  const { setUserOpenaiKey } = await import('../src/openaiKey.js');
  await setUserOpenaiKey(userId, 'sk-test-' + 'a'.repeat(40));
});

after(async () => {
  if (!pool) return;
  await pool.end(); // a database with a live connection cannot be dropped
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

test('a next_run_at written by Postgres is still claimable', { skip }, async () => {
  // Nothing below may touch the caller's database, so prove where we are
  // before writing anything.
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  // Empty on purpose, and now doubly so: the claim is what is under test, and a
  // target with tests in it would spend the slot spawning agents to prove
  // nothing extra — while an empty one is also the slot that must come back
  // having stamped no `last_run_at` (BUG-006).
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'Claim', 'claim-check') returning id`,
    [userId]
  );
  // A fixed microsecond offset rather than bare now(): a timestamp that
  // happened to land on a whole millisecond would quietly stop being the case
  // this test exists for.
  const { rows: s } = await pool.query(
    `insert into schedules (user_id, project_id, kind, hour, minute, tz, enabled, next_run_at)
     values ($1, $2, 'daily', 3, 0, 'UTC', true,
             date_trunc('milliseconds', now()) - interval '1 minute' + interval '684 microseconds')
     returning id, next_run_at`,
    [userId, p[0].id]
  );
  const { rows: text } = await pool.query(
    'select next_run_at::text as t from schedules where id = $1',
    [s[0].id]
  );
  assert.match(text[0].t, /\.\d{4,6}/, 'the fixture must carry sub-millisecond precision');

  // What the claim used to do, spelled out: the Date the driver hands back has
  // dropped the microseconds, so compare-and-swap on it matches nothing.
  const equality = await pool.query(
    'update schedules set updated_at = now() where id = $1 and next_run_at = $2',
    [s[0].id, s[0].next_run_at]
  );
  assert.equal(equality.rowCount, 0, 'a JS Date cannot match a microsecond timestamp');

  const firedAfter = Date.now();
  assert.deepEqual(
    await tick(),
    { fired: 0, runs: 0, skipped: 0, unstarted: 0, empty: 1, blocked: 0, pending: 0, keyless: 0 },
    'claimed, ran nothing'
  );

  const { rows: claimed } = await pool.query(
    'select next_run_at, last_run_at from schedules where id = $1',
    [s[0].id]
  );
  // The two halves of the split (BUG-006). The claim carries only the field the
  // re-fire guard reads, so the slot is consumed and no backlog accrues; the
  // field that describes an outcome is left for an outcome to write. Before the
  // split this row said it had just run, on a target holding nothing to run.
  assert.ok(
    claimed[0].next_run_at.getTime() > firedAfter,
    'the claim advanced the schedule to a future slot'
  );
  assert.equal(claimed[0].last_run_at, null, 'a slot that started nothing is not a run');
});

// The other half of BUG-006 needs a real server for a reason pg-mem structurally
// cannot show: `count(*)` is bigint, and it is **node-pg** — not the database —
// that hands a bigint back as a *string*. pg-mem never goes through those type
// parsers, so an uncast count is a number there and "0" here, and the view's
// zero check would quietly never match. The empty-target notice would then be
// missing on exactly the screen this bug is about.
test('the list reports an empty target as a number the view can test', { skip }, async () => {
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'Counted', 'counted') returning id`,
    [userId]
  );
  await pool.query(
    `insert into schedules (user_id, project_id, kind, hour, minute, tz, enabled, next_run_at)
     values ($1, $2, 'daily', 4, 0, 'UTC', true, now() + interval '1 day')`,
    [userId, p[0].id]
  );

  const counted = async () =>
    (await request(app).get(`/api/schedules?project_id=${p[0].id}`).set(auth).expect(200)).body
      .schedules[0].target_tests;

  assert.strictEqual(await counted(), 0, 'an empty target counts zero, as a number');

  await pool.query(
    `insert into tests (user_id, name, goal, start_url, max_steps, project_id)
     values ($1, 'pay', 'pay', 'https://example.com', 5, $2)`,
    [userId, p[0].id]
  );
  assert.strictEqual(await counted(), 1, 'and follows the target it points at');
});

// --- US-069: the attribution columns and the index the strip reads ----------

/** One run row, attributed or not, with a status the strip has to colour. */
async function makeRun(fields) {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, status,
                       schedule_id, scheduled_for)
     values ($1, null, $2, $3, 'g', 'https://example.com', 5, $4, $5, $6)`,
    [id, userId, fields.trigger, fields.status, fields.schedule_id ?? null, fields.scheduled_for ?? null]
  );
  return id;
}

async function makeSchedule(slug) {
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, $2, $2) returning id`,
    [userId, slug]
  );
  const { rows: s } = await pool.query(
    `insert into schedules (user_id, project_id, kind, hour, minute, tz, enabled, next_run_at)
     values ($1, $2, 'daily', 2, 0, 'UTC', true, now() + interval '1 day') returning id`,
    [userId, p[0].id]
  );
  return s[0].id;
}

// pg-mem strips every index (`runMigrations({ skipIndexes: true })`) and
// answers partial-index queries wrongly when it does not, so the route suite
// cannot see this one at all. Here it exists, and the predicate is the whole
// point: the strip's index must not carry a row per UI run on a box where UI
// runs are most of the table.
test('the strip index exists and is partial', { skip }, async () => {
  const { rows } = await pool.query(
    `select indexdef from pg_indexes where tablename = 'runs' and indexname = 'runs_schedule_idx'`
  );
  assert.equal(rows.length, 1, '019 created the index');
  assert.match(rows[0].indexdef, /where \(schedule_id is not null\)/i);
});

test('the strip reads one schedule’s slots, newest first, and nobody else’s', { skip }, async () => {
  const mine = await makeSchedule('strip-mine');
  const other = await makeSchedule('strip-other');
  const slot = (iso) => new Date(`${iso}Z`);

  await makeRun({ trigger: 'schedule', status: 'passed', schedule_id: mine, scheduled_for: slot('2026-08-01T02:00:00') });
  await makeRun({ trigger: 'schedule', status: 'failed', schedule_id: mine, scheduled_for: slot('2026-08-02T02:00:00') });
  await makeRun({ trigger: 'schedule', status: 'passed', schedule_id: mine, scheduled_for: slot('2026-08-02T02:00:00') });
  await makeRun({ trigger: 'schedule', status: 'passed', schedule_id: other, scheduled_for: slot('2026-08-02T02:00:00') });
  // The run that has no schedule at all, and the one that predates 019 — both
  // must stay out of the strip rather than land on it as an untimed bar.
  await makeRun({ trigger: 'ui', status: 'passed' });

  const { rows } = await pool.query(
    `select scheduled_for, count(*)::int as runs,
            count(*) filter (where status in ('failed', 'error'))::int as failed
       from runs
      where schedule_id = $1
      group by scheduled_for
      order by scheduled_for desc`,
    [mine]
  );
  assert.deepEqual(
    rows.map((r) => [r.scheduled_for.toISOString(), r.runs, r.failed]),
    [
      ['2026-08-02T02:00:00.000Z', 2, 1],
      ['2026-08-01T02:00:00.000Z', 1, 0],
    ],
    'two slots, the newer one holding both of its members'
  );
});

test('deleting a schedule takes the strip and leaves the history', { skip }, async () => {
  const scheduleId = await makeSchedule('strip-deleted');
  const runId = await makeRun({
    trigger: 'schedule',
    status: 'failed',
    schedule_id: scheduleId,
    scheduled_for: new Date('2026-08-03T02:00:00Z'),
  });

  await pool.query('delete from schedules where id = $1', [scheduleId]);

  const { rows } = await pool.query('select trigger, status, schedule_id from runs where id = $1', [
    runId,
  ]);
  assert.equal(rows.length, 1, 'set null, not cascade — the finding outlives the schedule');
  assert.equal(rows[0].schedule_id, null);
  assert.equal(rows[0].status, 'failed', 'and the verdict it recorded is untouched');
});
