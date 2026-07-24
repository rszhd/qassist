// @ts-check
// Live demo replay (US-033), gate OFF — the self-host default. With DEMO_MODE
// unset there must be no demo route and no unauthenticated surface at all: the
// app is byte-for-byte the pre-US-033 app. Separate from demo.test.js because
// the gate is read from config at import time, so on and off need distinct
// processes (node:test gives each file its own).
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
  delete process.env.DEMO_MODE;
  delete process.env.DATABASE_URL;
  delete process.env.WORKER_API_TOKEN;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-off-'));
  ({ app } = await import('../src/server.js'));
});

test('health reports demo off', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.demo, false);
});

test('the demo routes do not exist', async () => {
  // Unmounted, so these are unknown /api paths — the SPA fallback bails on
  // /api, leaving Express's default 404 rather than serving index.html.
  await request(app).get('/api/demo').expect(404);
  await request(app).get('/api/demo/sample-pass/recording').expect(404);
});
