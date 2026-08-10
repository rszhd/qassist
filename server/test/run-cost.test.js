// @ts-check
// US-046: what a run spent, from the agent's `done` to the row, the API and the
// report file.
//
// `agent/run_cost.py` owns the hard question — is this zero a measurement or the
// absence of one — and `agent/tests/test_run_cost.py` pins it assertion-first.
// What this file owns is everything after stdout, and it is the same question
// asked of each layer in turn: the row must not store a cost it does not have,
// the API must not serve one, and neither may turn "unknown" into `0`.
//
// The trap that motivates the last two tests is a type, not a value. `numeric`
// comes back from `pg` as a STRING, so a cost passed through untouched reaches
// clients as `"0.041000"` from the row and `0.041` from the live relay — the
// same run changing shape as it stops being live. pg-mem does not reproduce
// that (it hands back a number), which is exactly why `run-cost-postgres.test.js`
// exists beside this file and why the assertion here is written against the
// value rather than only against the type.
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

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cost-test-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.REPORTS_ENABLED = '1';
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

const PRICED = {
  prompt_tokens: 12000,
  completion_tokens: 800,
  total_tokens: 12800,
  entry_count: 6,
  total_cost: 0.041,
  cost_known: true,
  by_model: [
    {
      model: 'gpt-4.1', prompt_tokens: 12000, completion_tokens: 800,
      total_tokens: 12800, invocations: 6, cost: 0.041, cost_known: true,
    },
  ],
};

/** The same run, measured in tokens but not in money. */
const UNPRICED = {
  ...PRICED,
  total_cost: null,
  cost_known: false,
  by_model: [{ ...PRICED.by_model[0], cost: null, cost_known: false }],
};

/** Start a run whose stub reports `usage`, and wait until the row has settled. */
async function runWithUsage(usage) {
  if (usage) process.env.QA_STUB_USAGE = JSON.stringify(usage);
  try {
    const res = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'buy a thing', start_url: 'https://shop.example.test/' })
      .expect(200);
    const runId = res.body.runId;
    const dataPath = path.join(artifactsDir, runId, 'report_data.json');
    await pollUntil(() => fs.existsSync(dataPath));
    // The relay evicts a finished run on a timer, so read the row directly
    // rather than racing it — the row is what this file is about anyway.
    const row = await pollUntil(async () => {
      const { rows } = await pool.query('select * from runs where id = $1', [runId]);
      return rows[0] && rows[0].finished_at ? rows[0] : null;
    });
    return { runId, row, data: JSON.parse(fs.readFileSync(dataPath, 'utf8')) };
  } finally {
    delete process.env.QA_STUB_USAGE;
  }
}

test('a priced run stores its tokens and its cost', async () => {
  const { row } = await runWithUsage(PRICED);
  assert.equal(row.prompt_tokens, 12000);
  assert.equal(row.completion_tokens, 800);
  assert.equal(row.total_tokens, 12800);
  assert.equal(row.cost_known, true);
  assert.equal(Number(row.total_cost), 0.041);
});

test('an unpriced run keeps its tokens and stores no cost at all', async () => {
  // The whole story in one row. Tokens are a measurement; the cost is not, and
  // a 0 here is the number someone reconciles against an invoice.
  const { row } = await runWithUsage(UNPRICED);
  assert.equal(row.total_tokens, 12800, 'tokens survive a pricing failure');
  assert.equal(row.cost_known, false);
  assert.equal(row.total_cost, null, 'null, never 0');
});

test('a run nothing measured is distinguishable from a run that cost nothing', async () => {
  // No `usage` on the done event at all — every run from before this story, and
  // any run that crashed before browser-use built a summary.
  const { row } = await runWithUsage(null);
  assert.equal(row.total_tokens, null);
  assert.equal(row.prompt_tokens, null);
  assert.equal(row.cost_known, false);
  assert.equal(row.total_cost, null);
});

test('the API serves an unknown cost as null and never as zero', async () => {
  const { runId } = await runWithUsage(UNPRICED);
  const { body } = await request(app).get(`/api/runs/${runId}`).set(auth).expect(200);
  assert.equal(body.total_tokens, 12800);
  assert.equal(body.cost_known, false);
  assert.equal(body.total_cost, null);
});

test('the API serves a known cost as a number, not as a string', async () => {
  // `numeric` is a string out of `pg`. Untouched, a client comparing
  // `run.total_cost > 0.1` gets a string comparison, and summing a page of
  // history concatenates. Asserted on the type as well as the value because
  // the value alone passes on pg-mem either way.
  const { runId } = await runWithUsage(PRICED);
  const { body } = await request(app).get(`/api/runs/${runId}`).set(auth).expect(200);
  assert.equal(typeof body.total_cost, 'number');
  assert.equal(body.total_cost, 0.041);
  assert.equal(body.cost_known, true);
});

test('the per-model breakdown lands in the report file, not in the row', async () => {
  // A run bills against three or four LLMs. Which of them spent the money is a
  // run-detail question; widening the table for it is what this split avoids.
  const { data, row } = await runWithUsage(PRICED);
  assert.equal(data.usage.by_model.length, 1);
  assert.equal(data.usage.by_model[0].model, 'gpt-4.1');
  assert.equal(data.usage.by_model[0].cost, 0.041);
  assert.ok(!('by_model' in row), 'the row keeps the totals and nothing else');
});

test('a report for a run nothing measured carries a null, not a fabricated zero', async () => {
  const { data } = await runWithUsage(null);
  assert.equal(data.usage, null);
});

test('the cost switch reaches the child, because off has to mean no request', async () => {
  // The one flag whose "off" is a promise about the network. The server decides
  // it; only the child can prove it was told. Same instrument US-042, US-048
  // and US-044 use, for the same reason.
  const capture = path.join(artifactsDir, `cost-env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = capture;
  try {
    await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'quiet run', start_url: 'https://shop.example.test/' })
      .expect(200);
    await pollUntil(() => fs.existsSync(capture));
    const env = JSON.parse(fs.readFileSync(capture, 'utf8'));
    // On by default — since US-039 the user funds every run, so what it cost is
    // part of the result. `'1'`, not undefined: an unsent variable would leave
    // the child inheriting whatever the server process happens to hold.
    assert.equal(env.QA_CALCULATE_COST, '1');
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
  }
});
