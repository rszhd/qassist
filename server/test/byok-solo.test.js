// @ts-check
// US-039 — assertion-first spec, SOLO SELF-HOST refusal: AUTH_ENABLED unset,
// one WORKER_API_TOKEN, a control plane. Two claims, and they are the ones that
// must hold on a machine with no Postgres to test against, so they live here on
// pg-mem rather than only in byok-postgres.test.js:
//
//   1. the caller has somewhere to put a key at all in this mode (the account
//      router loses its authEnabled() 404 — D7), and
//   2. with no key stored, a run is refused even though the process HAS a
//      live-looking OPENAI_API_KEY (AC #6).
//
// Its own process because config.js reads env at import time, so "auth off"
// cannot be expressed alongside the AUTH_ENABLED=1 file — the same reason
// billing-off.test.js and concurrency-off.test.js exist.
//
// Everything that needs a key to actually decrypt — storing on the operator
// row, the six start paths succeeding, the child env, the scheduler firing —
// is byok-postgres.test.js: pg-mem round-trips `bytea` through a string and
// corrupts the ciphertext, so a stored key can be written here but never read
// back. REVIEWER decisions D1–D11 are listed in byok-only.test.js and
// byok-postgres.test.js.
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
const TOKEN = 'test-token';
const bearer = { Authorization: `Bearer ${TOKEN}` };
// Present throughout, and must fund nothing (AC #6).
const SERVER_KEY = 'sk-proj-' + 'ServerFallbackMustNeverFundARun0123456789';
const KEYLESS_ERROR = 'no OpenAI key: add yours in Settings';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {() => { active: number, queued: number }} */
let counts;
let artifactsDir = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok-solo-'));
  // The self-host default, spelled out: one shared token, no magic-link auth.
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.OPENAI_API_KEY = SERVER_KEY;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
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
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ counts } = await import('../src/runs.js'));
  ({ app } = await import('../src/server.js'));
});

test('the account key surface is reachable with auth off — not 404 (D7)', async () => {
  const res = await request(app).get('/api/account/openai-key').set(bearer).expect(200);
  assert.equal(res.body.set, false, 'a fresh instance has no key yet');
  assert.equal(res.body.key, undefined, 'the value is never returned, in any mode');
});

test('with no stored key a run is refused, though OPENAI_API_KEY is set (AC #6)', async () => {
  assert.equal(process.env.OPENAI_API_KEY, SERVER_KEY, 'the fallback is configured…');
  const { rows: before } = await pool.query('select count(*)::int as n from runs');
  const engineBefore = counts();
  const artifactsBefore = fs.readdirSync(artifactsDir).length;

  const res = await request(app)
    .post('/api/runs')
    .set(bearer)
    .send({ goal: 'log in', start_url: 'https://example.test', max_steps: 1 })
    .expect(503);

  assert.equal(res.body.error, KEYLESS_ERROR, '…and funds nothing');
  assert.doesNotMatch(res.body.error, /\.env|restart|docker compose/i, 'the .env instruction is gone');

  const { rows: after } = await pool.query('select count(*)::int as n from runs');
  assert.equal(after[0].n, before[0].n, 'no runs row');
  assert.deepEqual(counts(), engineBefore, 'no slot, nothing queued');
  assert.equal(fs.readdirSync(artifactsDir).length, artifactsBefore, 'no run dir — nothing spawned');
});

test('a per-request key still works in the single-token self-host', async () => {
  const res = await request(app)
    .post('/api/runs')
    .set(bearer)
    .send({
      goal: 'log in',
      start_url: 'https://example.test',
      max_steps: 1,
      openai_api_key: 'sk-proj-' + 'Request999request999request999request999b',
    })
    .expect(200);
  assert.ok(res.body.runId, 'BYOK-per-request is untouched by this story');
});
