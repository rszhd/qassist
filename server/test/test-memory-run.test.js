// @ts-check
// US-081: the loop, from one run's trace to the next run's prompt.
//
// `test-memory.test.js` pins the decision. This pins that the decision reaches
// the child and comes back — the part that only exists across two runs, and the
// part neither unit file can see.
//
// Two of the three things asserted here are the first build's silent bugs.
// Nothing wrote `runs.memory_used` / `memory_fingerprint`: the migration added
// the columns and `runState.js` typed them, and `persistInsert` never named
// them, so every persisted run read back as cold. And `QA_MEMORY` has to be
// ABSENT rather than empty on a run with no notebook, because "no
// agent-configuration difference from today's run path" is the story's own
// wording and `''` is a difference.
//
// The conditional upsert underneath is pg-mem's blind spot;
// `test-memory-postgres.test.js` is where the refusal is proved. What is proved
// here is the wiring on either side of it.
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

/** What the stub's generator concludes, in the agent's three sections. */
const NOTEBOOK = {
  successful_approach: [
    { id: 'a1', text: 'Open Billing from the account menu', steps: [2], run_id: 'earlier' },
  ],
  avoid_next_time: [],
  orientation: [],
};

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-memory-run-'));
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
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  await seedStoredKey(pool, /** @type {string} */ (getOperatorUserId()));
  ({ app } = await import('../src/server.js'));
});

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A saved test, which is the only thing that can own a notebook. */
async function makeTest(name) {
  const res = await request(app)
    .post('/api/tests')
    .set(auth)
    .send({
      name,
      goal: 'check the invoice payment status',
      start_url: 'https://billing.example.test/',
    })
    .expect(201);
  return res.body;
}

/**
 * Run a saved test to completion and return its row, plus the environment its
 * child was given. `teaches` decides whether the stub emits a notebook — it does
 * not decide whether the run is *allowed* to write one, which is the server's
 * call and the thing under test.
 */
async function runTest(testId, { teaches = true, fails = false } = {}) {
  const capture = path.join(artifactsDir, `env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = capture;
  if (teaches) process.env.QA_STUB_MEMORY = JSON.stringify(NOTEBOOK);
  if (fails) process.env.QA_STUB_FAIL = '1';
  try {
    const started = (
      await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200)
    ).body;
    const row = await pollUntil(async () => {
      const r = await pool.query('select * from runs where id = $1', [started.runId]);
      return r.rows[0]?.finished_at ? r.rows[0] : null;
    });
    // The notebook write is chained on `run.persisted` behind the row update, so
    // the row being final does not mean the notebook has landed.
    await new Promise((r) => setTimeout(r, 50));
    return { runId: started.runId, row, env: JSON.parse(fs.readFileSync(capture, 'utf8')) };
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
    delete process.env.QA_STUB_MEMORY;
    delete process.env.QA_STUB_FAIL;
  }
}

/** The feed lines one run produced, which is what a watcher actually sees. */
async function messagesOf(runId) {
  const { getRun } = await import('../src/runs.js');
  return (getRun(runId)?.events || [])
    .filter((e) => e.type === 'progress')
    .map((e) => /** @type {any} */ (e).message);
}

/** The one notebook row a test owns, or null before it has learned anything. */
async function memoryRow(testId) {
  const { rows } = await pool.query('select * from test_memory where test_id = $1', [testId]);
  return rows[0] || null;
}

test('an ad-hoc run is handed no notebook and is never asked for one', async () => {
  // No test, so nothing to remember and nothing to remember it for. The absence
  // is the assertion: an empty string here is a spawn that differs from today's
  // for a feature this run is not using.
  const capture = path.join(artifactsDir, `env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = capture;
  try {
    await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'buy a thing', start_url: 'https://shop.example.test/' })
      .expect(200);
    await pollUntil(() => fs.existsSync(capture));
    const env = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.ok(!('QA_MEMORY' in env), 'QA_MEMORY must be absent, not empty');
    assert.ok(!('QA_LEARN_MEMORY' in env), 'and nothing may be written back');
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
  }
});

test('a first run is cold, says so in its history, and writes a notebook', async () => {
  const t = await makeTest('billing');

  const first = await runTest(t.id);
  // Cold is a fact about what was supplied, and a saved test's first run has
  // nothing to be supplied with.
  assert.ok(!('QA_MEMORY' in first.env), 'nothing learned yet, so no notebook');
  assert.equal(first.env.QA_LEARN_MEMORY, '1', 'and it is told it may write one');
  assert.equal(first.row.memory_used, false);

  const learned = await memoryRow(t.id);
  assert.ok(learned, 'the passing run wrote a notebook');
  assert.deepEqual(learned.learned, NOTEBOOK);
});

test('the next run is handed that notebook, and may still write', async () => {
  const t = await makeTest('billing again');
  await runTest(t.id);
  assert.ok(await memoryRow(t.id), 'precondition: the first run taught');

  const second = await runTest(t.id);
  assert.ok(second.env.QA_MEMORY, 'the second run is handed the notebook');
  assert.deepEqual(JSON.parse(second.env.QA_MEMORY), NOTEBOOK);
  assert.equal(second.row.memory_used, true, 'and its history records that it was helped');
  // Every passing run contributes, whatever help it had. What stops advice
  // confirming itself is the *shape* of the write — an assisted run adds and
  // never erases, which `agent/run_memory.py` settles before the row is touched.
  assert.equal(second.env.QA_LEARN_MEMORY, '1');
});

test('a pass that concluded nothing leaves the notebook exactly as it was', async () => {
  // The settled-test path: the agent skips the generator when its trace met no
  // incident, so no event arrives. `learned_at` must keep naming the run that
  // contributed rather than the last one that happened to pass.
  const t = await makeTest('billing settled');
  await runTest(t.id);
  const taught = await memoryRow(t.id);

  await runTest(t.id, { teaches: false });
  const after = await memoryRow(t.id);
  assert.deepEqual(after.learned, taught.learned);
  assert.equal(String(after.learned_at), String(taught.learned_at), 'not restamped');
});

test('a failing run changes nothing, and the next run is still helped', async () => {
  // The commonest reason a QA test fails is that it found the bug it exists to
  // find. Withholding there would make the next run cold, and a cold pass
  // REPLACES — so a real regression would cost the test every lesson it had.
  const t = await makeTest('billing regression');
  await runTest(t.id);
  const before = await memoryRow(t.id);

  const failed = await runTest(t.id, { fails: true, teaches: false });
  assert.equal(failed.row.status, 'failed');
  const after = await memoryRow(t.id);
  assert.deepEqual(after.learned, before.learned);
  assert.equal(String(after.learned_at), String(before.learned_at), 'not touched at all');

  const next = await runTest(t.id, { teaches: false });
  assert.ok(next.env.QA_MEMORY, 'and the run after a failure is still given the notebook');
});

test('an edited test is still handed what it learned', async () => {
  // The revised rule. An edit used to make the next run cold, and that took a
  // notebook away for changes that left the app under test where it was. Now
  // only a person takes one away.
  const t = await makeTest('billing edited');
  await runTest(t.id);

  await pool.query('update tests set goal = $2 where id = $1', [
    t.id,
    'cancel the subscription instead',
  ]);

  const after = await runTest(t.id, { teaches: false });
  assert.ok(after.env.QA_MEMORY, 'the lessons still apply until somebody says otherwise');
  assert.equal(after.row.memory_used, true);
});

test('the run list serves cold-vs-assisted, which is what the gate compares', async () => {
  const t = await makeTest('billing api');
  await runTest(t.id);
  const second = await runTest(t.id);

  const shown = (await request(app).get(`/api/runs?test_id=${t.id}`).set(auth).expect(200)).body;
  const row = shown.runs.find((r) => r.id === second.runId);
  assert.equal(row.memory_used, true, 'the list is where a reader compares two runs of one test');
});

test('the feed says when a run is working from advice, and when it is not', async () => {
  // Somebody watching a run that behaves oddly needs to know whether it was
  // given advice, without opening the panel. Silent when there is nothing to
  // report — a first run of a test that has learned nothing is the ordinary
  // case, and a line for it would be noise on every run.
  const t = await makeTest('billing feed');
  const first = await runTest(t.id);
  const firstFeed = await messagesOf(first.runId);
  assert.equal(
    firstFeed.some((m) => m.includes('learned') || m.includes('cold')),
    false,
    'nothing learned yet is not worth a line'
  );

  const second = await runTest(t.id);
  assert.ok(
    (await messagesOf(second.runId)).some((m) =>
      m.startsWith('Starting with what earlier runs of this test learned')
    )
  );

  // Clear is what makes a run cold now, and a cold run says nothing — a first
  // run of a test nobody has taught is the ordinary case, and a line for it
  // would be noise on every run.
  await request(app).delete(`/api/tests/${t.id}/memory`).set(auth).expect(204);
  const cold = await runTest(t.id, { teaches: false });
  assert.equal(
    (await messagesOf(cold.runId)).some((m) => m.includes('learned')),
    false
  );
});
