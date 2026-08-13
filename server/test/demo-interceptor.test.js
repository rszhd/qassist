// @ts-check
// US-036 — assertion-first spec for the run interceptor's NO-COST guarantee
// (correctness-critical). In demo mode every run is a replay: a real `runs` row
// is written and driven from a checked-in fixture over the normal relay, but
// NOTHING is spent — no run_agent.py / make_report.py process, no MAX_CONCURRENT
// slot, no LLM call. A leak here spends the operator's key/box on a stranger, on
// a public writable endpoint, so it is pinned assertion-first.
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
// The properties they defend:
//
//   N — no cost. On EVERY trigger path — ad-hoc POST /api/runs, POST
//       /api/tests/:id/run, suite run, project/module run, the scheduler tick,
//       and a retry (a re-trigger; there is no privileged retry path) — demo
//       mode spawns no Python (the canary marker never appears), claims no
//       concurrency slot and never queues (counts().active and .queued stay 0
//       even past MAX_CONCURRENT), and needs no OPENAI_API_KEY (the agent-key
//       gate is waived — a replay calls no model).
//   R — real row. Each trigger still writes a `runs` row owned by the visitor
//       that reaches a terminal status and shows up in THEIR history, so the
//       sandbox looks real.
//   F — right clip. The fixture is chosen by matching the test's goal +
//       start_url to a demo/<slug>/meta.json (exact for the two seeded fixture
//       tests: register-account → pass, discount-broken → fail); a test that
//       matches neither replays a default. [REVIEW: pin the default verdict.]
//
// NOTE FOR REVIEW: N and R are DB-independent — the no-cost property is proven
// from counts()/the canary, not from Postgres semantics — so pg-mem is enough
// here, unlike the reaper (which needs real Postgres for cascade/set-null).
// Flagging in case you still want a real-Postgres variant of the row assertions.
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
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {Set<string>} */
let TERMINAL;
/** @type {(now?: number) => Promise<any>} */
let tick;
let CANARY_FILE = '';

before(async () => {
  process.env.AUTH_MODE = 'demo';
  process.env.SESSION_SECRET = 'demo-session-secret-0123456789';
  // A boot requirement since US-039, so the real server never runs without it —
  // and the seed stores a session blob and a secret variable's value through it.
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.DEMO_SPEED = '1000'; // collapse the replay timeline so tests don't wait on it
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // so "no queue past the cap" is observable with a 2-test suite
  process.env.DEMO_IP_MAX = '1000'; // this file mints many tenants from one IP; the throttle is exercised in demo-ip-throttle.test.js
  delete process.env.AUTH_ENABLED;
  delete process.env.WORKER_API_TOKEN;
  // Deliberately NO OPENAI_API_KEY: a demo deployment needs none (property N).
  delete process.env.OPENAI_API_KEY;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-interceptor-'));
  CANARY_FILE = path.join(dir, 'python-spawned.marker');
  process.env.CANARY_FILE = CANARY_FILE;
  process.env.PYTHON_BIN = process.execPath;
  // If the interceptor ever spawns Python, the canary writes the marker.
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'canary.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'canary.js');
  process.env.ARTIFACTS_DIR = path.join(dir, 'runs');

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
  ({ counts, TERMINAL } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));
});

// --- helpers ---

/** Bootstrap a fresh tenant; return its cookie-agent and user id. */
async function newVisitor() {
  const agent = request.agent(app);
  await agent.post('/api/demo/session').expect(201);
  const { rows } = await pool.query(
    'select id from users where demo_expires_at is not null order by created_at desc limit 1'
  );
  return { agent, uid: rows[0].id };
}

/** The Python renderer/agent must never have run. */
function assertNoPython() {
  assert.equal(fs.existsSync(CANARY_FILE), false, 'no run_agent.py / make_report.py was spawned');
}

/** No slot claimed, nothing queued — the run engine is untouched. */
function assertNoSlot() {
  const { active, queued } = counts();
  assert.equal(active, 0, 'no concurrency slot claimed');
  assert.equal(queued, 0, 'nothing queued');
}

/** Poll a run to a terminal status (replay is async over the collapsed timeline). */
async function waitTerminal(runId, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const { rows } = await pool.query(
      'select status, success, user_id, has_recording from runs where id = $1',
      [runId]
    );
    if (rows.length && TERMINAL.has(rows[0].status)) return rows[0];
    if (Date.now() - t0 > ms) throw new Error(`run ${runId} not terminal in ${ms}ms (was ${rows[0]?.status})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fixture's events, straight off disk — the demo run has no other source. */
function readFixtureEvents(slug) {
  return fs
    .readFileSync(path.join(__dirname, '..', '..', 'demo', slug, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function seededTests(agent) {
  return (await agent.get('/api/tests').expect(200)).body.tests;
}

// --- N + R: every trigger path is free and still writes a real owned row ---

test('ad-hoc POST /api/runs replays for free and writes the visitor a real row', async () => {
  const { agent, uid } = await newVisitor();
  const res = await agent
    .post('/api/runs')
    .send({ goal: 'register account', start_url: 'https://try.discourse.org/' })
    .expect(200); // NOT 503: the agent-key gate is waived in demo mode (no OPENAI_API_KEY set)
  assertNoPython();
  assertNoSlot();
  const row = await waitTerminal(res.body.runId);
  assert.equal(row.user_id, uid, 'the run row is owned by the visitor');
});

test('POST /api/tests/:id/run replays for free', async () => {
  const { agent, uid } = await newVisitor();
  const tests = await seededTests(agent);
  const t = tests.find((x) => x.name === 'Register an account');
  const res = await agent.post(`/api/tests/${t.id}/run`).expect(200);
  assertNoPython();
  assertNoSlot();
  const row = await waitTerminal(res.body.runId);
  assert.equal(row.user_id, uid);
});

test('a suite of 2 with MAX_CONCURRENT=1 neither spawns, claims a slot, nor queues', async () => {
  const { agent, uid } = await newVisitor();
  const { rows } = await pool.query('select id from suites where user_id = $1', [uid]);
  const res = await agent.post(`/api/suites/${rows[0].id}/run`).expect(200);
  const runIds = res.body.runs.map((r) => r.runId);
  assert.equal(runIds.length, 2);
  assertNoPython();
  assertNoSlot(); // a real suite would show active=1, queued=1 here
  for (const id of runIds) await waitTerminal(id);
});

test('project/module run replays for free', async () => {
  const { agent } = await newVisitor();
  const res = await agent.post('/api/projects/acme-storefront/modules/checkout/run').expect(200);
  assertNoPython();
  assertNoSlot();
  for (const r of res.body.runs) if (r.runId) await waitTerminal(r.runId);
});

test('the scheduler tick replays for free and writes a schedule-triggered row', async () => {
  const { agent, uid } = await newVisitor();
  // Make the seeded (far-future) schedule due, then tick the real scheduler.
  await pool.query('update schedules set next_run_at = $1 where user_id = $2', [
    new Date(Date.now() - 1000),
    uid,
  ]);
  await tick();
  assertNoPython();
  assertNoSlot();
  const { rows } = await pool.query(
    "select id from runs where user_id = $1 and trigger = 'schedule'",
    [uid]
  );
  assert.ok(rows.length >= 1, 'the scheduler wrote at least one replay run');
  for (const r of rows) await waitTerminal(r.id);
  void agent;
});

test('a retry (re-trigger) is also free — there is no privileged retry path', async () => {
  const { agent } = await newVisitor();
  const tests = await seededTests(agent);
  const t = tests.find((x) => x.name === 'Register an account');
  const first = await agent.post(`/api/tests/${t.id}/run`).expect(200);
  const second = await agent.post(`/api/tests/${t.id}/run`).expect(200);
  assert.notEqual(first.body.runId, second.body.runId, 'each trigger is its own run row');
  assertNoPython();
  assertNoSlot();
});

// --- F: fixture selection matches the test ---

test('the fixture is chosen to match the test: register passes, discount fails', async () => {
  const { agent } = await newVisitor();
  const tests = await seededTests(agent);
  const reg = tests.find((x) => x.name === 'Register an account');
  const dis = tests.find((x) => x.name === 'Checkout discount code');

  const r1 = await agent.post(`/api/tests/${reg.id}/run`).expect(200);
  const r2 = await agent.post(`/api/tests/${dis.id}/run`).expect(200);
  const pass = await waitTerminal(r1.body.runId);
  const fail = await waitTerminal(r2.body.runId);
  assert.equal(pass.status, 'passed');
  assert.equal(pass.success, true);
  assert.equal(fail.status, 'failed');
  assert.equal(fail.success, false);
  // register-account ships a recording — the demo run surfaces it as the stage
  // feed (the frontend plays it live off this flag). discount-broken has none
  // yet (deferred capture), so it replays steps-only.
  assert.equal(pass.has_recording, true, 'the pass fixture links its recording onto the run');
  assert.equal(fail.has_recording, false, 'the fail fixture has no recording yet');
});

test('a test matching no fixture replays the default and still reaches terminal', async () => {
  const { agent } = await newVisitor();
  const tests = await seededTests(agent);
  const search = tests.find((x) => x.name === 'Product search returns results');
  const res = await agent.post(`/api/tests/${search.id}/run`).expect(200);
  assertNoPython();
  const row = await waitTerminal(res.body.runId);
  assert.ok(TERMINAL.has(row.status)); // [REVIEW: pin the default fixture's verdict]
});

// --- what a replayed run reports, beyond its verdict ---
//
// A fixture is the only account a demo run has of itself: nothing spawns, so no
// agent writes usage and no browser reports a finding. Everything a visitor
// reads off a demo run comes from `demo/<slug>/events.ndjson`, which is why the
// fields below are asserted here rather than trusted to look right.

test('a replayed run reports what it spent, so the demo shows US-046 rather than a blank', async () => {
  const { agent } = await newVisitor();
  const tests = await seededTests(agent);
  const reg = tests.find((x) => x.name === 'Register an account');
  const res = await agent.post(`/api/tests/${reg.id}/run`).expect(200);
  await waitTerminal(res.body.runId);

  const { rows } = await pool.query(
    'select prompt_tokens, completion_tokens, total_tokens, total_cost, cost_known from runs where id = $1',
    [res.body.runId]
  );
  const row = rows[0];
  assert.ok(row.total_tokens > 0, 'the fixture carries a usage summary');
  assert.equal(row.total_tokens, row.prompt_tokens + row.completion_tokens);
  // Migration 020's invariant, which the fixture has to satisfy like any run.
  assert.equal(row.cost_known, true);
  assert.ok(row.total_cost != null);
});

test('a replayed run carries its evidence: seekable steps, findings, and a fence that fired', async () => {
  const { agent } = await newVisitor();
  const tests = await seededTests(agent);
  const reg = tests.find((x) => x.name === 'Register an account');
  const dis = tests.find((x) => x.name === 'Checkout discount code');

  const pass = await agent.post(`/api/tests/${reg.id}/run`).expect(200);
  const fail = await agent.post(`/api/tests/${dis.id}/run`).expect(200);
  await waitTerminal(pass.body.runId);
  await waitTerminal(fail.body.runId);

  // Read from the live relay, which is where a demo run's activity lives — it
  // writes no report_data.json, and RUN_TTL outlives a demo tenant.
  const passSteps = (await agent.get(`/api/runs/${pass.body.runId}/steps`).expect(200)).body;
  const failSteps = (await agent.get(`/api/runs/${fail.body.runId}/steps`).expect(200)).body;

  // register-account ships a recording, so every one of its steps can be jumped
  // to in it (US-076). discount-broken ships none, and must therefore offer no
  // seek at all rather than one computed off the wall clock.
  assert.ok(passSteps.steps.length > 0);
  assert.ok(
    passSteps.steps.every((/** @type {any} */ s) => typeof s.video_seconds === 'number'),
    'the recorded fixture places every step in its recording'
  );
  assert.ok(
    failSteps.steps.every((/** @type {any} */ s) => s.video_seconds == null),
    'the unrecorded fixture offers no seek'
  );

  assert.ok(passSteps.diagnostics.length > 0, 'US-044 findings reach the demo');
  assert.ok(failSteps.diagnostics.length > 0);
  assert.ok(failSteps.diagnostics_dropped > 0, 'and the over-cap tally with them');
});

test('the fence the seeded project configures is the one the failing fixture shows firing', async () => {
  const { agent, uid } = await newVisitor();
  const { rows } = await pool.query(
    "select allowed_domains from projects where user_id = $1 and slug = 'acme-storefront'",
    [uid]
  );
  assert.deepEqual(rows[0].allowed_domains, ['shop.example', '*.shop.example']);

  const blocked = readFixtureEvents('discount-broken').filter((e) => e.type === 'blocked');
  assert.equal(blocked.length, 1, 'the fixture shows the fence firing once');
  const host = new URL(blocked[0].url).hostname;
  assert.ok(
    !rows[0].allowed_domains.some((/** @type {string} */ pattern) =>
      pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
    ),
    'and the url it refuses is one this project genuinely does not allow'
  );
});
