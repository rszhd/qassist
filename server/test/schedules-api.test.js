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
