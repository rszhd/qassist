// @ts-check
// First-run experience: a fresh clone has no .env at all, so the server boots
// with neither an API token nor an OpenAI key. The UI must still load and the
// API must explain what's missing rather than failing inside the agent.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('express').Express} */
let app;

before(async () => {
  // Config is read at import time; unset both to mimic a missing .env.
  delete process.env.WORKER_API_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DATABASE_URL;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-first-run-'));
  ({ app } = await import('../src/server.js'));
});

test('health reports what is not configured yet', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agent_ready, false);
  assert.equal(res.body.auth, false);
  assert.equal(res.body.db, false);
});

test('starting a run explains the missing key instead of failing in the agent', async () => {
  const res = await request(app)
    .post('/api/runs')
    .send({ goal: 'g', start_url: 'https://example.com' })
    .expect(503);
  assert.match(res.body.error, /OPENAI_API_KEY/);
  assert.match(res.body.error, /\.env/); // tells them how to fix it
});

test('no token configured means no token required (local single-user mode)', async () => {
  // Auth is off, so the request gets past checkToken and is refused only for
  // the missing key — not a 401.
  const res = await request(app).post('/api/runs').send({ goal: 'g', start_url: 'u' });
  assert.notEqual(res.status, 401);
});

test('the setup problem is reported ahead of request validation', async () => {
  // The key check is middleware, so it answers before the handler validates
  // the body — on a fresh install "you haven't configured a key" is the more
  // useful of the two true answers.
  const res = await request(app).post('/api/runs').send({ goal: 'goal without a url' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /OPENAI_API_KEY/);
});
