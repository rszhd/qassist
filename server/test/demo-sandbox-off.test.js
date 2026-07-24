// @ts-check
// Demo sandbox (US-036), mode OFF — AC #1: with AUTH_MODE ≠ demo none of the
// sandbox exists. No bootstrap endpoint, no auto-provisioning, no auth_mode
// 'demo'. Separate process from demo-sandbox.test.js because the mode is read
// from config at import time (node:test isolates each file).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;

before(async () => {
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_ENABLED;
  delete process.env.WORKER_API_TOKEN; // open mode
  process.env.SESSION_SECRET = 'unused-but-present-0123456789';
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-sandbox-off-'));

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ app } = await import('../src/server.js'));
});

test('auth_mode is not demo, and no signup CTA leaks into health', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.notEqual(res.body.auth_mode, 'demo');
  assert.equal(res.body.cta_url, null);
});

test('the bootstrap endpoint does not exist', async () => {
  await request(app).post('/api/demo/session').expect(404);
});

test('no tenant is ever auto-provisioned', async () => {
  await request(app).get('/api/health');
  await request(app).post('/api/demo/session');
  const { rows } = await pool.query('select count(*)::int n from users where demo_expires_at is not null');
  assert.equal(rows[0].n, 0);
});
