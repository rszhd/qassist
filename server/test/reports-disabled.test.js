// @ts-check
// REPORTS_ENABLED off — the default while the PDF report is being reworked.
//
// The switch has to do two opposite things at once, and both are asserted here:
// nothing may offer or produce a PDF, and everything read out of
// `report_data.json` must carry on exactly as before. That file is not the
// report: US-026's step list and US-044's diagnostics are read from it, so a
// gate placed one line too early would empty the run page as a side effect of
// turning off a renderer.
//
// The report pipeline itself stays covered — every suite that asserts on the
// PDF sets REPORTS_ENABLED=1 (api.test.js, the control-plane harness).
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
let operatorId = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-noreport-test-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  // Pointed at the stub renderer deliberately: this suite proves the renderer
  // is never spawned, and it can only prove that against one that would have
  // worked. A missing REPORT_SCRIPT would pass for the wrong reason.
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  delete process.env.REPORTS_ENABLED;
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
  operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
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

/** Run the stub agent to completion and return the run id. */
async function finishedRun() {
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'buy a thing', start_url: 'https://shop.example.test/' })
    .expect(200);
  const runId = res.body.runId;
  // `finished_at`, not `status`: the verdict is persisted when the agent's
  // `done` lands, and the run is only over one write later, on the child's
  // exit. Waiting on the status alone reads a half-written row.
  await pollUntil(async () => {
    const r = await pool.query('select finished_at from runs where id = $1', [runId]);
    return r.rows[0]?.finished_at != null;
  });
  return runId;
}

test('health tells the SPA there are no reports', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.reports, false);
});

test('a finished run renders no PDF and says none is coming', async () => {
  const runId = await finishedRun();

  assert.equal(
    fs.existsSync(path.join(artifactsDir, runId, 'report.pdf')),
    false,
    'the renderer was never spawned'
  );

  // 'none', never 'generating': a run left in that state is one the mail
  // waits behind forever, and it would read as a render still in flight.
  const row = await pool.query('select report_status from runs where id = $1', [runId]);
  assert.equal(row.rows[0].report_status, 'none');

  const detail = (await request(app).get(`/api/runs/${runId}`).set(auth).expect(200)).body;
  assert.equal(detail.report_status, 'none');
});

test('the report endpoint 404s on a perfectly good run, and says why', async () => {
  const runId = await finishedRun();
  const res = await request(app).get(`/api/runs/${runId}/report.pdf`).set(auth).expect(404);
  // Not "run not finished?" — this run finished, and sending someone to look
  // at the run is sending them to look at the wrong thing.
  assert.match(res.body.error, /disabled/);
});

test('the steps and the diagnostics are untouched by the switch', async () => {
  const runId = await finishedRun();

  // The data file is what both read, so it is written whether or not a PDF is.
  const dataPath = path.join(artifactsDir, runId, 'report_data.json');
  assert.ok(fs.existsSync(dataPath), 'report_data.json is not the report');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  assert.ok(data.steps.length > 0);
  assert.deepEqual(data.diagnostics, []);

  const res = (await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200)).body;
  assert.equal(res.steps.length, data.steps.length);
});

test('a run still finishes and reaches its verdict', async () => {
  // The renderer used to be on the path from "agent exited" to "run is done".
  // Skipping it must not skip the end of the run with it.
  const runId = await finishedRun();
  const body = (await request(app).get(`/api/runs/${runId}`).set(auth).expect(200)).body;
  assert.equal(body.status, 'passed');
  assert.equal(body.success, true);
  assert.ok(body.finished_at);
});
