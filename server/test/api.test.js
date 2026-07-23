// @ts-check
// API tests: drive the real Express app in-process (supertest), with the
// Python agent/report scripts replaced by Node stubs speaking the same
// NDJSON/argv protocol. Covers auth, validation, and the full run lifecycle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'; // gates run creation
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
  // This file sets no RESEND_API_KEY/MAIL_FROM, so `mail` is the off branch
  // the prefs dialog reads to say the instance cannot send. The on branch is
  // in notify.test.js, which has its own process and its own env.
  assert.equal(res.body.mail, false);
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

test('saved tests/suites answer 503 without DATABASE_URL (legacy mode)', async () => {
  const res = await request(app).get('/api/tests').set(auth).expect(503);
  assert.match(res.body.error, /DATABASE_URL/);
  await request(app).post('/api/suites').set(auth).send({ name: 'x' }).expect(503);
  const health = await request(app).get('/api/health').expect(200);
  assert.equal(health.body.db, false);
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
  const dataPath = path.join(artifactsDir, runId, 'report_data.json');
  assert.ok(fs.existsSync(dataPath));

  // US-006: the recording is served, and the report knows about it. No
  // PUBLIC_BASE_URL here, so the PDF gets has_recording without a link.
  assert.equal(run.hasRecording, true);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  assert.equal(data.has_recording, true);
  assert.equal(data.recording_url, null);

  const video = await request(app).get(`/api/runs/${runId}/recording`).set(auth).expect(200);
  assert.equal(video.headers['content-type'], 'video/mp4');
  assert.match(video.body.toString(), /fake mp4/);
  assert.equal(video.headers['accept-ranges'], 'bytes'); // <video> can seek

  // A <video> element can't set headers, so the token may ride in the query.
  await request(app).get(`/api/runs/${runId}/recording?token=${TOKEN}`).expect(200);
  await request(app).get(`/api/runs/${runId}/recording?token=nope`).expect(401);

  // US-026: the run is still in the relay, so the steps come from the live
  // buffer — in the same shape the report file holds them, which is the point
  // of the shared shaper.
  const live = await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200);
  assert.equal(live.body.steps[0].next_goal, 'open page');
  assert.deepEqual(live.body.steps, data.steps);
});

test('steps of a run that has left the relay are read from report_data.json', async () => {
  // RUN_TTL keeps test runs in memory for an hour, so the disk branch is
  // reached the way a restarted server reaches it: a run dir with no run.
  const runId = randomUUID();
  const steps = [{ step: 1, elapsed: 0.4, next_goal: 'open page', evaluation: null, url: 'https://example.com', screenshot_file: 'step_01.png' }];
  fs.mkdirSync(path.join(artifactsDir, runId), { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, runId, 'report_data.json'),
    JSON.stringify({ runId, steps })
  );

  const res = await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200);
  assert.deepEqual(res.body.steps, steps);

  // Pruned: the artifacts are the source of truth, so the list goes with them.
  fs.rmSync(path.join(artifactsDir, runId), { recursive: true, force: true });
  await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(404);
});

test('steps endpoint requires auth and 404s without artifacts', async () => {
  await request(app).get(`/api/runs/${randomUUID()}/steps`).expect(401);
  await request(app).get(`/api/runs/${randomUUID()}/steps`).set(auth).expect(404);
  // Not a uuid => never touches the filesystem.
  await request(app).get('/api/runs/..%2F..%2Fetc/steps').set(auth).expect(404);
});

test('recording endpoint requires auth and 404s when there is none', async () => {
  await request(app).get(`/api/runs/${randomUUID()}/recording`).expect(401);
  await request(app).get(`/api/runs/${randomUUID()}/recording`).set(auth).expect(404);
  // Not a uuid => never touches the filesystem.
  await request(app).get('/api/runs/..%2F..%2Fetc/recording').set(auth).expect(404);
  // The query token is scoped to the recording route only.
  await request(app).get(`/api/runs/${randomUUID()}?token=${TOKEN}`).expect(401);
});
