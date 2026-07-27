// @ts-check
// US-042 — assertion-first spec, part 2: the FENCE OVER HTTP. Part 1
// (navigation-policy.test.js) pins what the policy decides; this file pins that
// every path which can start a run actually asks it, and that a refusal costs
// nothing.
//
// Enumerating the paths IS the risk, exactly as it was for US-036's demo
// interceptor and US-022's billing gate — one forgotten path is the whole
// defect. So this file drives `helpers/run-paths.js`, the same shared list the
// US-039 files use, rather than a second hand-maintained list that could drift.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions here, beyond navigation-policy.test.js's D1–D8:
//
//   D9   The check lives in `createRun` (runs.js), NOT in a route middleware.
//        createRun is the sole funnel — its own comment says so, which is what
//        US-036 leaned on — so a start path cannot acquire the fence by being
//        remembered. A middleware would have to be added to seven routes and
//        would still not cover the scheduler.
//
//   D10  createRun returns a `{ blocked, error, reason }` marker and writes
//        nothing, the same shape and the same place as US-028's `{ rejected }`.
//        Callers branch with `'blocked' in`. This is what makes AC #4's "before
//        a row is written" structural rather than a matter of statement order:
//        the refusal returns above `persistInsert`.
//
//   D11  HTTP status is 400 on the single-run routes. Not 403: the caller is
//        not unauthorized, the URL they sent is one this instance will not
//        visit, which is the same class as the existing
//        `goal and start_url are required` 400 and US-035's unresolvable-variable
//        400. The body carries `reason` alongside `error` so a CI caller can
//        branch without parsing prose.
//        [REVIEW: 400 vs 403. I went with 400 because the operator's fence is a
//        property of the request, not of the caller — the same request from an
//        admin is refused identically.]
//
//   D12  On the BATCH routes a blocked member is a per-member `{ testId, error,
//        reason }` inside the 200, NOT a whole-request refusal. It sits beside
//        US-035's per-member `{ error }` for an unresolvable variable, and the
//        reasoning is US-028's partial-accept: one test pointed at localhost
//        must not cost a suite the other nine results. This is a real judgement
//        call and the inverse is defensible.
//        [REVIEW: partial-accept vs refusing the batch.]
//
//   D13  The refusal message NAMES THE URL and says which rule fired, because
//        AC #3 is "whoever set the allowlist needs to see that it fired". A
//        fence whose refusal reads "invalid start_url" is a support ticket.
//
//   D14  The per-project allowlist reaches createRun as a plain field on the
//        run, resolved by a LEFT JOIN from `tests` to `projects` in the queries
//        that already select the test's run columns. Not a second query per
//        run, and not a correlated subquery (pg-mem cannot resolve an outer
//        alias inside one — projects.js:63 already documents that).
//        A run with no project — the ad-hoc POST /api/runs — has no allowlist
//        and gets the instance floor alone.
//
//   D15  The floor applies to the AD-HOC path too, which has no project and so
//        no allowlist. That is the path a stranger with their own key actually
//        reaches, so it is the one the story is about.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';
import { RUN_PATHS, seedRunTargets } from './helpers/run-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** The address the story is named after. */
const METADATA = 'http://169.254.169.254/latest/meta-data/';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {(now?: number) => Promise<any>} */
let tick;
/** @type {any} */
let fx;
let operatorId = '';
let artifactsDir = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-nav-fence-'));
  // The floor is ON here by being unset — that IS the default, and asserting it
  // from an unset environment is the only way to prove the default is on.
  delete process.env.QA_BLOCK_PRIVATE_NETWORKS;
  delete process.env.QA_DENIED_HOSTS;
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.MAX_CONCURRENT_PER_USER;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  process.env.WORKER_API_TOKEN = TOKEN;
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
  operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
  ({ counts } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));

  fx = await seedRunTargets(pool, operatorId);
});

// --- harness -----------------------------------------------------------------

/** Point every seeded test at `url`, so the batch paths carry it too. */
async function aimTestsAt(url) {
  await pool.query('update tests set start_url = $1 where user_id = $2', [url, operatorId]);
}

/** Everything a refused request must NOT have changed (US-039's D8, reused). */
async function snapshot() {
  const { rows } = await pool.query('select count(*)::int as n from runs');
  return { runs: rows[0].n, engine: counts(), artifacts: fs.readdirSync(artifactsDir).length };
}

async function assertNothingHappened(before_, label) {
  const after = await snapshot();
  assert.equal(after.runs, before_.runs, `${label}: no runs row was written (D10)`);
  assert.deepEqual(after.engine, before_.engine, `${label}: no slot claimed, nothing queued`);
  assert.equal(after.artifacts, before_.artifacts, `${label}: no run dir — nothing was spawned`);
}

/**
 * The blocked-member reason out of any of the five response shapes: a single
 * run's 400 body, or a batch's per-member entry.
 * @param {any} res
 */
function refusal(res) {
  if (res.body && typeof res.body.reason === 'string') return res.body;
  const runs = res.body?.runs || [];
  return runs.find((r) => r && r.reason) || null;
}

async function drain(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = counts();
    if (!active && !queued) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(() => drain());

// --- F1: every start path refuses the metadata endpoint (AC #1) ---------------

for (const [name, make] of RUN_PATHS) {
  test(`${name} — refuses an IP literal, and nothing happened`, async () => {
    await aimTestsAt(METADATA);
    const before_ = await snapshot();
    const { url, body } = make(fx);
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ ...(body || {}), start_url: METADATA });

    const blocked = refusal(res);
    assert.ok(blocked, `${name}: the run was not refused (status ${res.status})`);
    assert.equal(blocked.reason, 'blocked_ip_address');
    assert.match(blocked.error, /169\.254\.169\.254/, 'the refusal names the URL (D13)');
    await assertNothingHappened(before_, name);
  });
}

test('the ad-hoc path answers 400 with a machine-readable reason (D11)', async () => {
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'read the metadata', start_url: METADATA })
    .expect(400);
  assert.equal(res.body.reason, 'blocked_ip_address');
  assert.match(res.body.error, /169\.254\.169\.254/);
  assert.ok(!res.body.runId, 'a refused run has no id because there is no run');
});

test('a blocked member does not cost the batch its other results (D12)', async () => {
  // One test at the metadata endpoint, one ordinary, in the same project.
  await aimTestsAt('https://example.test/');
  const { rows } = await pool.query(
    `insert into tests (user_id, name, goal, start_url, max_steps, project_id)
     values ($1, 'metadata probe', 'read it', $2, 1, (select project_id from tests where id = $3))
     returning id`,
    [operatorId, METADATA, fx.testId]
  );
  const badId = rows[0].id;

  const before_ = await snapshot();
  const res = await request(app).post(`/api/projects/${fx.projectSlug}/run`).set(auth).expect(200);
  const members = res.body.runs;
  const bad = members.find((m) => m.testId === badId);
  const good = members.find((m) => m.testId === fx.testId);

  assert.equal(bad.reason, 'blocked_ip_address', 'the offending member is refused');
  assert.ok(!bad.runId, 'and started nothing');
  assert.ok(good.runId, 'the innocent member still ran (US-028 partial-accept, D12)');
  const after = await snapshot();
  assert.equal(after.runs, before_.runs + 1, 'exactly one row: the member that was allowed');

  await pool.query('delete from tests where id = $1', [badId]);
  await drain();
});

// --- F2: the addresses that are the story (AC #1) ----------------------------

for (const [label, url, reason] of /** @type {[string,string,string][]} */ ([
  ['decimal', 'http://2852039166/', 'blocked_ip_address'],
  ['hex short form', 'http://0x7f.1/', 'blocked_ip_address'],
  ['IPv6-mapped', 'http://[::ffff:169.254.169.254]/', 'blocked_ip_address'],
  ['IPv6 loopback', 'http://[::1]:8080/', 'blocked_ip_address'],
  ['the compose database', 'http://db:5432/', 'blocked_host'],
  ['this app itself', 'http://localhost:8080/', 'blocked_host'],
  ['metadata by name', 'http://metadata.google.internal/', 'blocked_host'],
  ['a file on the container', 'file:///etc/passwd', 'unsupported_scheme'],
])) {
  test(`ad-hoc run refuses ${label}`, async () => {
    const before_ = await snapshot();
    const res = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'probe', start_url: url })
      .expect(400);
    assert.equal(res.body.reason, reason, url);
    await assertNothingHappened(before_, label);
  });
}

test('an ordinary target still starts — the fence is not a wall (regression)', async () => {
  const before_ = await snapshot();
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'log in', start_url: 'https://example.test/login' })
    .expect(200);
  assert.ok(res.body.runId);
  const after = await snapshot();
  assert.equal(after.runs, before_.runs + 1);
  await drain();
});

// --- F3: the scheduler is a start path too (AC #1) ---------------------------

test('the scheduler refuses a blocked target and does not spend the slot', async () => {
  await aimTestsAt(METADATA);
  await pool.query(
    `insert into schedules (user_id, test_id, suite_id, module_id, project_id,
                            kind, interval_hours, hour, minute, weekday, tz,
                            enabled, next_run_at)
     values ($1, $2, null, null, null, 'hourly', 1, 0, 0, null, 'UTC',
             true, now() - interval '1 minute')`,
    [operatorId, fx.testId]
  );
  const before_ = await snapshot();
  await tick();
  await assertNothingHappened(before_, 'scheduler');
  await pool.query('delete from schedules where user_id = $1', [operatorId]);
});

// --- F4: the per-project allowlist (AC #3) -----------------------------------

test('a project allowlist confines its tests to itself', async () => {
  await aimTestsAt('https://example.test/');
  await pool.query(
    `update projects set allowed_domains = array['*.staging.example.com']::text[]
      where user_id = $1`,
    [operatorId]
  );

  const before_ = await snapshot();
  const res = await request(app).post(`/api/projects/${fx.projectSlug}/run`).set(auth).expect(200);
  const blocked = refusal(res);
  assert.ok(blocked, 'a test outside its project allowlist must not run');
  assert.equal(blocked.reason, 'not_in_allowed_domains');
  assert.match(blocked.error, /example\.test/, 'names the URL it refused (D13)');
  await assertNothingHappened(before_, 'project allowlist');

  // …and a target inside the allowlist runs.
  await aimTestsAt('https://app.staging.example.com/');
  const ok = await request(app).post(`/api/projects/${fx.projectSlug}/run`).set(auth).expect(200);
  assert.ok(ok.body.runs[0].runId, 'an allowed target still runs');
  await drain();

  await pool.query(`update projects set allowed_domains = '{}'::text[] where user_id = $1`, [
    operatorId,
  ]);
});

test('an allowlist cannot re-open the instance floor (AC #5, D3)', async () => {
  // The operator writes the allowlist through the API, so the API is where this
  // has to be refused — see navigation-fence-postgres.test.js for the column's
  // own half of this claim.
  const res = await request(app)
    .put(`/api/projects/${fx.projectSlug}`)
    .set(auth)
    .send({ allowed_domains: ['db', 'example.com'] })
    .expect(400);
  assert.match(res.body.error, /db/, 'says which entry it refused');

  const { rows } = await pool.query('select allowed_domains from projects where user_id = $1', [
    operatorId,
  ]);
  assert.deepEqual(rows[0].allowed_domains, [], 'and wrote none of it, not even the good entry');
});

test('the ad-hoc path has no project, so it gets the floor and no allowlist (D15)', async () => {
  await pool.query(
    `update projects set allowed_domains = array['*.staging.example.com']::text[]
      where user_id = $1`,
    [operatorId]
  );
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'log in', start_url: 'https://example.test/' })
    .expect(200);
  assert.ok(res.body.runId, 'a project allowlist must not leak onto runs that have no project');
  await drain();
  await pool.query(`update projects set allowed_domains = '{}'::text[] where user_id = $1`, [
    operatorId,
  ]);
});

// --- F5: what the agent is told (AC #2, the redirect half) -------------------

test('the run carries the resolved policy into the agent env', async () => {
  // The redirect case (AC #2) cannot be proven in-process — it needs a live
  // Chromium and a real 302, and SecurityWatchdog's on_NavigationCompleteEvent
  // is what catches it. What IS provable here, and what the redirect case
  // entirely depends on, is that the flags which arm that watchdog actually
  // reach the child. An agent started without them has no fence at all, and
  // every other assertion in this file would still be green.
  const envFile = path.join(os.tmpdir(), `qassist-nav-env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = envFile;
  try {
    await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'log in', start_url: 'https://example.test/' })
      .expect(200);
    await drain();
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.QA_BLOCK_PRIVATE_NETWORKS, '1', 'the floor is armed in the browser too');
    assert.match(env.QA_DENIED_HOSTS, /\bdb\b/, 'the compose service names travel with it');
    assert.match(env.QA_DENIED_HOSTS, /localhost/);
    assert.equal(env.QA_ALLOWED_DOMAINS, '[]', 'no project, no allowlist — JSON, not prose');
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
  }
});
