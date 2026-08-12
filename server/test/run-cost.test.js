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
let userId = '';

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
  userId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, userId);
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

// ── The History total (tier 2) ───────────────────────────────────────────────
//
// Everything above asks whether ONE run's cost is real. This asks whether a SUM
// of them is, and it fails worse: a total that quietly drops the runs it could
// not price is wrong DOWNWARDS, reads as authoritative, and is the figure
// somebody reconciles against an invoice before deciding the product lies. The
// story's own note on this tier is "the aggregate is the one with a trap in it".
//
// The contract under test — `GET /api/runs` gains one object beside `total`:
//
//     "usage": { "total_cost": 1.238412, "priced_runs": 33, "total_tokens": 1284310 }
//
// and three rules hold over it. It covers the whole FILTER SET, never the page.
// `total_cost` branches on `cost_known`, never on the number beside it. And an
// empty sum is `null` — for cost and for tokens alike — because `coalesce(…, 0)`
// is how "$0.00 across 40 runs" gets printed. `priced_runs` is what lets the UI
// say a total is partial; without it there is nothing to compare against
// `total`, and a partial total has no way to admit it.
//
// Two rules are NOT here, because pg-mem cannot fail them: the JSON type of
// `sum(numeric)` and whether the accumulation is exact. Both are in
// `run-cost-postgres.test.js`, against a real server.
//
// Seeding is a direct insert into `runs`, and every case takes its own hour in
// 2019 so the aggregate it asks for cannot see the runs the tests above left
// behind. That window is a `?since`/`?until` filter, so each case also proves
// the aggregate answers the filter it was given.
const WINDOW_BASE = Date.UTC(2019, 0, 1);
let windowCount = 0;

/** A fresh, private hour to seed runs into, as the filter that selects them. */
function nextWindow() {
  const start = new Date(WINDOW_BASE + windowCount++ * 3600e3);
  const end = new Date(start.getTime() + 3600e3);
  return {
    start,
    end,
    query: `since=${start.toISOString()}&until=${end.toISOString()}`,
  };
}

/**
 * One finished run in a window, with the cost columns stated outright — the
 * agent path is proven above, and what this half is about is the SQL.
 * @param {{start: Date}} window
 * @param {{ tokens?: number|null, cost?: number|null, known?: boolean }} usage
 */
async function seedRun(window, { tokens = null, cost = null, known = false }) {
  const id = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status,
                       created_at, finished_at, prompt_tokens, completion_tokens,
                       total_tokens, total_cost, cost_known)
     values ($1, $2, 'api', 'g', 'https://shop.example.test/', 60, 'passed',
             $3, $3, $4, $5, $6, $7, $8)`,
    [
      id, userId, new Date(window.start.getTime() + 60e3).toISOString(),
      tokens === null ? null : Math.round(tokens * 0.9),
      tokens === null ? null : Math.round(tokens * 0.1),
      tokens, cost, known,
    ]
  );
  return id;
}

/** @param {{query: string}} window */
async function history(window, extra = '') {
  const { body } = await request(app)
    .get(`/api/runs?${window.query}${extra}`)
    .set(auth)
    .expect(200);
  return body;
}

test('the total covers the filter set, not the page it returned', async () => {
  // The question is "what did last night cost", and last night is forty runs
  // over two pages. A total that changes when you press Older is not that
  // number, and nothing on the screen would say which page it belonged to.
  const w = nextWindow();
  for (const cost of [0.25, 0.5, 0.125]) await seedRun(w, { tokens: 1000, cost, known: true });

  const firstPage = await history(w, '&limit=1');
  assert.equal(firstPage.runs.length, 1, 'one row was asked for');
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.usage.total_cost, 0.875, 'all three, not the one returned');

  const lastPage = await history(w, '&limit=1&offset=2');
  assert.deepEqual(lastPage.usage, firstPage.usage, 'paging must not move the total');
});

test('an unpriced run is kept out of the total and disclosed in the count', async () => {
  // The trap itself. Two runs can be priced and one cannot, and the honest
  // answer is not the sum of the two — it is the sum of the two, said out loud
  // to be the sum of two out of three.
  const w = nextWindow();
  await seedRun(w, { tokens: 1000, cost: 0.25, known: true });
  await seedRun(w, { tokens: 1000, cost: 0.5, known: true });
  await seedRun(w, { tokens: 1000, cost: null, known: false });

  const body = await history(w);
  assert.equal(body.usage.total_cost, 0.75);
  assert.equal(body.usage.priced_runs, 2);
  assert.equal(body.total, 3, 'the disclosure is priced_runs against total');
});

test('a set with nothing priced reports no cost at all, never zero', async () => {
  // What `CALCULATE_COST=0` looks like from History, and what an instance that
  // never reached the pricing table looks like. `coalesce(sum(...), 0)` here
  // prints "$0.00" over a month of real spending.
  const w = nextWindow();
  await seedRun(w, { tokens: 1000, cost: null, known: false });
  await seedRun(w, { tokens: 2000, cost: null, known: false });

  const body = await history(w);
  assert.equal(body.usage.total_cost, null, 'null, never 0');
  assert.equal(body.usage.priced_runs, 0);
});

test('tokens total independently of cost, so an unpriced set still says something', async () => {
  // Tokens are a measurement whatever the pricing did. This is the degradation
  // AC #6 promises, seen from the aggregate: cost goes quiet, tokens do not.
  const w = nextWindow();
  await seedRun(w, { tokens: 1000, cost: null, known: false });
  await seedRun(w, { tokens: 2000, cost: null, known: false });

  const body = await history(w);
  assert.equal(body.usage.total_tokens, 3000);
});

test('a set nothing measured reports null tokens as well as null cost', async () => {
  // Every run from before this story. An empty sum is null on both columns —
  // one rule, not two — because "0 tokens" claims a measurement that says the
  // runs used no model, and they used one.
  const w = nextWindow();
  await seedRun(w, {});
  await seedRun(w, {});

  const body = await history(w);
  assert.equal(body.total, 2, 'the runs are there; only their numbers are not');
  assert.equal(body.usage.total_tokens, null);
  assert.equal(body.usage.total_cost, null);
  assert.equal(body.usage.priced_runs, 0);
});

test('the total answers the filter it was given, not the whole history', async () => {
  // A total that ignores the filter is the wrong number under the right heading
  // — and it is the reading people take away, because the filter is what they
  // just set.
  const cheap = nextWindow();
  await seedRun(cheap, { tokens: 1000, cost: 0.25, known: true });
  const dear = nextWindow();
  await seedRun(dear, { tokens: 8000, cost: 2, known: true });

  assert.equal((await history(cheap)).usage.total_cost, 0.25);
  assert.equal((await history(dear)).usage.total_cost, 2);
  assert.equal((await history(dear)).usage.total_tokens, 8000);
});

test('a status filter narrows the total with the list it belongs to', async () => {
  // The filter people actually reach for. `status` is a different clause from
  // `since`, so it is worth one case that the aggregate carries the whole WHERE
  // and not only the parts the window happened to exercise.
  const w = nextWindow();
  await seedRun(w, { tokens: 1000, cost: 0.25, known: true });
  const failed = await seedRun(w, { tokens: 1000, cost: 0.5, known: true });
  await pool.query(`update runs set status = 'failed' where id = $1`, [failed]);

  const body = await history(w, '&status=failed');
  assert.equal(body.total, 1);
  assert.equal(body.usage.total_cost, 0.5);
});
