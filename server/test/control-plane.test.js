// @ts-check
// Control-plane tests (US-009): saved tests + suites CRUD and runs
// persistence, against the real migrations applied to an in-memory pg-mem
// database (injected into db.js before the app loads). Indexes are stripped
// (see runMigrations skipIndexes) because pg-mem's partial-index support
// returns wrong query results.
import { test, before } from 'node:test';
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

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cp-test-'));
  // Config is read at import time, so env must be set before importing.
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'; // gates run creation
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
  // Real-Postgres builtin that pg-mem lacks (used by PUT /api/tests/:id).
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

async function pollUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function makeTest(overrides = {}) {
  return request(app)
    .post('/api/tests')
    .set(auth)
    .send({
      name: 'login smoke',
      goal: 'log in and see the dashboard',
      start_url: 'https://example.com',
      ...overrides,
    });
}

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

test('finished runs are readable from the DB after the relay forgets them', async () => {
  // Simulate the in-memory TTL eviction by asking for a run the Map never
  // had: insert a finished row directly, then GET it.
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, goal, start_url, max_steps, status, success, final_result, report_status)
     values ($1, 'g', 'https://example.com', 60, 'passed', true, 'ok', 'error')`,
    [id]
  );
  const res = await request(app).get(`/api/runs/${id}`).set(auth).expect(200);
  assert.equal(res.body.status, 'passed');
  assert.equal(res.body.result.success, true);
  // report endpoint consults the DB row too
  await request(app).get(`/api/runs/${id}/report.pdf`).set(auth).expect(500);
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

// --- US-023: projects & modules ---------------------------------------------

async function makeProject(name) {
  return (await request(app).post('/api/projects').set(auth).send({ name }).expect(201)).body;
}

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

test('projects endpoints require the bearer token', async () => {
  await request(app).get('/api/projects').expect(401);
  await request(app).post('/api/projects').send({ name: 'x' }).expect(401);
  await request(app).post(`/api/modules/${randomUUID()}/run`).expect(401);
});
