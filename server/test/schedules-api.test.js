// @ts-check
// Schedules API (US-010): CRUD over /api/schedules against pg-mem, driving the
// real Express app. The slot math itself is covered in schedule.test.js — what
// matters here is that a write validates its target, normalizes the preset and
// leaves next_run_at agreeing with it.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
let artifactsDir;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sched-api-'));
  process.env.WORKER_API_TOKEN = TOKEN;
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
  mem.public.registerFunction({
    name: 'nullif',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (a, b) => (a === b ? null : a),
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ app } = await import('../src/server.js'));
});

beforeEach(async () => {
  await pool.query('delete from schedules');
});

async function makeTest(name = 'login smoke') {
  const res = await request(app)
    .post('/api/tests')
    .set(auth)
    .send({ name, goal: 'log in', start_url: 'https://example.com' })
    .expect(201);
  return res.body.id;
}

const post = (body) => request(app).post('/api/schedules').set(auth).send(body);

test('creating a daily schedule dates it in the future', async () => {
  const testId = await makeTest();
  const created = (
    await post({ test_id: testId, kind: 'daily', hour: 2, minute: 30, tz: 'Europe/Berlin' }).expect(
      201
    )
  ).body;

  assert.equal(created.test_id, testId);
  assert.equal(created.kind, 'daily');
  assert.equal(created.enabled, true);
  assert.ok(new Date(created.next_run_at).getTime() > Date.now(), 'next_run_at is ahead of now');
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(created.next_run_at));
  assert.equal(local, '02:30');
});

test('an hourly schedule keeps its interval and zeroes the hour it cannot use', async () => {
  const testId = await makeTest();
  const created = (
    await post({ test_id: testId, kind: 'hourly', interval_hours: 6, hour: 14 }).expect(201)
  ).body;
  assert.equal(created.interval_hours, 6);
  assert.equal(created.hour, 0, 'an hourly schedule has no single hour to fire at');
});

test('every target type is accepted', async () => {
  const testId = await makeTest();
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Shop' }).expect(201)
  ).body;
  const mod = (
    await request(app)
      .post(`/api/projects/${project.id}/modules`)
      .set(auth)
      .send({ name: 'auth' })
      .expect(201)
  ).body;
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'regression', project_id: project.id })
      .expect(201)
  ).body;

  for (const target of [
    { test_id: testId },
    { module_id: mod.id },
    { suite_id: suite.id },
    { project_id: project.id },
  ]) {
    const created = (await post({ ...target, kind: 'daily', hour: 3 }).expect(201)).body;
    const [column] = Object.keys(target);
    assert.equal(created[column], target[column]);
  }

  const list = (await request(app).get('/api/schedules').set(auth).expect(200)).body;
  assert.equal(list.schedules.length, 4);

  // The list resolves its targets, so a view showing every schedule at once
  // can name each one without fetching all four collections itself.
  const named = new Map(list.schedules.map((s) => [s.target_type, s.target_name]));
  assert.deepEqual(
    Object.fromEntries(named),
    { test: 'login smoke', module: 'auth', suite: 'regression', project: 'Shop' }
  );
});

// BUG-006: a target can be emptied without the schedule being touched, and the
// tick then consumes the slot in silence. The list is the only place a
// schedule is shown, so it has to be able to say the target holds nothing.
test('the list reports how many tests each target actually holds', async () => {
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Empties' }).expect(201)
  ).body;
  const mod = (
    await request(app)
      .post(`/api/projects/${project.id}/modules`)
      .set(auth)
      .send({ name: 'checkout' })
      .expect(201)
  ).body;
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'nightly', project_id: project.id })
      .expect(201)
  ).body;

  const counts = async () => {
    const { body } = await request(app).get('/api/schedules').set(auth).expect(200);
    return Object.fromEntries(body.schedules.map((s) => [s.target_type, s.target_tests]));
  };

  for (const target of [{ module_id: mod.id }, { suite_id: suite.id }, { project_id: project.id }]) {
    await post({ ...target, kind: 'daily', hour: 3 }).expect(201);
  }
  assert.deepEqual(
    await counts(),
    { module: 0, suite: 0, project: 0 },
    'three schedules, all firing into nothing'
  );

  // Filling the module fills the project too — one test, counted by every
  // target that contains it, exactly as the scheduler would resolve them.
  const testId = (
    await request(app)
      .post('/api/tests')
      .set(auth)
      .send({
        name: 'pay',
        goal: 'pay',
        start_url: 'https://example.com',
        project_id: project.id,
        module_id: mod.id,
      })
      .expect(201)
  ).body.id;
  assert.deepEqual(await counts(), { module: 1, suite: 0, project: 1 });

  await request(app)
    .put(`/api/suites/${suite.id}`)
    .set(auth)
    .send({ test_ids: [testId] })
    .expect(200);
  assert.deepEqual(await counts(), { module: 1, suite: 1, project: 1 });

  // And emptying it again is what the scheduler will meet at 02:00.
  await request(app).delete(`/api/tests/${testId}`).set(auth).expect(204);
  assert.deepEqual(await counts(), { module: 0, suite: 0, project: 0 }, 'the target drained');
});

test('a write must name exactly one target that exists', async () => {
  const testId = await makeTest();
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Shop' }).expect(201)
  ).body;

  await post({ kind: 'daily' }).expect(400);
  await post({ test_id: testId, project_id: project.id, kind: 'daily' }).expect(400);
  await post({ test_id: randomUUID(), kind: 'daily' }).expect(400);
  await post({ test_id: 'not-a-uuid', kind: 'daily' }).expect(400);
});

test('the preset is validated at the boundary', async () => {
  const testId = await makeTest();
  for (const body of [
    { kind: 'yearly' },
    { kind: 'hourly', interval_hours: 5 },
    { kind: 'weekly' },
    { kind: 'weekly', weekday: 9 },
    { kind: 'daily', hour: 25 },
    { kind: 'daily', minute: 60 },
    { kind: 'daily', tz: 'Mars/Olympus' },
  ]) {
    const res = await post({ test_id: testId, ...body }).expect(400);
    assert.ok(res.body.error, `${JSON.stringify(body)} should explain itself`);
  }
});

test('filters narrow the list to one target', async () => {
  const a = await makeTest('a');
  const b = await makeTest('b');
  await post({ test_id: a, kind: 'daily', hour: 1 }).expect(201);
  await post({ test_id: b, kind: 'daily', hour: 2 }).expect(201);

  const mine = (await request(app).get(`/api/schedules?test_id=${a}`).set(auth).expect(200)).body;
  assert.equal(mine.schedules.length, 1);
  assert.equal(mine.schedules[0].test_id, a);

  await request(app).get('/api/schedules?test_id=nope').set(auth).expect(400);
});

test('updating the preset re-dates the schedule', async () => {
  const testId = await makeTest();
  const created = (
    await post({ test_id: testId, kind: 'daily', hour: 2, tz: 'Europe/Berlin' }).expect(201)
  ).body;

  const updated = (
    await request(app)
      .put(`/api/schedules/${created.id}`)
      .set(auth)
      .send({ kind: 'hourly', interval_hours: 3 })
      .expect(200)
  ).body;

  assert.equal(updated.kind, 'hourly');
  assert.equal(updated.interval_hours, 3);
  assert.notEqual(updated.next_run_at, created.next_run_at, 'the claim marker followed the preset');
  // Within one interval — an hourly schedule can never be a day away.
  assert.ok(new Date(updated.next_run_at).getTime() - Date.now() <= 3 * 60 * 60 * 1000);
});

test('switching kind drops the fields the new kind cannot use', async () => {
  const testId = await makeTest();
  const created = (
    await post({ test_id: testId, kind: 'weekly', weekday: 2, hour: 9 }).expect(201)
  ).body;
  assert.equal(created.weekday, 2);

  const updated = (
    await request(app).put(`/api/schedules/${created.id}`).set(auth).send({ kind: 'daily' }).expect(200)
  ).body;
  assert.equal(updated.weekday, null);
  assert.equal(updated.hour, 9, 'the hour it can still use survives');
});

test('a schedule can be paused without losing its preset', async () => {
  const testId = await makeTest();
  const created = (await post({ test_id: testId, kind: 'daily', hour: 4 }).expect(201)).body;

  const paused = (
    await request(app).put(`/api/schedules/${created.id}`).set(auth).send({ enabled: false }).expect(200)
  ).body;
  assert.equal(paused.enabled, false);
  assert.equal(paused.kind, 'daily');
  assert.equal(paused.hour, 4);
});

test('deleting is idempotent-ish: gone means 404', async () => {
  const testId = await makeTest();
  const created = (await post({ test_id: testId, kind: 'daily', hour: 4 }).expect(201)).body;
  await request(app).delete(`/api/schedules/${created.id}`).set(auth).expect(204);
  await request(app).delete(`/api/schedules/${created.id}`).set(auth).expect(404);
  await request(app).put(`/api/schedules/${created.id}`).set(auth).send({ hour: 5 }).expect(404);
  await request(app).delete('/api/schedules/not-a-uuid').set(auth).expect(404);
});

test('deleting the target takes its schedules with it', async () => {
  const testId = await makeTest();
  await post({ test_id: testId, kind: 'daily', hour: 4 }).expect(201);
  await request(app).delete(`/api/tests/${testId}`).set(auth).expect(204);

  const list = (await request(app).get('/api/schedules').set(auth).expect(200)).body;
  assert.equal(list.schedules.length, 0);
});

test('schedules require the bearer token', async () => {
  await request(app).get('/api/schedules').expect(401);
  await request(app).post('/api/schedules').send({ kind: 'daily' }).expect(401);
  await request(app).delete(`/api/schedules/${randomUUID()}`).expect(401);
});

// US-069: the tell `docs/api.md` already documents — next_run_at moving while
// last_run_at stays put — carried on the row instead of left for the reader to
// spot by comparing two timestamps.
test('the list marks a schedule that keeps claiming slots and starting nothing', async () => {
  const testId = await makeTest();
  const created = (await post({ test_id: testId, kind: 'daily', hour: 2 }).expect(201)).body;

  const listed = async () =>
    (await request(app).get('/api/schedules').set(auth).expect(200)).body.schedules.find(
      (s) => s.id === created.id
    );

  assert.equal(
    (await listed()).firing_into_nothing,
    false,
    'a schedule made today has missed nothing'
  );

  // A week of claimed slots with nothing to show for them: `next_run_at` is
  // tomorrow because the claim keeps advancing it, and `last_run_at` is null
  // because `stampRun` only writes when a member actually started (BUG-006).
  await pool.query(
    `update schedules set created_at = now() - interval '7 days', last_run_at = null
      where id = $1`,
    [created.id]
  );
  assert.equal((await listed()).firing_into_nothing, true);

  // And a slot that did start something clears it.
  await pool.query('update schedules set last_run_at = now() where id = $1', [created.id]);
  assert.equal((await listed()).firing_into_nothing, false);
});

// US-069: the strip's data. One bar per firing, not per run — a suite fires
// one run per member and they are one night, not ten.
test('the list carries recent slots, collapsed one bar per firing', async () => {
  const testId = await makeTest('nightly checkout');
  const created = (await post({ test_id: testId, kind: 'daily', hour: 2 }).expect(201)).body;

  const slot = (iso) => new Date(iso);
  const addRun = (status, scheduledFor) =>
    pool.query(
      `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status, trigger,
                         schedule_id, scheduled_for)
       values ($1, $2, (select user_id from schedules where id = $3), 'g',
               'https://example.com', 5, $4, 'schedule', $3, $5)`,
      [randomUUID(), testId, created.id, status, scheduledFor]
    );

  const nextRun = new Date(created.next_run_at);
  const night = (daysBack) => slot(nextRun.getTime() - daysBack * 86400_000);

  // Two nights, the older one a clean sweep, the newer one a suite where a
  // single member failed among four.
  await addRun('passed', night(2));
  for (const status of ['passed', 'passed', 'failed', 'passed']) await addRun(status, night(1));
  // A run this schedule did not start, on the same test and the same night.
  await pool.query(
    `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status, trigger)
     values ($1, $2, (select user_id from schedules where id = $3), 'g',
             'https://example.com', 5, 'error', 'ui')`,
    [randomUUID(), testId, created.id]
  );

  const { body } = await request(app).get('/api/schedules').set(auth).expect(200);
  const recent = body.schedules.find((s) => s.id === created.id).recent;

  assert.equal(recent.length, 2, 'five scheduled runs over two nights are two bars');
  assert.equal(recent[0].status, 'failed', 'newest first, and one failure colours the night');
  assert.deepEqual([recent[0].runs, recent[0].failed], [4, 1], 'the tally its tooltip names');
  assert.equal(recent[1].status, 'passed');
  assert.deepEqual([recent[1].runs, recent[1].failed], [1, 0]);
  // The hand-started error is louder than anything on the strip and must not
  // reach it: this schedule did not do that.
  assert.ok(!recent.some((s) => s.status === 'error'));
});

test('a schedule with nothing attributed to it carries an empty strip', async () => {
  const testId = await makeTest('never run');
  const created = (await post({ test_id: testId, kind: 'daily', hour: 4 }).expect(201)).body;
  // Runs made before 019 landed: right test, right trigger, no attribution.
  await pool.query(
    `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status, trigger)
     values ($1, $2, (select user_id from schedules where id = $3), 'g',
             'https://example.com', 5, 'passed', 'schedule')`,
    [randomUUID(), testId, created.id]
  );

  const { body } = await request(app).get('/api/schedules').set(auth).expect(200);
  // Empty, so the view draws no strip at all rather than an empty frame — a
  // bar guessed from trigger+test_id would be attributed to whichever schedule
  // happened to point there today.
  assert.deepEqual(body.schedules.find((s) => s.id === created.id).recent, []);
});

test('an empty list costs no second query', async () => {
  const queries = [];
  const { attachDb } = await import('../src/db.js');
  const spy = {
    query: (text, params) => {
      queries.push(String(text));
      return pool.query(text, params);
    },
  };
  attachDb(/** @type {any} */ (spy));
  try {
    const { body } = await request(app).get('/api/schedules').set(auth).expect(200);
    assert.deepEqual(body.schedules, []);
    assert.equal(queries.length, 1, 'the list query, and nothing to ask about');
  } finally {
    attachDb(pool);
  }
});
