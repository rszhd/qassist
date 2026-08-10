// @ts-check
// US-081's panel: what a person can see and do about what a test remembers.
//
// The read carries the story's promise — the panel shows the notebook the next
// run receives, not a description of it — so the assertion that matters is that
// `supplied` here is the same value the spawn is given. The two controls are
// both deletions, and the third thing the panel must refuse is a write: a lesson
// means "a trace produced this", and an endpoint that could add one would let
// hand-written advice claim provenance it does not have.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** @type {import('express').Express} */
let app;
let artifactsDir;
/** @type {any} */
let pool;

const LESSON = {
  id: 'a1b2c3d4e5f6',
  text: 'Open Billing from the account menu, not the workspace sidebar',
  steps: [4],
  run_id: null,
  learned_at: '2026-08-01T09:00:00.000Z',
  hinted: false,
};
const MISTAKE = {
  id: 'f6e5d4c3b2a1',
  attempt: 'Use the global search for the invoice number',
  reason: 'It searched help articles rather than billing records',
  instead: 'Open Billing and use the invoice table filter',
  steps: [2, 3],
  run_id: null,
  learned_at: '2026-08-01T09:00:00.000Z',
  hinted: true,
};
const NOTEBOOK = {
  successful_approach: [LESSON],
  avoid_next_time: [MISTAKE],
  orientation: [],
};

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-memory-panel-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
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
  // `nullif` is standard SQL and pg-mem does not have it, so the edit route —
  // which uses it for every optional field — 500s there. Registered rather than
  // tested around, because what is under test here IS that route's answer: a
  // helper poking the row directly would prove nothing about what the dialog is
  // told. Two-arg text form only; that is all `PUT /api/tests/:id` asks for.
  mem.public.registerFunction({
    name: 'nullif',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (/** @type {any} */ a, /** @type {any} */ b) => (a === b ? null : a),
  });
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  await seedStoredKey(pool, /** @type {string} */ (getOperatorUserId()));
  ({ app } = await import('../src/server.js'));
});

/** A saved test with a notebook already written under its current inputs. */
async function testWithMemory() {
  const t = (
    await request(app)
      .post('/api/tests')
      .set(auth)
      .send({
        name: `billing ${randomUUID().slice(0, 8)}`,
        goal: 'check the invoice payment status',
        start_url: 'https://billing.example.test/',
      })
      .expect(201)
  ).body;

  // The fingerprint the row must carry is the one this test's inputs hash to,
  // and the only honest way to get it is the path a run uses.
  const { previewMemory } = await import('../src/runs.js');
  const { runnableFieldsFor } = await import('../src/routes/helpers.js');
  const { rows } = await pool.query('select * from tests where id = $1', [t.id]);
  const resolved = await runnableFieldsFor(rows[0]);
  if ('error' in resolved) throw new Error(`could not resolve the test: ${resolved.error}`);
  const fingerprint = previewMemory(resolved.fields).fingerprint;

  await pool.query(
    `insert into test_memory (test_id, fingerprint, format_version, learned, learned_at)
     values ($1, $2, 1, $3, now())`,
    [t.id, fingerprint, JSON.stringify(NOTEBOOK)]
  );
  return { test: t };
}

const panelOf = async (testId) =>
  (await request(app).get(`/api/tests/${testId}/memory`).set(auth).expect(200)).body;

test('the panel shows what the next run is handed, not a description of it', async () => {
  const { test: t } = await testWithMemory();
  const panel = await panelOf(t.id);
  assert.deepEqual(panel.learned, NOTEBOOK);
  assert.deepEqual(panel.supplied, NOTEBOOK, 'the same value the spawn carries');
  assert.equal(panel.withheld, null);
});

test('a test that has learned nothing has an empty panel, not an error', async () => {
  const t = (
    await request(app)
      .post('/api/tests')
      .set(auth)
      .send({ name: 'fresh', goal: 'check something', start_url: 'https://x.example.test/' })
      .expect(201)
  ).body;
  const panel = await panelOf(t.id);
  assert.deepEqual(panel.learned, {});
  assert.equal(panel.supplied, null);
  assert.equal(panel.withheld, null, 'nothing learned yet is not advice being kept back');
});

test('an edited test shows its superseded lessons and says they no longer apply', async () => {
  const { test: t } = await testWithMemory();
  await pool.query('update tests set goal = $2 where id = $1', [t.id, 'cancel the subscription']);
  const panel = await panelOf(t.id);
  assert.equal(panel.withheld, 'inputs_changed');
  assert.equal(panel.supplied, null);
  assert.deepEqual(panel.learned, NOTEBOOK, 'readable until a pass replaces them');
});

test('removing one wrong lesson leaves the rest standing', async () => {
  const { test: t } = await testWithMemory();
  const after = (
    await request(app)
      .delete(`/api/tests/${t.id}/memory/lessons/${LESSON.id}`)
      .set(auth)
      .expect(200)
  ).body;
  assert.deepEqual(after.learned.successful_approach, []);
  assert.deepEqual(after.learned.avoid_next_time, [MISTAKE], 'the other lesson is untouched');
  // Removing a lesson is not an edit to what the test means, so what is left is
  // still supplied — the run after this one is assisted, not cold.
  assert.deepEqual(after.supplied.avoid_next_time, [MISTAKE]);
});

test('clearing throws the notebook away and leaves run history alone', async () => {
  const { test: t } = await testWithMemory();
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, test_id, user_id, goal, start_url, max_steps, status)
     select $1, $2, user_id, goal, start_url, max_steps, 'passed' from tests where id = $2`,
    [runId, t.id]
  );

  await request(app).delete(`/api/tests/${t.id}/memory`).set(auth).expect(204);

  const panel = await panelOf(t.id);
  assert.deepEqual(panel.learned, {}, 'the next run is a first run again');
  const { rows } = await pool.query('select id from runs where id = $1', [runId]);
  assert.equal(rows.length, 1, 'a run is evidence and a notebook is a working note');
});

test('an edit that moves the fingerprint says so, with what is at stake', async () => {
  // The one thing the client cannot work out for itself: the hash is the
  // server's, and the panel must never grow a second spelling of it. The count
  // is there so the dialog can stay quiet when there is nothing to lose.
  const { test: t } = await testWithMemory();
  const res = await request(app)
    .put(`/api/tests/${t.id}`)
    .set(auth)
    .send({ goal: 'cancel the subscription instead' })
    .expect(200);
  assert.equal(res.body.memory.invalidated, true);
  assert.equal(res.body.memory.lessons, 2);
});

test('an edit that leaves the flow alone says nothing is at stake', async () => {
  // Renaming a test, or changing its step ceiling, is not a different flow —
  // and a prompt there would be the nagging the story refuses.
  const { test: t } = await testWithMemory();
  const res = await request(app)
    .put(`/api/tests/${t.id}`)
    .set(auth)
    .send({ name: 'billing, renamed', max_steps: 40 })
    .expect(200);
  assert.equal(res.body.memory.invalidated, false);
});

test('a test with nothing learned never has anything at stake', async () => {
  const t = (
    await request(app)
      .post('/api/tests')
      .set(auth)
      .send({ name: 'fresh edit', goal: 'check something', start_url: 'https://x.example.test/' })
      .expect(201)
  ).body;
  const res = await request(app)
    .put(`/api/tests/${t.id}`)
    .set(auth)
    .send({ goal: 'check something else' })
    .expect(200);
  assert.equal(res.body.memory.lessons, 0);
});

test('keeping the lessons re-keys them to the edited test', async () => {
  // The person's answer to a question the fingerprint cannot ask: the hash knows
  // THAT the instructions changed, never whether the lessons still hold. A typo
  // fixed in the goal and the test repointed at another app look identical to it.
  const { test: t } = await testWithMemory();
  await pool.query('update tests set goal = $2 where id = $1', [t.id, 'check it more carefully']);
  assert.equal((await panelOf(t.id)).withheld, 'inputs_changed');

  const kept = (await request(app).post(`/api/tests/${t.id}/memory/keep`).set(auth).expect(200)).body;
  assert.equal(kept.withheld, null, 'they apply again');
  assert.deepEqual(kept.supplied, NOTEBOOK, 'and the next run is handed them');
  assert.deepEqual(kept.learned, NOTEBOOK, 'unchanged — this re-keys, it does not rewrite');
});

test('keeping is refused for a test that has learned nothing', async () => {
  const t = (
    await request(app)
      .post('/api/tests')
      .set(auth)
      .send({ name: 'nothing to keep', goal: 'check something', start_url: 'https://y.example.test/' })
      .expect(201)
  ).body;
  await request(app).post(`/api/tests/${t.id}/memory/keep`).set(auth).expect(404);
});

test('there is no way to write a lesson', async () => {
  // "Learned" means a trace produced it. An endpoint that accepted one would let
  // hand-written advice claim provenance it does not have, and the case it would
  // serve — this lesson is wrong — is served by removing it.
  const { test: t } = await testWithMemory();
  for (const method of ['put', 'post', 'patch']) {
    const res = await request(app)[method](`/api/tests/${t.id}/memory`)
      .set(auth)
      .send({ learned: { successful_approach: [{ id: 'x', text: 'trust me' }] } });
    assert.ok(res.status === 404 || res.status === 405, `${method} must not write: got ${res.status}`);
  }
  assert.deepEqual((await panelOf(t.id)).learned, NOTEBOOK);
});

test("another tenant's notebook is not readable", async () => {
  const { test: t } = await testWithMemory();
  const other = (
    await pool.query('insert into users (email) values ($1) returning id', [
      `other-${randomUUID().slice(0, 8)}@example.test`,
    ])
  ).rows[0].id;
  await pool.query('update tests set user_id = $2 where id = $1', [t.id, other]);
  await request(app).get(`/api/tests/${t.id}/memory`).set(auth).expect(404);
  await request(app).delete(`/api/tests/${t.id}/memory`).set(auth).expect(404);
  await request(app)
    .delete(`/api/tests/${t.id}/memory/lessons/${LESSON.id}`)
    .set(auth)
    .expect(404);
  await request(app).post(`/api/tests/${t.id}/memory/keep`).set(auth).expect(404);
});
