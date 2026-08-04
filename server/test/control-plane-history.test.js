// @ts-check
// Control-plane: run history + artifact retention (US-011). Shared harness:
// test/helpers/control-plane.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness } from './helpers/control-plane.js';

let app, pool, auth, operatorId, sweepArtifacts, artifactsDir, pollUntil, makeTest, makeProject, makeArtifacts;
before(async () => {
  ({ app, pool, auth, operatorId, sweepArtifacts, artifactsDir, pollUntil, makeTest, makeProject, makeArtifacts } =
    await createHarness());
});

test('run history lists newest first and filters by test, status and project', async () => {
  const p = await makeProject('History');
  const mod = (
    await request(app).post(`/api/projects/${p.id}/modules`).set(auth).send({ name: 'Hist' })
  ).body;
  const t = (await makeTest({ name: 'historic', module_id: mod.id }).expect(201)).body;
  const other = (await makeTest({ name: 'unrelated' }).expect(201)).body;

  const mine = [];
  for (let i = 0; i < 3; i++) {
    const started = (
      await request(app).post(`/api/tests/${t.id}/run`).set(auth).send({}).expect(200)
    ).body;
    mine.push(started.runId);
    await pollUntil(async () => {
      const q = await pool.query('select status from runs where id = $1', [started.runId]);
      return q.rows[0]?.status === 'passed';
    });
  }
  await request(app).post(`/api/tests/${other.id}/run`).set(auth).send({}).expect(200);

  const byTest = (await request(app).get(`/api/runs?test_id=${t.id}`).set(auth).expect(200)).body;
  assert.equal(byTest.total, 3);
  assert.deepEqual(
    byTest.runs.map((r) => r.id).sort(),
    [...mine].sort()
  );
  // Newest first, and the join carries the test's name and grouping through —
  // that is what makes the row renderable without a second request.
  const stamps = byTest.runs.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a));
  assert.equal(byTest.runs[0].test_name, 'historic');
  assert.equal(byTest.runs[0].project_id, p.id);
  assert.equal(byTest.runs[0].module_id, mod.id);

  const byProject = (
    await request(app).get(`/api/runs?project_id=${p.id}`).set(auth).expect(200)
  ).body;
  assert.equal(byProject.total, 3);

  const passed = (
    await request(app).get(`/api/runs?test_id=${t.id}&status=passed,error`).set(auth).expect(200)
  ).body;
  assert.equal(passed.total, 3);
  const queued = (
    await request(app).get(`/api/runs?test_id=${t.id}&status=queued`).set(auth).expect(200)
  ).body;
  assert.equal(queued.total, 0);
  assert.deepEqual(queued.runs, []);
});

test('run history paginates and reports the unpaginated total', async () => {
  const t = (await makeTest({ name: 'paged' }).expect(201)).body;
  for (let i = 0; i < 3; i++) {
    const started = (
      await request(app).post(`/api/tests/${t.id}/run`).set(auth).send({}).expect(200)
    ).body;
    await pollUntil(async () => {
      const q = await pool.query('select status from runs where id = $1', [started.runId]);
      return q.rows[0]?.status === 'passed';
    });
  }
  const first = (
    await request(app).get(`/api/runs?test_id=${t.id}&limit=2`).set(auth).expect(200)
  ).body;
  assert.equal(first.runs.length, 2);
  assert.equal(first.total, 3);
  assert.equal(first.limit, 2);

  const second = (
    await request(app).get(`/api/runs?test_id=${t.id}&limit=2&offset=2`).set(auth).expect(200)
  ).body;
  assert.equal(second.runs.length, 1);
  assert.equal(second.total, 3);
  assert.ok(!first.runs.some((r) => r.id === second.runs[0].id));
});

test('run history filters by date range', async () => {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status, created_at)
     values ($1, $2, 'dated', 'https://example.com', 60, 'passed', '2020-01-15T00:00:00Z')`,
    [id, operatorId]
  );
  const inRange = (
    await request(app)
      .get('/api/runs?since=2020-01-01T00:00:00Z&until=2020-02-01T00:00:00Z')
      .set(auth)
      .expect(200)
  ).body;
  assert.deepEqual(
    inRange.runs.map((r) => r.id),
    [id]
  );
  const outOfRange = (
    await request(app).get('/api/runs?since=2020-02-01T00:00:00Z&until=2020-03-01T00:00:00Z')
      .set(auth)
      .expect(200)
  ).body;
  assert.equal(outOfRange.total, 0);
});

test('run history filters by trigger, including the scheduler its callers cannot claim', async () => {
  const ids = {};
  for (const trigger of ['ui', 'api', 'ci', 'schedule']) {
    ids[trigger] = randomUUID();
    await pool.query(
      `insert into runs (id, user_id, goal, start_url, max_steps, status, trigger)
       values ($1, $3, 'triggered', 'https://example.com', 60, 'passed', $2)`,
      [ids[trigger], trigger, operatorId]
    );
  }

  const scheduled = (
    await request(app).get('/api/runs?trigger=schedule&limit=200').set(auth).expect(200)
  ).body;
  assert.ok(scheduled.runs.some((r) => r.id === ids.schedule));
  assert.ok(scheduled.runs.every((r) => r.trigger === 'schedule'));

  // Comma-separated, so "started by hand" is one request rather than two.
  const manual = (
    await request(app).get('/api/runs?trigger=ui,api&limit=200').set(auth).expect(200)
  ).body;
  const manualIds = manual.runs.map((r) => r.id);
  assert.ok(manualIds.includes(ids.ui) && manualIds.includes(ids.api));
  assert.ok(!manualIds.includes(ids.schedule) && !manualIds.includes(ids.ci));
});

// The other end of US-069's strip: a bar is clickable, and what it opens is
// History filtered to the schedule that drew it. Two schedules on one test are
// the case `?test_id=` cannot answer.
test('run history filters by the schedule that started the run', async () => {
  const p = await makeProject('Scheduled History');
  const scheduleId = async () =>
    (
      await pool.query(
        `insert into schedules (user_id, project_id, kind, hour, minute, tz, enabled, next_run_at)
         values ($1, $2, 'daily', 2, 0, 'UTC', true, now() + interval '1 day') returning id`,
        [operatorId, p.id]
      )
    ).rows[0].id;
  const nightly = await scheduleId();
  const hourly = await scheduleId();

  const runs = {};
  for (const [key, schedule] of [
    ['nightly', nightly],
    ['hourly', hourly],
    ['manual', null],
  ]) {
    runs[key] = randomUUID();
    await pool.query(
      `insert into runs (id, user_id, goal, start_url, max_steps, status, trigger, schedule_id, scheduled_for)
       values ($1, $2, 'nightly checkout', 'https://example.com', 60, 'passed', $3, $4,
               case when $4::uuid is null then null else now() end)`,
      [runs[key], operatorId, schedule ? 'schedule' : 'ui', schedule]
    );
  }

  const listed = (
    await request(app).get(`/api/runs?schedule_id=${nightly}&limit=200`).set(auth).expect(200)
  ).body.runs.map((r) => r.id);
  assert.ok(listed.includes(runs.nightly));
  assert.ok(!listed.includes(runs.hourly), 'the other schedule on the same target stays out');
  assert.ok(!listed.includes(runs.manual));
});

test('run history hides artifact links once retention prunes the directory', async () => {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status, report_status,
                       has_recording, artifacts_deleted_at)
     values ($1, $2, 'pruned', 'https://example.com', 60, 'passed', 'ready', true, now())`,
    [id, operatorId]
  );
  const list = (await request(app).get('/api/runs?limit=200').set(auth).expect(200)).body;
  const row = list.runs.find((r) => r.id === id);
  assert.equal(row.has_recording, false);
  assert.equal(row.report_status, 'none');
  assert.ok(row.artifacts_deleted_at); // the row itself survives
});

test('retention prunes old artifact dirs, stamps the row and keeps history', async () => {
  const old = randomUUID();
  const fresh = randomUUID();
  for (const [id, status] of [[old, 'passed'], [fresh, 'passed']]) {
    await pool.query(
      `insert into runs (id, user_id, goal, start_url, max_steps, status, success, final_result,
                         steps_count, report_status, has_recording)
       values ($1, $3, 'kept forever', 'https://example.com', 60, $2, true, 'ok', 7, 'ready', true)`,
      [id, status, operatorId]
    );
  }
  const oldDir = makeArtifacts(old, 30);
  const freshDir = makeArtifacts(fresh, 1);

  const { pruned } = await sweepArtifacts();
  assert.ok(pruned >= 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(freshDir), true); // inside the 7-day window

  // The row survives with its verdict; only the artifact columns change.
  const row = (await pool.query('select * from runs where id = $1', [old])).rows[0];
  assert.ok(row.artifacts_deleted_at);
  assert.equal(row.success, true);
  assert.equal(row.steps_count, 7);
  assert.equal((await pool.query('select * from runs where id = $1', [fresh])).rows[0]
    .artifacts_deleted_at, null);

  // …and the API stops offering links the files can no longer satisfy.
  const detail = (await request(app).get(`/api/runs/${old}`).set(auth).expect(200)).body;
  assert.equal(detail.hasRecording, false);
  assert.equal(detail.status, 'passed');
  await request(app).get(`/api/runs/${old}/recording`).set(auth).expect(404);
});

test('retention never touches directories that are not run artifacts', async () => {
  const stray = path.join(artifactsDir, 'not-a-run-id');
  fs.mkdirSync(stray, { recursive: true });
  const at = new Date(Date.now() - 365 * 86400_000);
  fs.utimesSync(stray, at, at);

  await sweepArtifacts();
  assert.equal(fs.existsSync(stray), true);
});

test('retention collects orphan dirs with no run row', async () => {
  const orphan = makeArtifacts(randomUUID(), 30);
  await sweepArtifacts();
  assert.equal(fs.existsSync(orphan), false);
});

test('run history rejects bad filters and paging', async () => {
  for (const q of [
    'test_id=nope',
    'schedule_id=nope',
    'project_id=nope',
    'status=bogus',
    'trigger=bogus',
    'since=not-a-date',
    'limit=0',
    'limit=1000',
    'offset=-1',
  ]) {
    await request(app).get(`/api/runs?${q}`).set(auth).expect(400);
  }
  await request(app).get('/api/runs').expect(401);
});

test('projects endpoints require the bearer token', async () => {
  await request(app).get('/api/projects').expect(401);
  await request(app).post('/api/projects').send({ name: 'x' }).expect(401);
  await request(app).post(`/api/modules/${randomUUID()}/run`).expect(401);
});
