// @ts-check
// Verdict path (US-034): feed a recorded NDJSON transcript through the real run
// engine — no browser, no LLM — and assert the product's actual pass/fail
// decision. The transcripts in fixtures/ are the recorded runs; replay_agent.js
// pipes one back verbatim, exercising the NDJSON parse, the done→status mapping
// in runs.js, and the report-data assembly the report is rendered from.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const fixture = (name) => path.join(__dirname, 'fixtures', name);

/** @type {import('express').Express} */
let app;
let artifactsDir;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-verdict-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'replay_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  ({ app } = await import('../src/server.js'));
});

const TERMINAL = new Set(['passed', 'failed', 'completed', 'error']);

async function replay(transcript) {
  // The child inherits process.env, so the transcript is chosen per run here.
  // Runs are awaited to terminal one at a time, so this never races.
  process.env.QA_REPLAY_TRANSCRIPT = fixture(transcript);
  const created = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'recorded goal', start_url: 'https://example.com' })
    .expect(200);
  const { runId } = created.body;

  const deadline = Date.now() + 3000;
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`).set(auth).expect(200);
    if (TERMINAL.has(res.body.status)) return { runId, run: res.body };
    if (Date.now() > deadline) throw new Error(`replay: ${transcript} never reached terminal`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function reportData(runId) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const p = path.join(artifactsDir, runId, 'report_data.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() > deadline) throw new Error('report_data.json never written');
  }
}

test('a success transcript is judged passed and its report carries the verdict', async () => {
  const { runId, run } = await replay('pass.ndjson');
  assert.equal(run.status, 'passed');
  assert.equal(run.result.success, true);

  const data = reportData(runId);
  assert.equal(data.status, 'passed');
  assert.equal(data.success, true);
  assert.equal(data.final_result, 'Goal succeeded: account created and confirmation shown.');
  assert.equal(data.steps.length, 2);
  assert.equal(data.steps[1].evaluation, 'Successfully loaded the signup form');
  assert.deepEqual(data.errors, []);
  assert.equal(data.has_recording, true);
});

test('a failure transcript is judged failed and keeps the error list', async () => {
  const { runId, run } = await replay('fail.ndjson');
  assert.equal(run.status, 'failed');
  assert.equal(run.result.success, false);

  const data = reportData(runId);
  assert.equal(data.status, 'failed');
  assert.equal(data.success, false);
  assert.equal(data.final_result, 'Goal failed: could not log in with the supplied credentials.');
  assert.deepEqual(data.errors, ['invalid credentials']);
});

test('a null-success transcript is completed, not passed or failed', async () => {
  const { runId, run } = await replay('inconclusive.ndjson');
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, null);

  const data = reportData(runId);
  assert.equal(data.status, 'completed');
  assert.equal(data.success, null);
  assert.equal(data.steps.length, 1);
});

test('an error event ends the run in error before any done verdict', async () => {
  const { runId, run } = await replay('error.ndjson');
  assert.equal(run.status, 'error');

  const data = reportData(runId);
  assert.equal(data.status, 'error');
  // The error message becomes the report's final line, since there is no verdict.
  assert.match(data.final_result, /browser crashed/);
  assert.deepEqual(data.errors, ['RuntimeError: browser crashed before the goal could be judged']);
});
