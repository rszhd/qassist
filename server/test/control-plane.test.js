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
  const a = (await makeTest({ name: 'suite member a' }).expect(201)).body;
  const b = (await makeTest({ name: 'suite member b' }).expect(201)).body;

  await request(app).post('/api/suites').set(auth).send({ test_ids: [a.id] }).expect(400);
  const unknown = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'bad', test_ids: [randomUUID()] })
      .expect(400)
  ).body;
  assert.match(unknown.error, /unknown test id/);

  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'smoke pack', test_ids: [a.id, b.id] })
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
  const suite = (
    await request(app).post('/api/suites').set(auth).send({ name: 'empty' }).expect(201)
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
