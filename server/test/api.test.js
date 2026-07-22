// @ts-check
// API tests: drive the real Express app in-process (supertest), with the
// Python agent/report scripts replaced by Node stubs speaking the same
// NDJSON/argv protocol. Covers auth, validation, and the full run lifecycle.
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

/** @type {import('express').Express} */
let app;
let artifactsDir;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-test-'));
  // Config is read at import time, so env must be set before importing the app.
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.PYTHON_BIN = process.execPath; // stubs are .js, run them with node
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
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

test('health is open and reports capacity', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.max_concurrent, 'number');
});

test('rejects missing/wrong bearer token', async () => {
  await request(app).post('/api/runs').send({ goal: 'g', start_url: 'u' }).expect(401);
  await request(app)
    .post('/api/runs')
    .set({ Authorization: 'Bearer wrong' })
    .send({ goal: 'g', start_url: 'u' })
    .expect(401);
});

test('rejects a run without goal or start_url', async () => {
  const res = await request(app).post('/api/runs').set(auth).send({ goal: 'only a goal' }).expect(400);
  assert.match(res.body.error, /required/);
});

test('unknown run id is 404', async () => {
  await request(app).get('/api/runs/does-not-exist').set(auth).expect(404);
});

test('full lifecycle: run passes and serves a PDF report', async () => {
  const created = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'stub goal', start_url: 'https://example.com' })
    .expect(200);
  const { runId } = created.body;
  assert.ok(runId);

  const run = await pollUntil(async () => {
    const res = await request(app).get(`/api/runs/${runId}`).set(auth).expect(200);
    return res.body.status === 'passed' ? res.body : null;
  });
  assert.equal(run.result.success, true);

  const pdf = await pollUntil(async () => {
    const res = await request(app).get(`/api/runs/${runId}/report.pdf`).set(auth);
    if (res.status === 202) return null; // still generating
    assert.equal(res.status, 200);
    return res;
  });
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(pdf.body.toString().startsWith('%PDF'));
  // Artifacts landed on disk under runs/<id>/, per the design rules.
  assert.ok(fs.existsSync(path.join(artifactsDir, runId, 'report_data.json')));
});
