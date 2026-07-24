// @ts-check
// Control-plane: saved-tests CRUD + run persistence (US-009). Shared harness:
// test/helpers/control-plane.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createHarness } from './helpers/control-plane.js';

let app, pool, auth, operatorId, sweepArtifacts, artifactsDir, pollUntil, makeTest, makeProject, makeArtifacts;
before(async () => {
  ({ app, pool, auth, operatorId, sweepArtifacts, artifactsDir, pollUntil, makeTest, makeProject, makeArtifacts } =
    await createHarness());
});

test('health reports db on', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.db, true);
});

test('boot seeds the operator user and hashed api key', async () => {
  const users = await pool.query('select email from users');
  assert.equal(users.rows.length, 1);
  const keys = await pool.query('select token_hash from api_keys');
  assert.equal(keys.rows.length, 1);
  assert.equal(keys.rows[0].token_hash.length, 64); // sha256 hex, not the token
});

test('tests CRUD round-trip', async () => {
  const created = (await makeTest().expect(201)).body;
  assert.equal(created.name, 'login smoke');
  assert.equal(created.max_steps, 60); // server default applied

  const list = (await request(app).get('/api/tests').set(auth).expect(200)).body;
  assert.ok(list.tests.some((t) => t.id === created.id));

  const updated = (
    await request(app)
      .put(`/api/tests/${created.id}`)
      .set(auth)
      .send({ name: 'renamed', max_steps: 30 })
      .expect(200)
  ).body;
  assert.equal(updated.name, 'renamed');
  assert.equal(updated.max_steps, 30);
  assert.equal(updated.goal, created.goal); // omitted fields untouched

  await request(app).delete(`/api/tests/${created.id}`).set(auth).expect(204);
  await request(app).get(`/api/tests/${created.id}`).set(auth).expect(404);
});

test('create test validates required fields', async () => {
  const res = await makeTest({ goal: undefined }).expect(400);
  assert.match(res.body.error, /required/);
});

test('tests endpoints require the bearer token', async () => {
  await request(app).get('/api/tests').expect(401);
  await request(app).post('/api/tests').send({}).expect(401);
});

test('one-click run: linked to the test, persisted, start_url overridable', async () => {
  const t = (await makeTest({ name: 'runnable' }).expect(201)).body;

  const started = (
    await request(app)
      .post(`/api/tests/${t.id}/run`)
      .set(auth)
      .send({ start_url: 'https://preview.example.com' })
      .expect(200)
  ).body;
  assert.equal(started.testId, t.id);

  const live = (await request(app).get(`/api/runs/${started.runId}`).set(auth).expect(200)).body;
  assert.equal(live.testId, t.id);
  assert.equal(live.start_url, 'https://preview.example.com');
  assert.equal(live.goal, t.goal);

  // The runs row is the durable copy: wait for the stub agent to finish and
  // check the verdict landed in the DB.
  const row = await pollUntil(async () => {
    const r = await pool.query('select * from runs where id = $1', [started.runId]);
    return r.rows[0]?.status === 'passed' ? r.rows[0] : null;
  });
  assert.equal(row.test_id, t.id);
  assert.equal(row.trigger, 'api');
  assert.equal(row.success, true);
  assert.equal(row.start_url, 'https://preview.example.com');
  assert.ok(row.finished_at);
});

test('variables: create validates references, run substitutes and persists them', async () => {
  // A goal referencing an undeclared variable is rejected at save (US-035).
  const bad = await makeTest({
    name: 'undeclared',
    goal: 'apply {{coupon}}',
    variables: [],
  }).expect(400);
  assert.match(bad.body.error, /undefined variable \{\{coupon\}\}/);

  const t = (
    await makeTest({
      name: 'per-env',
      goal: 'log in as {{user}} on {{env}}',
      start_url: 'https://{{env}}.example.com',
      variables: [
        { name: 'env', value: 'staging' },
        { name: 'user', value: 'alice' },
      ],
    }).expect(201)
  ).body;
  assert.equal(t.variables.length, 2);

  const started = (
    await request(app)
      .post(`/api/tests/${t.id}/run`)
      .set(auth)
      .send({ variables: { env: 'prod' } })
      .expect(200)
  ).body;

  const live = (await request(app).get(`/api/runs/${started.runId}`).set(auth).expect(200)).body;
  assert.equal(live.goal, 'log in as alice on prod');
  assert.equal(live.start_url, 'https://prod.example.com');
  assert.deepEqual(live.variables, { env: 'prod', user: 'alice' });

  const row = await pollUntil(async () => {
    const r = await pool.query('select * from runs where id = $1', [started.runId]);
    return r.rows[0]?.status === 'passed' ? r.rows[0] : null;
  });
  assert.equal(row.goal, 'log in as alice on prod');
  assert.deepEqual(row.variables, { env: 'prod', user: 'alice' });
});

test('variables: a required referenced variable with no value rejects the run', async () => {
  const t = (
    await makeTest({
      name: 'needs-coupon',
      goal: 'apply {{coupon}}',
      variables: [{ name: 'coupon', value: '' }],
    }).expect(201)
  ).body;
  const res = await request(app).post(`/api/tests/${t.id}/run`).set(auth).send({}).expect(400);
  assert.match(res.body.error, /coupon is required/);
});

test('finished runs are readable from the DB after the relay forgets them', async () => {
  // Simulate the in-memory TTL eviction by asking for a run the Map never
  // had: insert a finished row directly, then GET it.
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status, success, final_result, report_status)
     values ($1, $2, 'g', 'https://example.com', 60, 'passed', true, 'ok', 'error')`,
    [id, operatorId]
  );
  const res = await request(app).get(`/api/runs/${id}`).set(auth).expect(200);
  assert.equal(res.body.status, 'passed');
  assert.equal(res.body.result.success, true);
  // report endpoint consults the DB row too
  await request(app).get(`/api/runs/${id}/report.pdf`).set(auth).expect(500);
});

test('a single run answers in the list shape, and keeps the keys CI polls', async () => {
  const t = (await makeTest({ name: 'permalink target' }).expect(201)).body;
  const started = (await request(app).post(`/api/tests/${t.id}/run`).set(auth).expect(200)).body;
  await pollUntil(async () => {
    const r = await pool.query('select status from runs where id = $1', [started.runId]);
    return r.rows[0]?.status === 'passed';
  });

  const body = (await request(app).get(`/api/runs/${started.runId}`).set(auth).expect(200)).body;

  // The columns RunDetail reads, so /runs/<id> renders through it (US-030).
  assert.equal(body.id, started.runId);
  assert.equal(body.test_name, 'permalink target');
  assert.equal(body.trigger, 'api');
  assert.equal(body.success, true);
  assert.equal(body.artifacts_deleted_at, null);
  assert.ok(body.created_at);
  assert.equal(typeof body.steps_count, 'number');

  // …on top of what docs/ci.md polls for, which must not move.
  assert.equal(body.status, 'passed');
  assert.equal(body.runId, started.runId);
  assert.equal(body.testId, t.id);
  assert.equal(body.result.success, true);
});

test('deleting a test detaches history instead of rewriting it', async () => {
  const t = (await makeTest({ name: 'doomed' }).expect(201)).body;
  const started = (
    await request(app).post(`/api/tests/${t.id}/run`).set(auth).send({}).expect(200)
  ).body;
  await pollUntil(async () => {
    const r = await pool.query('select status from runs where id = $1', [started.runId]);
    return r.rows[0]?.status === 'passed';
  });
  await request(app).delete(`/api/tests/${t.id}`).set(auth).expect(204);
  const row = (await pool.query('select * from runs where id = $1', [started.runId])).rows[0];
  assert.equal(row.test_id, null); // on delete set null
  assert.equal(row.goal, t.goal); // denormalized copy untouched
});
