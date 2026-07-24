// @ts-check
// Control-plane: suites — CRUD, membership validation, batch run (US-009/US-023).
// Shared harness: test/helpers/control-plane.js.
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

test('suites: CRUD, membership validation, one-shot run', async () => {
  // Suites are project-scoped (US-023 decision 6), so members need a project.
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Suite Host' }).expect(201)
  ).body;
  const a = (
    await makeTest({ name: 'suite member a', project_id: project.id }).expect(201)
  ).body;
  const b = (
    await makeTest({ name: 'suite member b', project_id: project.id }).expect(201)
  ).body;

  await request(app)
    .post('/api/suites')
    .set(auth)
    .send({ test_ids: [a.id], project_id: project.id })
    .expect(400);
  const unknown = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'bad', project_id: project.id, test_ids: [randomUUID()] })
      .expect(400)
  ).body;
  assert.match(unknown.error, /unknown test id/);

  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'smoke pack', project_id: project.id, test_ids: [a.id, b.id] })
      .expect(201)
  ).body;
  assert.deepEqual(suite.test_ids, [a.id, b.id]);

  const detail = (await request(app).get(`/api/suites/${suite.id}`).set(auth).expect(200)).body;
  assert.deepEqual(
    detail.tests.map((t) => t.id),
    [a.id, b.id]
  );

  // reorder + rename via PUT
  const updated = (
    await request(app)
      .put(`/api/suites/${suite.id}`)
      .set(auth)
      .send({ name: 'renamed pack', test_ids: [b.id, a.id] })
      .expect(200)
  ).body;
  assert.equal(updated.name, 'renamed pack');
  assert.deepEqual(updated.test_ids, [b.id, a.id]);

  const runRes = (
    await request(app)
      .post(`/api/suites/${suite.id}/run`)
      .set(auth)
      .send({ start_url: 'https://preview.example.com', trigger: 'ci' })
      .expect(200)
  ).body;
  assert.equal(runRes.runs.length, 2);
  assert.deepEqual(
    runRes.runs.map((r) => r.testId),
    [b.id, a.id]
  );
  for (const r of runRes.runs) {
    const row = await pollUntil(async () => {
      const q = await pool.query('select * from runs where id = $1', [r.runId]);
      return q.rows[0]?.status === 'passed' ? q.rows[0] : null;
    });
    assert.equal(row.trigger, 'ci');
    assert.equal(row.start_url, 'https://preview.example.com');
  }

  await request(app).delete(`/api/suites/${suite.id}`).set(auth).expect(204);
  // deleting the suite never deletes its tests
  await request(app).get(`/api/tests/${a.id}`).set(auth).expect(200);
});

test('variables: a suite run sprays the override across every member', async () => {
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Env Pack' }).expect(201)
  ).body;
  const a = (
    await makeTest({
      name: 'member a',
      goal: 'check {{env}}',
      project_id: project.id,
      variables: [{ name: 'env', value: 'staging' }],
    }).expect(201)
  ).body;
  const b = (
    await makeTest({
      name: 'member b',
      goal: 'verify homepage on {{env}}',
      project_id: project.id,
      variables: [{ name: 'env', value: 'staging' }],
    }).expect(201)
  ).body;
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'env suite', project_id: project.id, test_ids: [a.id, b.id] })
      .expect(201)
  ).body;

  const runRes = (
    await request(app)
      .post(`/api/suites/${suite.id}/run`)
      .set(auth)
      .send({ variables: { env: 'prod' } })
      .expect(200)
  ).body;
  assert.equal(runRes.runs.length, 2);
  for (const r of runRes.runs) {
    const row = await pollUntil(async () => {
      const q = await pool.query('select goal, variables from runs where id = $1', [r.runId]);
      return q.rows[0] || null;
    });
    assert.match(row.goal, /prod/);
    assert.deepEqual(row.variables, { env: 'prod' });
  }
});

test('running an empty suite is a 400', async () => {
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'Empties' }).expect(201)
  ).body;
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'empty', project_id: project.id })
      .expect(201)
  ).body;
  const res = await request(app).post(`/api/suites/${suite.id}/run`).set(auth).expect(400);
  assert.match(res.body.error, /no tests/);
});

test('suite membership is confined to the suite project', async () => {
  const p = await makeProject('Suite Scope');
  const other = await makeProject('Elsewhere');
  const mine = (await makeTest({ name: 'mine', project_id: p.id }).expect(201)).body;
  const theirs = (await makeTest({ name: 'theirs', project_id: other.id }).expect(201)).body;
  const loose = (await makeTest({ name: 'loose' }).expect(201)).body;

  // No project at all → rejected.
  await request(app).post('/api/suites').set(auth).send({ name: 'x' }).expect(400);

  for (const outsider of [theirs.id, loose.id]) {
    const res = await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'cross', project_id: p.id, test_ids: [mine.id, outsider] })
      .expect(400);
    assert.match(res.body.error, /not in this suite's project/);
  }

  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'ok', project_id: p.id, test_ids: [mine.id] })
      .expect(201)
  ).body;
  // The same guard applies on membership edits, not just creation.
  await request(app)
    .put(`/api/suites/${suite.id}`)
    .set(auth)
    .send({ test_ids: [mine.id, theirs.id] })
    .expect(400);

  const scoped = (
    await request(app).get(`/api/suites?project_id=${p.id}`).set(auth).expect(200)
  ).body;
  assert.deepEqual(
    scoped.suites.map((s) => s.id),
    [suite.id]
  );
});
