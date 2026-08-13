// @ts-check
// Demo sandbox (US-036), mode ON. AUTH_MODE=demo turns the deployment into a
// per-visitor sandbox: a visitor with no cookie is 401'd everywhere except the
// one bootstrap endpoint, which mints a seeded tenant and drops the session
// cookie. This file covers provision + seed + tenant isolation (pg-mem is
// enough — no cascade/set-null semantics here; the interceptor and reaper get
// real-Postgres tests). The mode-OFF no-op lives in demo-sandbox-off.test.js:
// the mode is read from config at import time, so on and off need distinct
// processes (node:test gives each file its own).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { byteaPool, registerDecode } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;

before(async () => {
  process.env.AUTH_MODE = 'demo';
  process.env.SESSION_SECRET = 'demo-session-secret-0123456789';
  // A boot requirement since US-039, so the real server never runs without it —
  // and the seed stores a session blob and a secret variable's value through it.
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  delete process.env.AUTH_ENABLED;
  delete process.env.WORKER_API_TOKEN;
  process.env.DEMO_IP_MAX = '1000'; // this file mints several tenants from one IP; the throttle is exercised in demo-ip-throttle.test.js
  process.env.DEMO_CTA_URL = 'https://signup.test';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-sandbox-'));

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  // The seed stores a session blob and a secret variable's value, both bytea.
  // pg-mem cannot round-trip a bytea parameter — see helpers/stored-key.js.
  registerDecode(mem);
  pool = byteaPool(mem);

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ app } = await import('../src/server.js'));
});

/** Bootstrap a fresh tenant via a cookie-persisting agent; returns the agent. */
async function newVisitor() {
  const agent = request.agent(app);
  const res = await agent.post('/api/demo/session').expect(201);
  assert.ok(res.body.expiresAt, 'bootstrap returns the tenant expiry');
  return agent;
}

test('health reports auth_mode demo and the signup CTA the banner links to', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.auth_mode, 'demo');
  assert.equal(res.body.cta_url, 'https://signup.test');
});

test('a visitor with no session is 401 everywhere but the bootstrap', async () => {
  await request(app).get('/api/tests').expect(401);
  await request(app).get('/api/projects').expect(401);
});

test('bootstrap seeds a full dataset owned entirely by the new tenant', async () => {
  const before = await pool.query('select count(*)::int n from users where demo_expires_at is not null');
  await newVisitor();
  const users = await pool.query(
    'select id from users where demo_expires_at is not null order by created_at desc'
  );
  assert.equal(users.rows.length, before.rows[0].n + 1, 'exactly one tenant minted');
  const uid = users.rows[0].id;

  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
  const owned = (table) =>
    count(
      `select count(*)::int n from ${table} t join projects p on p.id = t.project_id where p.user_id=$1`,
      [uid]
    );
  assert.equal(await count('select count(*)::int n from projects where user_id=$1', [uid]), 2);
  assert.equal(await owned('modules'), 1);
  assert.equal(await count('select count(*)::int n from tests where user_id=$1', [uid]), 5);
  assert.equal(await count('select count(*)::int n from suites where user_id=$1', [uid]), 1);
  assert.equal(
    await count('select count(*)::int n from suite_tests st join suites s on s.id=st.suite_id where s.user_id=$1', [uid]),
    2
  );
  assert.equal(await count('select count(*)::int n from schedules where user_id=$1', [uid]), 1);
  assert.equal(await count('select count(*)::int n from runs where user_id=$1', [uid]), 10);

  // The rows a feature shipped after US-036 needs before its panel says
  // anything. Each is here because the alternative is a visitor meeting an
  // empty drawer and concluding the feature is not in the product.
  assert.equal(await owned('browser_sessions'), 1, 'a captured session (US-043/US-063)');
  assert.equal(
    await count(
      'select count(*)::int n from test_secrets s join tests t on t.id = s.test_id where t.user_id=$1',
      [uid]
    ),
    1,
    "a secret variable's stored value (US-064)"
  );
  assert.equal(
    await count(
      'select count(*)::int n from test_memory m join tests t on t.id = m.test_id where t.user_id=$1',
      [uid]
    ),
    2,
    'two tests that have learned something (US-081)'
  );
  assert.equal(
    await count('select count(*)::int n from runs where user_id=$1 and schedule_id is not null', [uid]),
    6,
    'three firings of the suite schedule, so the health strip has slots (US-069)'
  );
  assert.equal(
    await count('select count(*)::int n from runs where user_id=$1 and total_tokens is not null', [uid]),
    10,
    'every seeded run reports what it spent (US-046)'
  );
});

test('the seeded schedule reads as healthy, not as one that missed its firing', async () => {
  const agent = await newVisitor();
  const { schedules } = (await agent.get('/api/schedules').expect(200)).body;
  assert.equal(schedules.length, 1);
  const s = schedules[0];
  // `firesIntoNothing` compares last_run_at against the slot before next_run_at,
  // so a next_run_at of "now plus a day" lands between slots and tags a tenant
  // one second old as having missed one. The seed anchors both to a real slot.
  assert.equal(s.firing_into_nothing, false);
  assert.equal(s.recent.length, 3, 'three firings for the health strip to draw');
  assert.deepEqual(
    s.recent.map((/** @type {any} */ slot) => slot.status),
    ['failed', 'failed', 'passed'],
    'newest first: the discount broke two nights ago and the schedule has caught it since'
  );
});

test('seeded tests are visible through the real API, scoped to the tenant', async () => {
  const agent = await newVisitor();
  const res = await agent.get('/api/tests').expect(200);
  const names = res.body.tests.map((/** @type {any} */ t) => t.name);
  assert.equal(res.body.tests.length, 5);
  assert.ok(names.includes('Register an account'));
  assert.ok(names.includes('Checkout discount code'));
});

test('two concurrent visitors are fully isolated', async () => {
  const a = await newVisitor();
  const b = await newVisitor();

  // A creates a test; B must never see it, and each still sees only 5 (seed) + own.
  await a
    .post('/api/tests')
    .send({ name: 'A private test', goal: 'do a thing', start_url: 'https://a.example.com' })
    .expect(201);

  const aTests = (await a.get('/api/tests').expect(200)).body.tests;
  const bTests = (await b.get('/api/tests').expect(200)).body.tests;
  assert.equal(aTests.length, 6, 'A sees its seed plus its new test');
  assert.equal(bTests.length, 5, 'B sees only its own seed');
  assert.ok(!bTests.some((/** @type {any} */ t) => t.name === 'A private test'));
});

test('a reload keeps the same tenant instead of minting another', async () => {
  const agent = request.agent(app);
  const first = await agent.post('/api/demo/session').expect(201);
  const before = (await pool.query('select count(*)::int n from users where demo_expires_at is not null')).rows[0].n;
  const second = await agent.post('/api/demo/session').expect(200);
  const after = (await pool.query('select count(*)::int n from users where demo_expires_at is not null')).rows[0].n;
  assert.equal(after, before, 'no new tenant on reload');
  assert.ok(first.body.expiresAt && second.body.expiresAt);
});
