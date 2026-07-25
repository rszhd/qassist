// @ts-check
// US-022 — assertion-first spec for the SELF-HOST DEFAULT: no STRIPE_* env vars.
// This is the regression the whole env-gated design exists to prevent, and it
// needs its own process because config.js is read at import time (same reason
// concurrency-off.test.js exists). The claim being pinned is absolute: with the
// Stripe vars unset, this instance is byte-for-byte what it was before US-022 —
// every run path behaves as today, and billing has no surface at all.
//
// Deliberately the SINGLE-TOKEN deployment (WORKER_API_TOKEN, no AUTH_ENABLED),
// because that is what a self-hoster actually runs, and because "self-host is
// always free" is a CLAUDE.md design principle, not a US-022 nicety.
//
// REVIEWER: the one judgement call here is the 404 (not 501/503) for
// /api/billing/*: an instance without billing does not have those endpoints,
// the same way /api/demo does not exist off the demo sandbox. Nothing about the
// paid tier should be discoverable on a free instance.
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
/** @type {any} */
let pool;
/** @type {any} */
let billing;
/** @type {(now?: number) => Promise<any>} */
let tick;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {any} */
let fx;

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-billing-off-'));
  // The self-host default, spelled out: no Stripe anything, no auth.
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.BILLING_EXEMPT_EMAILS;
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  process.env.WORKER_API_TOKEN = TOKEN;
  // BYOK-only (US-039): the operator funds runs with a stored key, exactly as
  // a self-hoster now does.
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
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
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  billing = await import('../src/billing.js');
  ({ counts } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));

  const uid = getOperatorUserId();
  await seedStoredKey(pool, /** @type {string} */ (uid));
  const project = (
    await pool.query('insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug', [
      uid, 'proj', 'proj',
    ])
  ).rows[0];
  const mod = (
    await pool.query('insert into modules (project_id, name, slug) values ($1, $2, $3) returning id, slug', [
      project.id, 'checkout', 'checkout',
    ])
  ).rows[0];
  const t = (
    await pool.query(
      `insert into tests (user_id, name, goal, start_url, max_steps, project_id, module_id)
       values ($1, 'login smoke', 'log in', 'https://example.test', 1, $2, $3) returning id`,
      [uid, project.id, mod.id]
    )
  ).rows[0];
  const suite = (
    await pool.query('insert into suites (user_id, project_id, name) values ($1, $2, $3) returning id', [
      uid, project.id, 'smoke',
    ])
  ).rows[0];
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 0)', [suite.id, t.id]);
  fx = { uid, projectSlug: project.slug, moduleId: mod.id, moduleSlug: mod.slug, testId: t.id, suiteId: suite.id };
});

async function drain(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = counts();
    if (!active && !queued) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('billing is off, and off is the default — nothing was configured to turn it off', () => {
  assert.equal(billing.billingEnabled(), false);
});

test('/api/health reports billing false, so the SPA renders no billing UI', async () => {
  const res = await request(app).get('/api/health').set(auth).expect(200);
  assert.equal(res.body.billing, false);
});

test('every /api/billing/* endpoint 404s — the paid tier is not discoverable here', async () => {
  for (const [method, url] of [
    ['get', '/api/billing/status'],
    ['post', '/api/billing/checkout'],
    ['post', '/api/billing/portal'],
    ['post', '/api/billing/webhook'],
  ]) {
    const res = await request(app)[method](url).set(auth).send({});
    assert.equal(res.status, 404, `${method.toUpperCase()} ${url}`);
  }
});

test('every run path starts a run, exactly as before US-022', async () => {
  /** @type {[string, string, Record<string, string>][]} */
  const calls = [
    ['ad-hoc POST /api/runs', '/api/runs', { goal: 'log in', start_url: 'https://example.test' }],
    ['test', `/api/tests/${fx.testId}/run`, {}],
    ['suite', `/api/suites/${fx.suiteId}/run`, {}],
    ['project', `/api/projects/${fx.projectSlug}/run`, {}],
    ['project module', `/api/projects/${fx.projectSlug}/modules/${fx.moduleSlug}/run`, {}],
    ['module', `/api/modules/${fx.moduleId}/run`, {}],
  ];
  for (const [name, url, body] of calls) {
    const res = await request(app).post(url).set(auth).send(body);
    assert.equal(res.status, 200, `${name} must be untouched on a free instance`);
    await drain();
  }
  const { rows } = await pool.query('select count(*)::int as n from runs');
  assert.equal(rows[0].n, calls.length, 'one run per trigger — none refused, none silently dropped');
});

test('schedules fire on a free instance — the gate is not in the fire path when billing is off', async () => {
  await pool.query(
    `insert into schedules (user_id, test_id, kind, hour, minute, next_run_at)
     values ($1, $2, 'daily', 3, 0, $3)`,
    [fx.uid, fx.testId, new Date(Date.now() - 1000)]
  );
  const result = await tick();
  assert.equal(result.runs, 1);
  assert.equal(result.blocked, 0, 'nothing to block: there is no entitlement on this instance');
  await drain();
});
