// @ts-check
// Scheduler tests (US-010): tick() driven directly against pg-mem with an
// injected clock, so a "daily at 02:00" case takes no wall-clock time. The
// agent and report scripts are the same Node stubs the API tests use, so a
// fired schedule really does go through the run engine.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {any} */
let pool;
/** @type {(now?: number) => Promise<{ fired: number, runs: number, skipped: number }>} */
let tick;
/** @type {() => { active: number, queued: number }} */
let counts;
let userId;
let artifactsDir;

const BERLIN = 'Europe/Berlin';
/** An instant from a Berlin wall-clock reading (July, so +02:00). */
const at = (iso) => new Date(`${iso}+02:00`).getTime();

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sched-test-'));
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.MAX_CONCURRENT_SESSIONS = '2'; // read at import time; two slots make the queue observable

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
  ({ tick } = await import('../src/scheduler.js'));
  ({ counts } = await import('../src/runs.js'));

  const { rows } = await pool.query('select id from users limit 1');
  userId = rows[0].id;
});

beforeEach(async () => {
  await pool.query('delete from schedules');
  await pool.query('delete from runs');
  await pool.query('delete from suite_tests');
  await pool.query('delete from tests');
  await pool.query('delete from suites');
  await pool.query('delete from modules');
  await pool.query('delete from projects');
});

async function makeTest(name, extra = {}) {
  const { rows } = await pool.query(
    `insert into tests (user_id, name, goal, start_url, max_steps, project_id, module_id)
     values ($1, $2, 'check it', 'https://example.com', 5, $3, $4) returning id`,
    [userId, name, extra.project_id ?? null, extra.module_id ?? null]
  );
  return rows[0].id;
}

/** @param {{ test_id?, suite_id?, module_id?, project_id? }} target */
async function makeSchedule(target, fields = {}) {
  const { rows } = await pool.query(
    `insert into schedules (user_id, test_id, suite_id, module_id, project_id,
                            kind, interval_hours, hour, minute, weekday, tz,
                            enabled, next_run_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      userId,
      target.test_id ?? null,
      target.suite_id ?? null,
      target.module_id ?? null,
      target.project_id ?? null,
      fields.kind ?? 'daily',
      fields.interval_hours ?? null,
      fields.hour ?? 2,
      fields.minute ?? 0,
      fields.weekday ?? null,
      fields.tz ?? BERLIN,
      fields.enabled ?? true,
      fields.next_run_at === undefined ? new Date(at('2026-07-23T02:00')) : fields.next_run_at,
    ]
  );
  return rows[0].id;
}

const runRows = async () =>
  (await pool.query('select id, test_id, trigger, status from runs order by created_at')).rows;

const scheduleRow = async (id) =>
  (await pool.query('select * from schedules where id = $1', [id])).rows[0];

test('a due schedule fires its test and advances to the next slot', async () => {
  const testId = await makeTest('nightly');
  const scheduleId = await makeSchedule({ test_id: testId });

  const result = await tick(at('2026-07-23T02:00:30'));
  assert.deepEqual(result, { fired: 1, runs: 1, skipped: 0, blocked: 0 });

  const runs = await runRows();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].test_id, testId);
  assert.equal(runs[0].trigger, 'schedule');

  const row = await scheduleRow(scheduleId);
  assert.equal(new Date(row.next_run_at).getTime(), at('2026-07-24T02:00'));
  assert.ok(row.last_run_at, 'last_run_at is stamped');
});

test('a schedule whose slot has not arrived is left alone', async () => {
  const testId = await makeTest('nightly');
  await makeSchedule({ test_id: testId });

  const result = await tick(at('2026-07-23T01:59'));
  assert.deepEqual(result, { fired: 0, runs: 0, skipped: 0, blocked: 0 });
  assert.equal((await runRows()).length, 0);
});

test('the claim means a second tick in the same minute does not re-fire', async () => {
  const testId = await makeTest('nightly');
  await makeSchedule({ test_id: testId });

  await tick(at('2026-07-23T02:00:30'));
  const again = await tick(at('2026-07-23T02:00:31'));
  assert.deepEqual(again, { fired: 0, runs: 0, skipped: 0, blocked: 0 });
  assert.equal((await runRows()).length, 1);
});

test('a disabled schedule never fires', async () => {
  const testId = await makeTest('nightly');
  await makeSchedule({ test_id: testId }, { enabled: false });

  const result = await tick(at('2026-07-23T09:00'));
  assert.deepEqual(result, { fired: 0, runs: 0, skipped: 0, blocked: 0 });
});

test('an undated schedule is dated rather than fired', async () => {
  const testId = await makeTest('nightly');
  const scheduleId = await makeSchedule({ test_id: testId }, { next_run_at: null });

  const result = await tick(at('2026-07-23T09:00'));
  assert.deepEqual(result, { fired: 0, runs: 0, skipped: 0, blocked: 0 });
  assert.equal((await runRows()).length, 0);

  const row = await scheduleRow(scheduleId);
  assert.equal(new Date(row.next_run_at).getTime(), at('2026-07-24T02:00'));
});

test('a scheduled suite fires one run per member, in suite order', async () => {
  const a = await makeTest('login');
  const b = await makeTest('checkout');
  const { rows } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'P', 'p') returning id`,
    [userId]
  );
  const { rows: s } = await pool.query(
    `insert into suites (user_id, name, project_id) values ($1, 'regression', $2) returning id`,
    [userId, rows[0].id]
  );
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 0)', [
    s[0].id,
    b,
  ]);
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 1)', [
    s[0].id,
    a,
  ]);
  await makeSchedule({ suite_id: s[0].id });

  const result = await tick(at('2026-07-23T02:00:30'));
  assert.deepEqual(result, { fired: 1, runs: 2, skipped: 0, blocked: 0 });
  assert.deepEqual(
    (await runRows()).map((r) => r.test_id),
    [b, a]
  );
});

test('a scheduled module fires its tests', async () => {
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'P', 'p') returning id`,
    [userId]
  );
  const { rows: m } = await pool.query(
    `insert into modules (project_id, name, slug) values ($1, 'auth', 'auth') returning id`,
    [p[0].id]
  );
  await makeTest('login', { project_id: p[0].id, module_id: m[0].id });
  await makeTest('logout', { project_id: p[0].id, module_id: m[0].id });
  await makeTest('unrelated');
  await makeSchedule({ module_id: m[0].id });

  const result = await tick(at('2026-07-23T02:00:30'));
  assert.deepEqual(result, { fired: 1, runs: 2, skipped: 0, blocked: 0 });
});

test('a test already in flight is skipped while its siblings still run', async () => {
  const busyTest = await makeTest('slow');
  const freeTest = await makeTest('quick');
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'P', 'p') returning id`,
    [userId]
  );
  await pool.query('update tests set project_id = $1', [p[0].id]);
  await makeSchedule({ project_id: p[0].id });

  // A run from the previous slot that never finished.
  await pool.query(
    `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, status)
     values ($1, $2, $3, 'schedule', 'g', 'https://example.com', 5, 'running')`,
    [randomUUID(), busyTest, userId]
  );

  const result = await tick(at('2026-07-23T02:00:30'));
  assert.deepEqual(result, { fired: 1, runs: 1, skipped: 1, blocked: 0 });

  // Status can't tell the new run from the stuck one — both read 'running' —
  // so count rows per test instead.
  const rows = await runRows();
  assert.equal(rows.length, 2, 'the stuck run, plus one new one');
  assert.equal(
    rows.filter((r) => r.test_id === busyTest).length,
    1,
    'the busy test did not get a second run'
  );
  assert.equal(rows.filter((r) => r.test_id === freeTest).length, 1, 'the free sibling ran');
});

test('an empty target fires nothing but still advances', async () => {
  const { rows: p } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'Empty', 'empty') returning id`,
    [userId]
  );
  const scheduleId = await makeSchedule({ project_id: p[0].id });

  const result = await tick(at('2026-07-23T02:00:30'));
  assert.deepEqual(result, { fired: 0, runs: 0, skipped: 0, blocked: 0 });
  const row = await scheduleRow(scheduleId);
  assert.equal(new Date(row.next_run_at).getTime(), at('2026-07-24T02:00'));
});

test('an hourly schedule advances by its interval, not by a day', async () => {
  const testId = await makeTest('smoke');
  const scheduleId = await makeSchedule(
    { test_id: testId },
    { kind: 'hourly', interval_hours: 6, hour: 0, next_run_at: new Date(at('2026-07-23T12:00')) }
  );

  await tick(at('2026-07-23T12:00:10'));
  assert.equal(new Date((await scheduleRow(scheduleId)).next_run_at).getTime(), at('2026-07-23T18:00'));
});

test('a schedule left behind by downtime fires once, then moves to the future', async () => {
  const testId = await makeTest('nightly');
  // Slot was two days ago; nothing ran because the server was down.
  const scheduleId = await makeSchedule(
    { test_id: testId },
    { next_run_at: new Date(at('2026-07-21T02:00')) }
  );

  const result = await tick(at('2026-07-23T09:00'));
  assert.deepEqual(result, { fired: 1, runs: 1, skipped: 0, blocked: 0 }, 'fires once, not once per missed day');

  const row = await scheduleRow(scheduleId);
  assert.equal(new Date(row.next_run_at).getTime(), at('2026-07-24T02:00'));
  assert.deepEqual(await tick(at('2026-07-23T09:01')), { fired: 0, runs: 0, skipped: 0, blocked: 0 });
});

test('a burst of scheduled tests queues instead of exceeding the concurrency cap', async () => {
  // Earlier tests' stub runs finish in milliseconds, but a slot they still
  // hold would show up here as a queued run this test did not cause.
  const deadline = Date.now() + 5000;
  while (counts().active > 0) {
    assert.ok(Date.now() < deadline, 'earlier runs never drained');
    await new Promise((r) => setTimeout(r, 25));
  }

  process.env.QA_STUB_HOLD_MS = '500'; // hold the slots long enough to read the queue behind them
  try {
    const { rows: p } = await pool.query(
      `insert into projects (user_id, name, slug) values ($1, 'Burst', 'burst') returning id`,
      [userId]
    );
    for (const name of ['a', 'b', 'c', 'd', 'e']) await makeTest(name, { project_id: p[0].id });
    await makeSchedule({ project_id: p[0].id });

    assert.deepEqual(await tick(at('2026-07-23T02:00:30')), { fired: 1, runs: 5, skipped: 0, blocked: 0 });
    assert.deepEqual(counts(), { active: 2, queued: 3 }, 'five at once, two slots');
    assert.equal((await runRows()).length, 5, 'the queued three are persisted too');
  } finally {
    delete process.env.QA_STUB_HOLD_MS;
  }
});
