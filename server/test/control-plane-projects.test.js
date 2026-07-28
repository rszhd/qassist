// @ts-check
// Control-plane: projects & modules — grouping, slugs, filters, batch run
// (US-023). Shared harness: test/helpers/control-plane.js.
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

test('projects: create derives a slug, list carries counts', async () => {
  const p = await makeProject('Checkout Flow');
  assert.equal(p.slug, 'checkout-flow');
  assert.equal(p.test_count, 0);

  const dup = await makeProject('Checkout Flow');
  assert.equal(dup.slug, 'checkout-flow-2'); // unique per user

  const list = (await request(app).get('/api/projects').set(auth).expect(200)).body;
  assert.ok(list.projects.some((x) => x.id === p.id));

  await request(app).post('/api/projects').set(auth).send({}).expect(400);
});

test('projects and modules are addressable by slug as well as id', async () => {
  const p = await makeProject('Storefront');
  const mod = (
    await request(app)
      .post(`/api/projects/${p.id}/modules`)
      .set(auth)
      .send({ name: 'Auth' })
      .expect(201)
  ).body;
  assert.equal(mod.slug, 'auth');

  // The CI-facing form US-008 will document — no UUIDs in the config.
  const bySlug = (await request(app).get('/api/projects/storefront').set(auth).expect(200)).body;
  assert.equal(bySlug.id, p.id);
  assert.deepEqual(
    bySlug.modules.map((m) => m.slug),
    ['auth']
  );
  await request(app).get('/api/projects/nope').set(auth).expect(404);
});

test('project detail counts everything the project holds, not just its tests', async () => {
  const p = await makeProject('Counted');
  const empty = (await request(app).get(`/api/projects/${p.id}`).set(auth).expect(200)).body;
  assert.deepEqual(
    { ...empty, modules: undefined },
    { ...empty, modules: undefined, test_count: 0, suite_count: 0, session_count: 0, fixture_count: 0 }
  );

  const t = (await makeTest({ project_id: p.id }).expect(201)).body;
  await request(app)
    .post('/api/suites')
    .set(auth)
    .send({ name: 'smoke', project_id: p.id, test_ids: [t.id] })
    .expect(201);
  await request(app)
    .post(`/api/projects/${p.id}/sessions`)
    .set(auth)
    .send({ name: 'staging login', login_test_id: t.id })
    .expect(201);
  // Straight into the table: the count is a row fact, and going through the
  // upload route would put bytes on the developer's disk to prove it.
  await pool.query(
    `insert into fixtures (project_id, filename, name_key, size_bytes) values ($1, $2, $3, $4)`,
    [p.id, 'cv.pdf', 'cv.pdf', 1024]
  );

  const detail = (await request(app).get(`/api/projects/${p.id}`).set(auth).expect(200)).body;
  assert.equal(detail.test_count, 1);
  assert.equal(detail.suite_count, 1);
  assert.equal(detail.session_count, 1);
  assert.equal(detail.fixture_count, 1);

  // Another project's belongings never leak into this one's tab strip.
  const other = await makeProject('Uncounted');
  const otherDetail = (await request(app).get(`/api/projects/${other.id}`).set(auth).expect(200)).body;
  assert.deepEqual(
    [otherDetail.test_count, otherDetail.suite_count, otherDetail.session_count, otherDetail.fixture_count],
    [0, 0, 0, 0]
  );
});

test('modules list flat, across projects or filtered to one', async () => {
  const a = await makeProject('Flat A');
  const b = await makeProject('Flat B');
  for (const [project, name] of [[a, 'one'], [b, 'two']]) {
    await request(app)
      .post(`/api/projects/${project.id}/modules`)
      .set(auth)
      .send({ name })
      .expect(201);
  }

  const all = (await request(app).get('/api/modules').set(auth).expect(200)).body.modules;
  const names = all.map((m) => m.name);
  assert.ok(names.includes('one') && names.includes('two'), 'both projects are represented');

  const mine = (await request(app).get(`/api/modules?project_id=${b.id}`).set(auth).expect(200)).body;
  assert.deepEqual(mine.modules.map((m) => m.name), ['two']);
  await request(app).get('/api/modules?project_id=nope').set(auth).expect(400);
});

test('assigning a test to a module derives its project', async () => {
  const p = await makeProject('Derived');
  const mod = (
    await request(app)
      .post(`/api/projects/${p.id}/modules`)
      .set(auth)
      .send({ name: 'Payment' })
      .expect(201)
  ).body;

  // module_id alone is enough — the server fills project_id (decision 4).
  const t = (await makeTest({ name: 'pay test', module_id: mod.id }).expect(201)).body;
  assert.equal(t.module_id, mod.id);
  assert.equal(t.project_id, p.id);

  // A module from another project can't be claimed alongside a mismatched one.
  const other = await makeProject('Other');
  const moved = (
    await request(app)
      .put(`/api/tests/${t.id}`)
      .set(auth)
      .send({ project_id: other.id })
      .expect(200)
  ).body;
  assert.equal(moved.project_id, other.id);
  assert.equal(moved.module_id, null); // moving projects drops the stale module

  await request(app)
    .put(`/api/tests/${t.id}`)
    .set(auth)
    .send({ module_id: randomUUID() })
    .expect(400);

  // Unassigning entirely puts it back in Ungrouped.
  const bare = (
    await request(app).put(`/api/tests/${t.id}`).set(auth).send({ project_id: null }).expect(200)
  ).body;
  assert.equal(bare.project_id, null);
  assert.equal(bare.module_id, null);
});

test('the test list filters by project and module, with a none bucket', async () => {
  const p = await makeProject('Filterable');
  const mod = (
    await request(app)
      .post(`/api/projects/${p.id}/modules`)
      .set(auth)
      .send({ name: 'Grouped' })
      .expect(201)
  ).body;
  const inMod = (await makeTest({ name: 'in module', module_id: mod.id }).expect(201)).body;
  const inProj = (await makeTest({ name: 'in project', project_id: p.id }).expect(201)).body;
  const loose = (await makeTest({ name: 'ungrouped' }).expect(201)).body;

  const byProject = (
    await request(app).get(`/api/tests?project_id=${p.id}`).set(auth).expect(200)
  ).body;
  const projectIds = byProject.tests.map((t) => t.id);
  assert.ok(projectIds.includes(inMod.id) && projectIds.includes(inProj.id));
  assert.ok(!projectIds.includes(loose.id));

  const byModule = (
    await request(app).get(`/api/tests?module_id=${mod.id}`).set(auth).expect(200)
  ).body;
  assert.deepEqual(
    byModule.tests.map((t) => t.id),
    [inMod.id]
  );

  const ungrouped = (
    await request(app).get('/api/tests?project_id=none').set(auth).expect(200)
  ).body;
  assert.ok(ungrouped.tests.some((t) => t.id === loose.id));
  assert.ok(!ungrouped.tests.some((t) => t.id === inProj.id));
});

test('running a module starts one run per member test; empty is a 400', async () => {
  const p = await makeProject('Runnable');
  const mod = (
    await request(app)
      .post(`/api/projects/${p.id}/modules`)
      .set(auth)
      .send({ name: 'Smoke' })
      .expect(201)
  ).body;
  await request(app).post(`/api/modules/${mod.id}/run`).set(auth).expect(400);

  const a = (await makeTest({ name: 'mod a', module_id: mod.id }).expect(201)).body;
  const b = (await makeTest({ name: 'mod b', module_id: mod.id }).expect(201)).body;

  const res = (
    await request(app)
      .post(`/api/projects/runnable/modules/smoke/run`)
      .set(auth)
      .send({ trigger: 'ci', start_url: 'https://preview.example.com' })
      .expect(200)
  ).body;
  assert.equal(res.runs.length, 2);
  assert.deepEqual(res.runs.map((r) => r.testId).sort(), [a.id, b.id].sort());
  for (const r of res.runs) {
    const row = await pollUntil(async () => {
      const q = await pool.query('select * from runs where id = $1', [r.runId]);
      return q.rows[0]?.status === 'passed' ? q.rows[0] : null;
    });
    assert.equal(row.trigger, 'ci');
    assert.equal(row.start_url, 'https://preview.example.com');
  }

  // A whole project runs too.
  const projRun = (await request(app).post(`/api/projects/${p.id}/run`).set(auth).expect(200))
    .body;
  assert.equal(projRun.runs.length, 2);
});

test('deleting a module or project leaves its tests alone', async () => {
  const p = await makeProject('Disposable');
  const mod = (
    await request(app)
      .post(`/api/projects/${p.id}/modules`)
      .set(auth)
      .send({ name: 'Doomed' })
      .expect(201)
  ).body;
  const t = (await makeTest({ name: 'survivor', module_id: mod.id }).expect(201)).body;

  await request(app).delete(`/api/modules/${mod.id}`).set(auth).expect(204);
  const afterModule = (await request(app).get(`/api/tests/${t.id}`).set(auth).expect(200)).body;
  assert.equal(afterModule.module_id, null);
  assert.equal(afterModule.project_id, p.id); // stays in the project

  // A project delete takes its suites with it, but never its tests.
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'doomed pack', project_id: p.id, test_ids: [t.id] })
      .expect(201)
  ).body;
  await request(app).delete(`/api/projects/${p.id}`).set(auth).expect(204);
  const afterProject = (await request(app).get(`/api/tests/${t.id}`).set(auth).expect(200)).body;
  assert.equal(afterProject.project_id, null);
  await request(app).get(`/api/suites/${suite.id}`).set(auth).expect(404);
});
