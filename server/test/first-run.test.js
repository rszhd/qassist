// @ts-check
// First-run experience. Since US-039 a fresh clone with no .env at all refuses
// to boot (boot.test.js pins that), so "first run" now means the documented
// minimum: the control plane and KEY_ENCRYPTION_SECRET, but no WORKER_API_TOKEN
// and no key stored yet. The UI must still load and the API must explain what
// is missing — a key in Settings — rather than failing inside the agent.
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

before(async () => {
  // Config is read at import time; no token mimics a just-written minimal .env.
  delete process.env.WORKER_API_TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-first-run-'));

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
  const pool = new Pool();
  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ app } = await import('../src/server.js'));
});

test('health reports what is not configured yet', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.auth, false);
  assert.equal(res.body.db, true);
  // No instance-wide agent_ready (US-039): readiness is per-user, answered by
  // GET /api/account/openai-key.
  assert.equal('agent_ready' in res.body, false);
});

test('starting a run explains the missing key instead of failing in the agent', async () => {
  const res = await request(app)
    .post('/api/runs')
    .send({ goal: 'g', start_url: 'https://example.com' })
    .expect(503);
  assert.match(res.body.error, /Settings/); // tells them where to fix it
});

test('no token configured means no token required (local single-user mode)', async () => {
  // Auth is off, so the request gets past checkToken and is refused only for
  // the missing key — not a 401.
  const res = await request(app).post('/api/runs').send({ goal: 'g', start_url: 'u' });
  assert.notEqual(res.status, 401);
});

test('the setup problem is reported ahead of request validation', async () => {
  // The key check is middleware, so it answers before the handler validates
  // the body — on a fresh install "you haven't added a key" is the more
  // useful of the two true answers.
  const res = await request(app).post('/api/runs').send({ goal: 'goal without a url' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Settings/);
});

test('the Settings the refusal points at is reachable before any key exists', async () => {
  // The refusal names Settings, so the surface it names must answer — the
  // operator lands there, sees {set:false}, and knows what to do.
  const res = await request(app).get('/api/account/openai-key').expect(200);
  assert.equal(res.body.set, false);
});
