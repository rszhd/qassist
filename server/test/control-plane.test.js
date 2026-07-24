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
/** @type {(now?: number) => Promise<{ pruned: number, skipped: number }>} */
let sweepArtifacts;
let artifactsDir;
/** The seeded operator — the owner of runs inserted directly, as createRun sets. */
let operatorId;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cp-test-'));
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

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  operatorId = getOperatorUserId();
  ({ app } = await import('../src/server.js'));
  ({ sweepArtifacts } = await import('../src/retention.js'));
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

// --- US-011: run history -----------------------------------------------------

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

/** An artifact dir with a report + recording in it, last written `ageDays` ago. */
function makeArtifacts(id, ageDays) {
  const dir = path.join(artifactsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'pdf');
  fs.writeFileSync(path.join(dir, 'recording.mp4'), 'mp4');
  const at = new Date(Date.now() - ageDays * 86400_000);
  fs.utimesSync(dir, at, at);
  return dir;
}

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
