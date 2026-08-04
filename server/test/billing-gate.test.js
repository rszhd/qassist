// @ts-check
// US-022 — assertion-first spec for the BILLING ENTITLEMENT GATE
// (correctness-critical: "a paid-only path opens when it shouldn't, or the
// self-host free tier gets gated by mistake"). This file covers billing ON:
// which statuses may run, every path that can start a run, that reads stay
// open, and the exempt bypass. The self-host regression — STRIPE_* unset, no
// gating anywhere, /api/billing/* 404 — is billing-off.test.js (config is read
// at import time, so "off" needs its own process, exactly like
// concurrency-off.test.js). Webhook security is billing-webhook.test.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these assertions encode that I could NOT derive from
// the story, and that you're signing off before I implement. Edit the
// assertions directly; they are the spec.
//
//   D1  billingEnabled() is split into a PURE predicate + the runtime lookups:
//         billingReady({ secretKey, webhookSecret, priceId, baseUrl, hasDb, authOn })
//         billingEnabled() = billingReady({ ...config, hasDb: !!db(), authOn: authEnabled() })
//       Why: story decision 1 says "missing any one leaves the instance
//       byte-for-byte free", and that matrix is 6 cases that import-time config
//       cannot express in one process. The pure seam also pins DEMO MODE for
//       free — demoMode() implies authEnabled() is false, hence authOn:false,
//       hence billing off, so a demo deployment is never gated by construction.
//       [REVIEW: the split, and the parameter names.]
//
//   D2  The gate is per-USER and refuses the WHOLE request — it does not
//       partial-accept the way US-028's cap does. Entitlement doesn't vary per
//       run, so a suite of 5 from an unpaid account is one 402 and zero runs,
//       not five rejected members in a 200. [REVIEW: confirm — this is the one
//       place billing deliberately differs in shape from the concurrency cap.]
//
//   D3  Middleware ORDER: checkToken → requireEntitled → requireAgentKey.
//       An unpaid caller with no OpenAI key gets 402 ("pay"), not 503 ("set a
//       key") — telling them to fix a key they'd then still be refused for is
//       the worse message. Asserted below. [REVIEW: confirm the precedence.]
//
//   D4  The 402 BODY is a UI contract (RunView renders a Subscribe CTA off it,
//       alongside US-028's 429 notice):
//         { error: <string>, billing_required: true, subscription_status: <string|null> }
//       `subscription_status` is the raw Stripe status, or null when the user
//       never subscribed, so the CTA can say "resubscribe" vs "subscribe".
//       [REVIEW: field names, and the exact `error` wording — tell me the string
//       and I'll pin it here the way respondOverCap's is pinned.]
//
//   D5  past_due with a NULL current_period_end is NOT entitled (fail closed).
//       Story decision 3 grants the grace "until current_period_end"; with no
//       such date there is no period that was paid for. [REVIEW: confirm.]
//
//   D6  BILLING_EXEMPT_EMAILS is matched case-insensitively on users.email and
//       defaults to OPERATOR_EMAIL (unset here on purpose, so the DEFAULT is
//       what's under test). An exempt user needs no subscriptions row at all.
//
//   D7  The scheduler CLAIMS the due row first and then declines to fire it
//       (`tick()` returns a `blocked` count beside fired/runs/skipped). Claiming
//       first means a lapsed month does not accumulate slots that all fire at
//       once on resubscribe — the schedule resumes at its NEXT slot, nothing is
//       deleted, nothing is replayed. [REVIEW: confirm claim-then-decline over
//       decline-before-claim, and the `blocked` counter name.]
//
//   D9  (US-051) D5's boundary from the OTHER side. Until now no row ever had a
//       current_period_end, so "past_due runs until the period it paid for
//       ends" was pinned only in its fail-closed direction. The instant itself
//       is now asserted exactly: strictly before entitles, at or after refuses.
//       [REVIEW: `>` not `>=` at the instant — a period that has ended has
//       ended, and Stripe's next event is a second away either way.]
//
//   D10 (US-051) A SCHEDULED CANCELLATION DOES NOT END ENTITLEMENT. `cancel_at`
//       is stored so Settings can say when access ends, and `entitledFrom` must
//       not read it: the customer keeps what they paid for, and Stripe sends
//       customer.subscription.deleted when it takes effect. This is asserted
//       *past* the scheduled instant on purpose — cutting them off when
//       cancel_at passes is exactly how a well-meant fix would break the gate.
//       [REVIEW: confirm entitlement ignores cancel_at entirely.]
//
//   D8  "Refused means nothing happened" is asserted as: no new `runs` row for
//       that user, counts() unchanged (no slot, no queue entry), and no new
//       directory under ARTIFACTS_DIR — the run dir is the first thing both
//       startRun's agent and generateReport create, so an untouched artifacts
//       dir is the no-spawn proof.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-session-secret-0123456789';
const OPERATOR = 'operator@qassist.test';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
/** @type {any} */
let billing;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {Set<string>} */
let TERMINAL;
/** @type {(now?: number) => Promise<any>} */
let tick;
let artifactsDir = '';

/** userId → fixtures (a test, a suite, a project + module) that user owns. */
const fx = /** @type {Record<string, any>} */ ({});
let PAID = '';
let LAPSED = '';
let OPERATOR_ID = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-billing-gate-'));
  // Billing needs multi-user auth (story decision 1): billing charges USERS, so
  // a single-token or open instance must never be able to gate anything.
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.MAIL_DEV_CONSOLE = '1';
  process.env.OPERATOR_EMAIL = OPERATOR;
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_billing';
  process.env.STRIPE_PRICE_ID = 'price_test_123';
  process.env.PUBLIC_BASE_URL = 'https://qassist.test';
  // Left unset on purpose: the exempt list DEFAULTS to OPERATOR_EMAIL (D6).
  delete process.env.BILLING_EXEMPT_EMAILS;
  // US-054, and load-bearing for this whole file: an existing billing instance
  // that never asked for the activation window must not grow one. Every 200
  // below is a user whose activated_at is null, so this one deletion is what
  // makes the rest of the file the regression proof. The window ON is
  // activation-gate.test.js, in its own process.
  delete process.env.ACTIVATION_SLA_HOURS;
  delete process.env.AUTH_MODE;
  delete process.env.MAX_CONCURRENT_PER_USER;
  // BYOK-only (US-039): a subscriber funds runs with their stored key, so every
  // fixture user gets one (makeUser). The billing gate is what is under test —
  // it must answer before the key gate ever gets a say (D3 there, D4 in
  // byok-only.test.js).
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.REPORTS_ENABLED = '1';
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
  OPERATOR_ID = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, OPERATOR_ID);
  auth = await import('../src/auth.js');
  billing = await import('../src/billing.js');
  ({ counts, TERMINAL } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));

  PAID = await makeUser('paid@example.test');
  LAPSED = await makeUser('lapsed@example.test');
  for (const uid of [PAID, LAPSED, OPERATOR_ID]) fx[uid] = await seedFixtures(uid);
});

// --- harness -----------------------------------------------------------------

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  await seedStoredKey(pool, rows[0].id);
  return rows[0].id;
}

/** One of everything runnable, so every start path has a target to aim at. */
async function seedFixtures(uid) {
  const short = uid.slice(0, 8);
  const project = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug',
      [uid, `proj ${short}`, `proj-${short}`]
    )
  ).rows[0];
  const mod = (
    await pool.query(
      'insert into modules (project_id, name, slug) values ($1, $2, $3) returning id, slug',
      [project.id, 'checkout', 'checkout']
    )
  ).rows[0];
  const t = (
    await pool.query(
      `insert into tests (user_id, name, goal, start_url, max_steps, project_id, module_id)
       values ($1, $2, $3, $4, 1, $5, $6) returning id`,
      [uid, 'login smoke', 'log in', 'https://example.test', project.id, mod.id]
    )
  ).rows[0];
  const suite = (
    await pool.query(
      'insert into suites (user_id, project_id, name) values ($1, $2, $3) returning id',
      [uid, project.id, 'smoke']
    )
  ).rows[0];
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 0)', [
    suite.id,
    t.id,
  ]);
  return { projectSlug: project.slug, moduleId: mod.id, moduleSlug: mod.slug, testId: t.id, suiteId: suite.id };
}

const asUser = (uid) => ({ Cookie: `${auth.SESSION_COOKIE}=${auth.signSession(uid)}` });

/**
 * Every path that can start a run. Enumerating them IS the risk (US-036's
 * interceptor is the precedent: one forgotten path is the whole defect), so the
 * table is the spec and each entry gets its own assertion below.
 */
const RUN_PATHS = [
  ['ad-hoc POST /api/runs', () => ({ url: '/api/runs', body: { goal: 'log in', start_url: 'https://example.test' } })],
  ['POST /api/tests/:id/run', (f) => ({ url: `/api/tests/${f.testId}/run` })],
  ['POST /api/suites/:id/run', (f) => ({ url: `/api/suites/${f.suiteId}/run` })],
  ['POST /api/projects/:project/run', (f) => ({ url: `/api/projects/${f.projectSlug}/run` })],
  ['POST /api/projects/:project/modules/:module/run', (f) => ({ url: `/api/projects/${f.projectSlug}/modules/${f.moduleSlug}/run` })],
  ['POST /api/modules/:id/run', (f) => ({ url: `/api/modules/${f.moduleId}/run` })],
];

const trigger = (uid, make) => {
  const { url, body } = make(fx[uid]);
  return request(app).post(url).set(asUser(uid)).send(body || {});
};

/** Replace a user's subscription row; `status` null = no row at all. */
async function setSubscription(uid, status, { periodEnd = null, cancelAt = null } = {}) {
  await pool.query('delete from subscriptions where user_id = $1', [uid]);
  if (!status) return;
  await pool.query(
    `insert into subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [uid, `cus_${uid.slice(0, 8)}`, `sub_${uid.slice(0, 8)}`, status, periodEnd, cancelAt]
  );
}

/** Everything a refused request must NOT have changed (D8). */
async function snapshot(uid) {
  const { rows } = await pool.query('select count(*)::int as n from runs where user_id = $1', [uid]);
  return { runs: rows[0].n, engine: counts(), artifacts: fs.readdirSync(artifactsDir).length };
}

async function assertNothingHappened(uid, before, label) {
  const after = await snapshot(uid);
  assert.equal(after.runs, before.runs, `${label}: no runs row was written`);
  assert.deepEqual(after.engine, before.engine, `${label}: no slot claimed, nothing queued`);
  assert.equal(after.artifacts, before.artifacts, `${label}: no run dir — nothing was spawned`);
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

// --- the switch itself -------------------------------------------------------

test('billingEnabled ANDs every precondition — missing one leaves the instance free (D1)', () => {
  assert.equal(billing.billingEnabled(), true, 'this file configures billing fully');

  const full = {
    secretKey: 'sk_test_x',
    webhookSecret: 'whsec_x',
    priceId: 'price_x',
    baseUrl: 'https://qassist.test',
    hasDb: true,
    authOn: true,
  };
  assert.equal(billing.billingReady(full), true);
  for (const key of Object.keys(full)) {
    const missing = { ...full, [key]: typeof full[key] === 'boolean' ? false : '' };
    assert.equal(
      billing.billingReady(missing),
      false,
      `${key} missing must leave billing off — a half-configured instance charges nobody and gates nobody`
    );
  }
  // authOn:false is also the demo sandbox (AUTH_MODE=demo ⇒ authEnabled() false),
  // which is how "demo mode is never gated" holds by construction rather than
  // by a branch someone could delete.
});

test('/api/health advertises billing so the SPA knows whether to render any of it', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.billing, true);
});

// --- G: the gate reaches EVERY path that can start a run ---------------------

for (const [name, make] of RUN_PATHS) {
  test(`${name} — 402 with no subscription, and nothing happened (D2, D8)`, async () => {
    await setSubscription(LAPSED, null);
    const before = await snapshot(LAPSED);
    const res = await trigger(LAPSED, make);

    assert.equal(res.status, 402, 'payment required — not 403, so CI can tell "pay" from "bad token"');
    assert.equal(res.body.billing_required, true); // D4
    assert.equal(res.body.subscription_status, null, 'never subscribed reads as null, not a status');
    assert.ok(res.body.error && typeof res.body.error === 'string', 'the refusal says what to do');
    await assertNothingHappened(LAPSED, before, name);
  });

  test(`${name} — starts normally for an active subscriber`, async () => {
    await setSubscription(PAID, 'active');
    const before = await snapshot(PAID);
    const res = await trigger(PAID, make);

    assert.equal(res.status, 200, `${name} must be unchanged for a paying user`);
    const after = await snapshot(PAID);
    assert.ok(after.runs > before.runs, 'the trigger actually enqueued for a paying user');
  });
}

test('a suite is refused WHOLE, not partial-accepted like the concurrency cap (D2)', async () => {
  await setSubscription(LAPSED, 'canceled');
  const before = await snapshot(LAPSED);
  const res = await request(app)
    .post(`/api/suites/${fx[LAPSED].suiteId}/run`)
    .set(asUser(LAPSED))
    .send({});
  assert.equal(res.status, 402);
  assert.equal(res.body.runs, undefined, 'no partial-accept array — entitlement does not vary per member');
  await assertNothingHappened(LAPSED, before, 'suite');
});

test('402 wins over requireAgentKey — pay first, then configure a key (D3)', async () => {
  await setSubscription(LAPSED, null);
  // A malformed openai_api_key is requireAgentKey's 400 (and on an instance with
  // no server key it would be a 503 instead). Either way the entitlement gate
  // runs first, so the caller is told the thing they can act on: pay.
  const res = await request(app)
    .post('/api/runs')
    .set(asUser(LAPSED))
    .send({ goal: 'log in', start_url: 'https://example.test', openai_api_key: 'not-a-key' });
  assert.equal(res.status, 402, 'not the 400 requireAgentKey would have returned');
});

// --- S: the status table -----------------------------------------------------

const HOUR = 3600_000;

for (const [status, allowed] of [
  ['active', true],
  ['trialing', true],
  ['canceled', false],
  ['unpaid', false],
  ['incomplete', false],
]) {
  test(`status '${status}' ${allowed ? 'runs' : 'is refused'}`, async () => {
    await setSubscription(LAPSED, status);
    const res = await trigger(LAPSED, RUN_PATHS[0][1]);
    assert.equal(res.status, allowed ? 200 : 402);
    if (!allowed) assert.equal(res.body.subscription_status, status, 'the CTA can say "resubscribe"');
  });
}

test('past_due runs until the period it paid for ends, and is refused after (decision 3)', async () => {
  await setSubscription(LAPSED, 'past_due', { periodEnd: new Date(Date.now() + HOUR) });
  assert.equal(
    (await trigger(LAPSED, RUN_PATHS[0][1])).status,
    200,
    "Stripe retries a declined card for ~2 weeks — cutting a paying customer's schedules off on the first failed retry is the worse bug"
  );
  await drain();

  await setSubscription(LAPSED, 'past_due', { periodEnd: new Date(Date.now() - HOUR) });
  assert.equal((await trigger(LAPSED, RUN_PATHS[0][1])).status, 402);
});

test('past_due with no current_period_end is refused — fail closed (D5)', async () => {
  await setSubscription(LAPSED, 'past_due', { periodEnd: null });
  assert.equal((await trigger(LAPSED, RUN_PATHS[0][1])).status, 402);
});

test('the grace ends exactly at current_period_end — strictly before, not at (D9)', () => {
  const instant = Date.parse('2026-08-01T00:00:00.000Z');
  const sub = { status: 'past_due', current_period_end: new Date(instant) };
  assert.equal(billing.entitledFrom(sub, { now: instant - 1 }), true, 'the last millisecond they paid for is theirs');
  assert.equal(billing.entitledFrom(sub, { now: instant }), false, 'a period that has ended has ended');
  assert.equal(billing.entitledFrom(sub, { now: instant + 1 }), false);
  // The same instant as a Postgres string, which is what billingStateFor hands
  // it on a real server.
  assert.equal(billing.entitledFrom({ status: 'past_due', current_period_end: '2026-08-01T00:00:00.000Z' }, { now: instant - 1 }), true);
});

// --- US-051 D10: a scheduled cancellation is not a lapsed one ---------------

test('a subscription with a future cancel_at still runs — they paid for the period (D10)', async () => {
  await setSubscription(PAID, 'active', { periodEnd: new Date(Date.now() + HOUR), cancelAt: new Date(Date.now() + HOUR) });
  assert.equal((await trigger(PAID, RUN_PATHS[0][1])).status, 200);
  await drain();
});

test('a cancel_at that has PASSED still runs until Stripe says otherwise (D10)', async () => {
  // The trap: cancel_at is a Stripe *schedule*, and the event that carries out
  // the schedule is what ends entitlement. Reading the date here would cut a
  // customer off in the window before that event is delivered — and would cut
  // off anyone whose cancellation Stripe later reversed.
  await setSubscription(PAID, 'active', { cancelAt: new Date(Date.now() - HOUR) });
  assert.equal((await trigger(PAID, RUN_PATHS[0][1])).status, 200);
  await drain();

  await setSubscription(PAID, 'canceled', { cancelAt: new Date(Date.now() - HOUR) });
  assert.equal(
    (await trigger(PAID, RUN_PATHS[0][1])).status,
    402,
    'the status is what ends it, exactly as before this story'
  );
});

// --- E: the exempt bypass ----------------------------------------------------

test('BILLING_EXEMPT_EMAILS defaults to OPERATOR_EMAIL: the operator runs with no subscription (D6)', async () => {
  await setSubscription(OPERATOR_ID, null);
  const res = await trigger(OPERATOR_ID, RUN_PATHS[0][1]);
  assert.equal(res.status, 200, 'the operator must be able to smoke-test production without buying their own product');
});

test('a non-exempt user with the same empty state is still refused', async () => {
  await setSubscription(LAPSED, null);
  assert.equal((await trigger(LAPSED, RUN_PATHS[0][1])).status, 402);
});

// --- schedules: blocked at fire time, not deleted (decision 8, D7) -----------

test('a lapsed subscriber\'s schedule is claimed but does not fire, and survives', async () => {
  await setSubscription(LAPSED, 'canceled');
  const { rows } = await pool.query(
    `insert into schedules (user_id, test_id, kind, hour, minute, next_run_at)
     values ($1, $2, 'daily', 3, 0, $3) returning id`,
    [LAPSED, fx[LAPSED].testId, new Date(Date.now() - 1000)]
  );
  const scheduleId = rows[0].id;
  const before = await snapshot(LAPSED);

  const result = await tick();
  assert.equal(result.blocked, 1, 'the tick reports it declined to fire one schedule (D7)');
  assert.equal(result.runs, 0);
  await assertNothingHappened(LAPSED, before, 'scheduler fire');

  const after = await pool.query('select enabled, next_run_at from schedules where id = $1', [scheduleId]);
  assert.equal(after.rows.length, 1, 'a late invoice destroys nothing');
  assert.equal(after.rows[0].enabled, true, 'the schedule stays configured');
  assert.ok(
    new Date(after.rows[0].next_run_at).getTime() > Date.now(),
    'the slot was claimed, so resubscribing resumes at the NEXT slot rather than firing a backlog (D7)'
  );

  // Resubscribe → the very same schedule fires again, untouched.
  await setSubscription(LAPSED, 'active');
  await pool.query('update schedules set next_run_at = $1 where id = $2', [
    new Date(Date.now() - 1000),
    scheduleId,
  ]);
  const resumed = await tick();
  assert.equal(resumed.blocked, 0);
  assert.equal(resumed.runs, 1, 'schedules resume on resubscribe without being recreated');
});

// --- R: reads stay open under every blocked status (decision 7) --------------

test('a cancelled customer keeps their data: history, detail, steps, report and recording all stay open', async () => {
  // Run one test to completion while entitled, so there is real history to read.
  await setSubscription(PAID, 'active');
  const started = await request(app)
    .post(`/api/tests/${fx[PAID].testId}/run`)
    .set(asUser(PAID))
    .send({})
    .expect(200);
  const runId = started.body.runId;
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await pool.query('select status, report_status from runs where id = $1', [runId]);
    if (rows.length && TERMINAL.has(rows[0].status) && rows[0].report_status === 'ready') break;
    if (Date.now() > deadline) throw new Error('run did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }

  // Then stop paying, under every status that blocks a run.
  for (const status of ['canceled', 'unpaid', 'incomplete', null]) {
    await setSubscription(PAID, status);
    const label = status || 'no row';
    const as = asUser(PAID);
    assert.equal((await request(app).get('/api/runs').set(as)).status, 200, `${label}: history`);
    assert.equal((await request(app).get(`/api/runs/${runId}`).set(as)).status, 200, `${label}: detail`);
    assert.equal((await request(app).get(`/api/runs/${runId}/steps`).set(as)).status, 200, `${label}: steps`);
    assert.equal((await request(app).get(`/api/runs/${runId}/report.pdf`).set(as)).status, 200, `${label}: PDF`);
    assert.equal((await request(app).get(`/api/runs/${runId}/recording`).set(as)).status, 200, `${label}: recording`);
    assert.equal((await request(app).get('/api/tests').set(as)).status, 200, `${label}: saved tests`);
    assert.equal((await request(app).get('/api/account/openai-key').set(as)).status, 200, `${label}: settings`);
    // Blocking reads would make cancellation a data-loss event (decision 7).
    // Billing status above all must stay readable — it is how they resubscribe.
    assert.equal((await request(app).get('/api/billing/status').set(as)).status, 200, `${label}: billing status`);
  }
});

// --- US-054: ACTIVATION_SLA_HOURS unset changes nothing here -----------------

test('with no activation window configured, a paid account runs the instant it pays', async () => {
  await setSubscription(PAID, 'active');
  const { rows } = await pool.query('select activated_at from users where id = $1', [PAID]);
  assert.equal(
    rows[0].activated_at,
    null,
    'the column exists (010) and is null — which is precisely the state US-054 walls when it is switched on'
  );
  assert.equal(
    (await trigger(PAID, RUN_PATHS[0][1])).status,
    200,
    'an instance that already charges must not acquire a hold on its next customer because we upgraded it'
  );
  await drain();

  // The same assertion read the other way round, and the reason "off" resolves
  // to ACTIVATED rather than to "skip the check": an operator who bought a
  // bigger box deletes ACTIVATION_SLA_HOURS from .env and restarts, and this is
  // an account that was left mid-window by that restart. It must simply run —
  // turning the feature off cannot leave a backlog to activate by hand.
  await pool.query('update subscriptions set activation_requested_at = $2 where user_id = $1', [
    PAID,
    new Date(Date.now() - 1000),
  ]);
  assert.equal((await trigger(PAID, RUN_PATHS[0][1])).status, 200, 'an interrupted window releases everyone in it');
  await drain();
});

test('and /api/billing/status reports no pending activation for anybody', async () => {
  await setSubscription(PAID, 'active');
  const res = await request(app).get('/api/billing/status').set(asUser(PAID)).expect(200);
  assert.equal(res.body.activation_pending, false, 'no fourth step on the wall');
  assert.equal(res.body.activation_deadline, null, 'and no promise to keep');
});

// --- the surface the CTA reads ----------------------------------------------

test('GET /api/billing/status tells the SPA what to render', async () => {
  await setSubscription(LAPSED, 'canceled', { periodEnd: new Date(Date.now() - HOUR) });
  const res = await request(app).get('/api/billing/status').set(asUser(LAPSED)).expect(200);
  assert.equal(res.body.status, 'canceled');
  assert.equal(res.body.entitled, false);
  assert.equal(res.body.exempt, false);

  // US-051: the panel cannot say "ends 25 Aug" unless the date reaches it.
  const cancelAt = new Date(Date.now() + HOUR);
  await setSubscription(PAID, 'active', { periodEnd: cancelAt, cancelAt });
  const scheduled = await request(app).get('/api/billing/status').set(asUser(PAID)).expect(200);
  assert.equal(scheduled.body.entitled, true);
  assert.equal(
    new Date(scheduled.body.cancel_at).toISOString(),
    cancelAt.toISOString(),
    'a customer who just cancelled must not see a panel identical to one who has not'
  );

  await setSubscription(PAID, 'active', { periodEnd: cancelAt });
  const renewing = await request(app).get('/api/billing/status').set(asUser(PAID)).expect(200);
  assert.equal(renewing.body.cancel_at, null, 'and one who has not must not be told their access ends');

  const op = await request(app).get('/api/billing/status').set(asUser(OPERATOR_ID)).expect(200);
  assert.equal(op.body.status, null, 'an exempt user has no subscription to report');
  assert.equal(op.body.entitled, true);
  assert.equal(op.body.exempt, true, 'an explicit, visible bypass — not a hidden one (decision 5)');
});
