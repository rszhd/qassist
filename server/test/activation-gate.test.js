// @ts-check
// US-054 — assertion-first spec for the ACTIVATION WINDOW.
//
// The gate this pins is not "have you paid" (that is billing-gate.test.js) but
// "has this box been given room for you yet". A paid account waits in a stated
// window until the operator has resized the server, and every path that starts
// a run must refuse it — with a 503 that says come back, not a 402 that says
// pay, because they have paid.
//
// This file covers activation ON (`ACTIVATION_SLA_HOURS=24`, billing on).
// The unset path — an existing billing instance that never asked for this —
// is pinned in billing-gate.test.js, whose whole process runs with
// ACTIVATION_SLA_HOURS unset; the STRIPE_*-unset self-host is billing-off.js.
// Config is read at import time, so "off" cannot share a process with "on".
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these assertions encode that I could NOT derive from
// the story, and that you are signing off before I implement. Edit the
// assertions directly; they are the spec.
//
//   A1  NEW MODULE `server/src/activation.js`, not more of billing.js (386 lines
//       already, target ≤~300). It owns the pure state function, the two DB
//       reads, the operator/customer mails and the two functions the script is
//       a CLI over. billing.js keeps Stripe; activation.js keeps the operator's
//       half. The pure seam is:
//
//         activationStateFrom({ activated_at, activation_requested_at },
//                             { slaHours, now })
//           → { on, activated, pending, deadline: Date|null, overdue }
//
//       [REVIEW: the module split and the field names — `pending` is what the
//       gate, the 4th step and the scheduler counter all read.]
//
//   A2  OFF MEANS ACTIVATED, not "off means skip the check". With slaHours 0 the
//       pure function returns `activated: true` for everyone, so the gate and
//       the scheduler need no `if (activationEnabled())` at their call sites —
//       the same shape as isEntitled() short-circuiting to true when billing is
//       off. [REVIEW: confirm; the alternative is a branch per call site, which
//       is the failure mode "one of the seven start paths misses it".]
//
//   A3  THE GATE FOLDS INTO `requireEntitled` — one billingStateFor read, two
//       verdicts, entitlement answered first. NOT a second middleware beside it.
//       The story's own second failure mode is "one of the seven start paths
//       misses it"; making it structurally impossible for a route to have the
//       billing gate and miss the activation gate is worth more than a name that
//       reads truer. The scheduler gets the matching pair off one read too.
//       [REVIEW: confirm the fold. If you'd rather have the name say it, the
//       rename is `requireRunnable` across 6 route files and I'll do it — say
//       which and I'll pin the name here.]
//
//   A4  THE 503 BODY, a UI + CI contract:
//         { error: <string>, activation_pending: true,
//           activation_deadline: <iso string|null> }
//       plus a `Retry-After` header in SECONDS: whole seconds to the deadline,
//       floored at 60 (a runner that retries at the exact deadline must not
//       hammer), and the full SLA when there is no deadline to count to.
//       [REVIEW: field names, the 60s floor, and — as with the 402 — tell me the
//       exact `error` wording and I'll pin the string.]
//
//   A5  EXEMPT IMPLIES ACTIVATED. BILLING_EXEMPT_EMAILS defaults to
//       OPERATOR_EMAIL, and an operator who has walled themselves out of their
//       own box cannot smoke-test the thing they are being asked to activate.
//       Asserted below with no activated_at and no subscription at all.
//       [REVIEW: confirm — this is a bypass, and bypasses should be visible.]
//
//   A6  `users.activated_at` IS WRITTEN BY EXACTLY ONE STATEMENT in the whole
//       codebase — activation.js's `activateByEmail`. No webhook path touches
//       it, which is what makes "sticky" a property of the code rather than a
//       promise. Asserted by driving cancel → resubscribe → updated through the
//       real webhook and reading the column back.
//
//   A7  `subscriptions.activation_requested_at` IS STAMPED BY ITS OWN STATEMENT,
//       after writeSubscription and only when the status just applied is in
//       ENTITLED ('active'/'trialing'):
//         update subscriptions set activation_requested_at = $2
//          where user_id = $1 and activation_requested_at is null
//       rowCount === 1 is therefore *the* signal "this is the first entitling
//       event", and it is what triggers the operator mail. Folding it into
//       writeSubscription's `coalesce` would not work: checkout.session.completed
//       and customer.subscription.created routinely share a `created` second, so
//       a `returning activation_requested_at = $at` test would fire twice.
//       [REVIEW: ENTITLED only — a `past_due` or `incomplete` event does not
//       start the clock. A subscription cannot be past_due before it was active,
//       so this costs nothing and keeps "the entitling event" literal.]
//
//   A8  THE STAMP IS UNCONDITIONAL; THE MAIL IS NOT. The webhook writes
//       activation_requested_at whether or not ACTIVATION_SLA_HOURS is set — it
//       is a write, not the "no column read" the story asks of the unset path,
//       and it means turning the feature on later finds a correct clock instead
//       of a null. The operator mail is sent only when the window is on.
//       [REVIEW: this is the one place I read the story's "no column read"
//       loosely. The gate reads nothing when off; the webhook still records.]
//
//   A9  THE MIGRATION BACKFILLS. `010_account_activation.sql` sets
//       `activated_at = now()` for every user who already has a subscriptions
//       row. Without it, the day qassist.run sets ACTIVATION_SLA_HOURS=24 every
//       existing paying customer is walled at once — which is precisely the
//       story's third failure mode arriving by deployment instead of by webhook.
//       No-op on a self-host: the table is empty. Asserted below against a
//       second pool whose 010 is rewound and re-applied over seeded rows, so
//       what runs in the test is the migration file itself.
//       [REVIEW: any subscriptions row, or only an entitling one? I chose any —
//       someone who paid and lapsed has already been served by this box.]
//
//  A10  SCHEDULER: claim → entitled? → ACTIVATED? → key. tick() gains a
//       `pending` counter beside `blocked`/`keyless`, and the slot is consumed
//       exactly as a lapsed owner's is, for the same reason (no backlog fires at
//       once on activation). [REVIEW: the counter name `pending`.]
//
//  A11  THE SCRIPT IS A CLI OVER TWO EXPORTED FUNCTIONS, so what is under test
//       is what the operator runs:
//         pendingAccounts() → [{ user_id, email, status, requested_at, deadline,
//                                overdue }] oldest wait first
//         activateByEmail(email) → { ok, reason?, already, user }
//       Matching is `lower(email) = lower($1)` — whole address, no LIKE, no
//       prefix, no trailing-space tolerance beyond a trim. `already` is true for
//       a second run and sends no second mail (an operator will run it twice).
//       [REVIEW: confirm exact-match, and that activating a non-subscriber is
//       ALLOWED (harmless — the 402 still refuses them) rather than an error.
//       An entitlement precondition here would deadlock a webhook race.]
//
//  A12  `/api/billing/status` gains `activation_pending` and
//       `activation_deadline`; App's wall becomes
//       `!billingStatus.entitled || billingStatus.activation_pending`.
//       Flat fields, not a nested object, so an old frontend reads `undefined`
//       (falsy) and behaves exactly as it does today. [REVIEW: field names —
//       they are the same two the 503 body uses, deliberately.]
//
//  A13  READS STAY OPEN, asserted the same way billing-gate.test.js asserts it,
//       because "pending" is a state a customer sits in for a day and finding
//       their history gone would be worse than the wait.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
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
const WEBHOOK_SECRET = 'whsec_test_activation';
const SLA_HOURS = 24;
const HOUR = 3600_000;

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
/** @type {any} */
let activation;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {Set<string>} */
let TERMINAL;
/** @type {(now?: number) => Promise<any>} */
let tick;
let artifactsDir = '';

/** Every message the app tried to send, in order (a real POST, not a stub). */
/** @type {{ to: string[], subject: string, text: string, html?: string }[]} */
const mails = [];
/** @type {http.Server} */
let mailServer;

/** userId → fixtures (a test, a suite, a project + module) that user owns. */
const fx = /** @type {Record<string, any>} */ ({});
let WAITING = '';
let RUNNING = '';
let OPERATOR_ID = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-activation-'));

  mailServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mails.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${mails.length}` }));
    });
  });
  await new Promise((r) => mailServer.listen(0, '127.0.0.1', () => r(undefined)));

  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.OPERATOR_EMAIL = OPERATOR;
  // A real transport pointed at the local server: the two mails this story
  // promises are asserted as the requests that would have gone to Resend, not
  // as a console line. MAIL_DEV_CONSOLE would short-circuit before the fetch.
  delete process.env.MAIL_DEV_CONSOLE;
  process.env.RESEND_API_KEY = 're_test_activation';
  process.env.MAIL_FROM = 'QAssist <no-reply@qassist.test>';
  process.env.RESEND_API_URL = `http://127.0.0.1:${/** @type {any} */ (mailServer.address()).port}/emails`;
  process.env.STRIPE_SECRET_KEY = 'sk_test_activation';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_ID = 'price_test_123';
  process.env.PUBLIC_BASE_URL = 'https://qassist.test';
  // THE switch under test. Unset is billing-gate.test.js's process.
  process.env.ACTIVATION_SLA_HOURS = String(SLA_HOURS);
  delete process.env.BILLING_EXEMPT_EMAILS; // defaults to OPERATOR_EMAIL (A5)
  delete process.env.AUTH_MODE;
  delete process.env.MAX_CONCURRENT_PER_USER;
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
  OPERATOR_ID = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, OPERATOR_ID);
  auth = await import('../src/auth.js');
  activation = await import('../src/activation.js');
  ({ counts, TERMINAL } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));

  WAITING = await makeUser('waiting@example.test');
  RUNNING = await makeUser('running@example.test');
  for (const uid of [WAITING, RUNNING, OPERATOR_ID]) fx[uid] = await seedFixtures(uid);
});

after(() => mailServer?.close());

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

/** The six HTTP paths that can start a run. The scheduler is the seventh. */
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
async function setSubscription(uid, status, { periodEnd = null, requestedAt = null } = {}) {
  await pool.query('delete from subscriptions where user_id = $1', [uid]);
  if (!status) return;
  await pool.query(
    `insert into subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end,
        activation_requested_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [uid, `cus_${uid.slice(0, 8)}`, `sub_${uid.slice(0, 8)}`, status, periodEnd, requestedAt]
  );
}

/** @param {string} uid @param {Date|null} at */
const setActivated = (uid, at) =>
  pool.query('update users set activated_at = $2 where id = $1', [uid, at]);

/** A paid account that has not been given room yet — the whole subject. */
async function makePending(uid, { requestedAt = new Date(Date.now() - HOUR) } = {}) {
  await setSubscription(uid, 'active', { periodEnd: new Date(Date.now() + 30 * 24 * HOUR), requestedAt });
  await setActivated(uid, null);
}

/** Everything a refused request must NOT have changed. */
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

const unix = () => Math.floor(Date.now() / 1000);

/** Stripe's Stripe-Signature header for exact bytes. */
function sign(raw, { t = unix() } = {}) {
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function deliver(event) {
  const raw = JSON.stringify(event);
  return request(app)
    .post('/api/billing/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', sign(raw))
    .send(raw);
}

const checkoutEvent = (uid, { created = unix(), id = `evt_${randomUUID()}` } = {}) => ({
  id,
  type: 'checkout.session.completed',
  created,
  data: {
    object: {
      client_reference_id: uid,
      customer: `cus_${uid.slice(0, 8)}`,
      subscription: `sub_${uid.slice(0, 8)}`,
      payment_status: 'paid',
    },
  },
});

const subscriptionEvent = (uid, type, { created = unix(), status = 'active', id = `evt_${randomUUID()}` } = {}) => ({
  id,
  type,
  created,
  data: {
    object: {
      id: `sub_${uid.slice(0, 8)}`,
      customer: `cus_${uid.slice(0, 8)}`,
      status,
      cancel_at: null,
      items: { data: [{ current_period_end: unix() + 30 * 24 * 3600 }] },
    },
  },
});

const requestedAtOf = async (uid) =>
  (await pool.query('select activation_requested_at from subscriptions where user_id = $1', [uid]))
    .rows[0]?.activation_requested_at ?? null;

const activatedAtOf = async (uid) =>
  (await pool.query('select activated_at from users where id = $1', [uid])).rows[0]?.activated_at ?? null;

beforeEach(async () => {
  await drain();
  mails.length = 0;
});

// --- P: the pure state function ----------------------------------------------

test('activationStateFrom — the whole decision, off the clock (A1)', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const requested = new Date(now - 2 * HOUR);
  const state = (row, slaHours = SLA_HOURS) =>
    activation.activationStateFrom(row, { slaHours, now });

  const waiting = state({ activated_at: null, activation_requested_at: requested });
  assert.equal(waiting.on, true);
  assert.equal(waiting.activated, false);
  assert.equal(waiting.pending, true);
  assert.equal(
    waiting.deadline.toISOString(),
    new Date(requested.getTime() + SLA_HOURS * HOUR).toISOString(),
    'the deadline is requested_at + the SLA and nothing else — never now() + the SLA, which would slide'
  );
  assert.equal(waiting.overdue, false);

  const done = state({ activated_at: new Date(now - HOUR), activation_requested_at: requested });
  assert.equal(done.activated, true);
  assert.equal(done.pending, false, 'an activated account is never pending again, whatever the clock says');

  const late = state({ activated_at: null, activation_requested_at: new Date(now - 30 * HOUR) });
  assert.equal(late.pending, true, 'an overdue account is still walled — nothing auto-activates');
  assert.equal(late.overdue, true, 'and it is visible as overdue, which is the whole alerting story');

  // No clock at all: entitled but never stamped (a row written before this
  // story). Walled, with nothing to promise — "we'll email you", no date.
  const undated = state({ activated_at: null, activation_requested_at: null });
  assert.equal(undated.pending, true);
  assert.equal(undated.deadline, null);
  assert.equal(undated.overdue, false, 'a deadline that does not exist has not passed');
});

test('slaHours 0 or absent means everyone is activated, not "skip the check" (A2)', () => {
  const now = Date.now();
  for (const slaHours of [0, null, undefined, NaN]) {
    const off = activation.activationStateFrom(
      { activated_at: null, activation_requested_at: new Date(now - 100 * HOUR) },
      { slaHours, now }
    );
    assert.equal(off.on, false, `slaHours=${slaHours}: the window is off`);
    assert.equal(
      off.activated,
      true,
      `slaHours=${slaHours}: off must read as ACTIVATED so no call site needs an if — the branch is the bug`
    );
    assert.equal(off.pending, false);
    assert.equal(off.deadline, null, 'no window, no deadline to show anybody');
  }
});

// --- G: the gate reaches every path that can start a run ---------------------

for (const [name, make] of RUN_PATHS) {
  test(`${name} — 503 + Retry-After + activation_pending for a paid, unactivated account (A4)`, async () => {
    await makePending(WAITING);
    const before = await snapshot(WAITING);
    const res = await trigger(WAITING, make);

    assert.equal(
      res.status,
      503,
      'not 402: they have paid, nothing is wrong with the request, and the instruction is come back later'
    );
    assert.equal(res.body.activation_pending, true, 'the flag is what tells this 503 from the keyless one');
    assert.equal(res.body.billing_required, undefined, 'never the paywall — asking them to pay twice is the refund');
    assert.ok(res.body.error && typeof res.body.error === 'string');

    const retryAfter = Number(res.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter), 'Retry-After is whole seconds — a CI runner parses it');
    assert.ok(retryAfter >= 60, 'floored at 60s so a runner retrying at the deadline does not hammer');
    assert.ok(retryAfter <= SLA_HOURS * 3600, 'and never longer than the window itself');

    assert.equal(
      new Date(res.body.activation_deadline).getTime(),
      new Date(await requestedAtOf(WAITING)).getTime() + SLA_HOURS * HOUR,
      'the body carries the same deadline the wall shows'
    );
    await assertNothingHappened(WAITING, before, name);
  });

  test(`${name} — starts normally once the operator has activated the account`, async () => {
    await makePending(RUNNING);
    await setActivated(RUNNING, new Date());
    const before = await snapshot(RUNNING);
    const res = await trigger(RUNNING, make);

    assert.equal(res.status, 200, `${name} must be ordinary the moment there is room`);
    const after = await snapshot(RUNNING);
    assert.ok(after.runs > before.runs, 'the trigger actually enqueued');
  });
}

test('the 402 answers before the 503 — an unpaid account is told to pay, not to wait (A3)', async () => {
  await setSubscription(WAITING, null);
  await setActivated(WAITING, null);
  const res = await trigger(WAITING, RUN_PATHS[0][1]);
  assert.equal(res.status, 402, 'no subscription is a billing problem, and this story must not mask it');
  assert.equal(res.body.billing_required, true);
  assert.equal(res.body.activation_pending, undefined);
});

test('the 503 answers before requireAgentKey — waiting is not a key problem', async () => {
  await makePending(WAITING);
  await pool.query('update users set openai_key_ciphertext = null where id = $1', [WAITING]);
  const res = await trigger(WAITING, RUN_PATHS[0][1]);
  assert.equal(res.body.activation_pending, true, 'the caller hears the thing that is actually blocking them');
  await seedStoredKey(pool, WAITING);
});

test('a suite is refused whole — activation does not vary between members', async () => {
  await makePending(WAITING);
  const before = await snapshot(WAITING);
  const res = await request(app).post(`/api/suites/${fx[WAITING].suiteId}/run`).set(asUser(WAITING)).send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.runs, undefined, 'no partial-accept array');
  await assertNothingHappened(WAITING, before, 'suite');
});

test('an account with no deadline is still refused, with the full window as Retry-After (A4)', async () => {
  await makePending(WAITING, { requestedAt: null });
  const res = await trigger(WAITING, RUN_PATHS[0][1]);
  assert.equal(res.status, 503);
  assert.equal(res.body.activation_deadline, null, 'we do not invent a promise we cannot date');
  assert.equal(Number(res.headers['retry-after']), SLA_HOURS * 3600);
});

test('the exempt operator runs with no activation and no subscription at all (A5)', async () => {
  await setSubscription(OPERATOR_ID, null);
  await setActivated(OPERATOR_ID, null);
  const res = await trigger(OPERATOR_ID, RUN_PATHS[0][1]);
  assert.equal(
    res.status,
    200,
    'the operator resizing the box must be able to smoke-test it — a bypass they cannot revoke themselves out of'
  );
});

// --- S: the scheduler, the seventh path (A10) --------------------------------

test("a pending account's schedule is claimed but does not fire, and survives", async () => {
  await makePending(WAITING);
  const { rows } = await pool.query(
    `insert into schedules (user_id, test_id, kind, hour, minute, next_run_at)
     values ($1, $2, 'daily', 3, 0, $3) returning id`,
    [WAITING, fx[WAITING].testId, new Date(Date.now() - 1000)]
  );
  const scheduleId = rows[0].id;
  const before = await snapshot(WAITING);

  const result = await tick();
  assert.equal(result.pending, 1, 'the tick reports it declined to fire one schedule (A10)');
  assert.equal(result.runs, 0);
  assert.equal(result.blocked, 0, 'and it is NOT reported as a billing block — they paid');
  await assertNothingHappened(WAITING, before, 'scheduler fire');

  const after = await pool.query('select enabled, next_run_at from schedules where id = $1', [scheduleId]);
  assert.equal(after.rows[0].enabled, true, 'waiting destroys nothing');
  assert.ok(
    new Date(after.rows[0].next_run_at).getTime() > Date.now(),
    'the slot was claimed, so a day of waiting does not fire a backlog the moment we activate'
  );

  // The bypass the story names: a schedule saved before subscribing.
  await setActivated(WAITING, new Date());
  await pool.query('update schedules set next_run_at = $1 where id = $2', [new Date(Date.now() - 1000), scheduleId]);
  const resumed = await tick();
  assert.equal(resumed.pending, 0);
  assert.equal(resumed.runs, 1, 'and it resumes at the next slot without being recreated');
  await drain();
  await pool.query('delete from schedules where id = $1', [scheduleId]);
});

// --- R: reads stay open throughout (A13) -------------------------------------

test('a waiting customer can read everything — history, detail, steps, report, recording, settings', async () => {
  await makePending(RUNNING);
  await setActivated(RUNNING, new Date());
  const started = await request(app)
    .post(`/api/tests/${fx[RUNNING].testId}/run`)
    .set(asUser(RUNNING))
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

  // Now put them back in the window (a resubscribe onto a bigger plan would).
  await setActivated(RUNNING, null);
  const as = asUser(RUNNING);
  assert.equal((await request(app).get('/api/runs').set(as)).status, 200, 'history');
  assert.equal((await request(app).get(`/api/runs/${runId}`).set(as)).status, 200, 'detail');
  assert.equal((await request(app).get(`/api/runs/${runId}/steps`).set(as)).status, 200, 'steps');
  assert.equal((await request(app).get(`/api/runs/${runId}/report.pdf`).set(as)).status, 200, 'PDF');
  assert.equal((await request(app).get(`/api/runs/${runId}/recording`).set(as)).status, 200, 'recording');
  assert.equal((await request(app).get('/api/tests').set(as)).status, 200, 'saved tests');
  assert.equal((await request(app).get('/api/account/openai-key').set(as)).status, 200, 'settings');
  assert.equal((await request(app).get('/api/billing/status').set(as)).status, 200, 'billing status');
});

// --- W: what the webhook writes, and what it must never write ----------------

test('activation_requested_at is stamped once, from the entitling event, and never moves (A7)', async () => {
  await setSubscription(WAITING, null);
  await setActivated(WAITING, null);

  const first = unix() - 600;
  await deliver(checkoutEvent(WAITING, { created: first })).expect(200);
  const stamped = await requestedAtOf(WAITING);
  assert.ok(stamped, 'the first entitling event starts the clock');
  assert.equal(
    Math.round(new Date(stamped).getTime() / 1000),
    first,
    "the clock is Stripe's own `created`, not our now() — otherwise a replayed event redates the promise"
  );

  // Everything Stripe sends afterwards. Each is a chance to slide the deadline.
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.created', { created: first + 1 })).expect(200);
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.updated', { created: first + 60 })).expect(200);
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.updated', { created: unix() })).expect(200);
  assert.equal(
    new Date(await requestedAtOf(WAITING)).getTime(),
    new Date(stamped).getTime(),
    'a deadline recomputed per event slides forward forever and the window silently never closes'
  );
});

test('a non-entitling event does not start the clock (A7)', async () => {
  await setSubscription(WAITING, null);
  await deliver(checkoutEvent(WAITING, {})).expect(200);
  await pool.query('update subscriptions set activation_requested_at = null where user_id = $1', [WAITING]);
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.updated', { status: 'past_due' })).expect(200);
  assert.equal(await requestedAtOf(WAITING), null, 'the window opens when they become entitled, not before');

  await deliver(subscriptionEvent(WAITING, 'customer.subscription.updated', { status: 'active' })).expect(200);
  assert.ok(await requestedAtOf(WAITING), 'and it opens on the event that entitles them');
});

test('no webhook path ever writes activated_at — activation is sticky (A6)', async () => {
  await setSubscription(WAITING, 'active');
  const activatedAt = new Date(Date.now() - 30 * 24 * HOUR);
  await setActivated(WAITING, activatedAt);

  const events = [
    subscriptionEvent(WAITING, 'customer.subscription.updated'),
    subscriptionEvent(WAITING, 'customer.subscription.updated', { status: 'past_due' }),
    subscriptionEvent(WAITING, 'customer.subscription.deleted', { status: 'canceled' }),
    checkoutEvent(WAITING, {}),
    subscriptionEvent(WAITING, 'customer.subscription.created'),
  ];
  for (const e of events) await deliver(e).expect(200);

  assert.equal(
    new Date(await activatedAtOf(WAITING)).getTime(),
    activatedAt.getTime(),
    're-walling a customer who has been running for a month is the story\'s third failure mode'
  );
  const res = await trigger(WAITING, RUN_PATHS[0][1]);
  assert.equal(res.status, 200, 'a cancel and a resubscribe is not a re-provisioning');
  await drain();
});

test('a resubscribe after a full cancellation is never walled a second time (A6)', async () => {
  await setSubscription(WAITING, null);
  await setActivated(WAITING, new Date(Date.now() - 60 * 24 * HOUR));
  await deliver(checkoutEvent(WAITING, {})).expect(200);
  assert.equal((await trigger(WAITING, RUN_PATHS[0][1])).status, 200);
  await drain();
});

// --- M: the two mails (A8) ---------------------------------------------------

const mailsTo = (address) => mails.filter((m) => m.to.includes(address));

test('the operator is mailed once, on the first entitling event, with the deadline', async () => {
  await setSubscription(WAITING, null);
  await setActivated(WAITING, null);

  const created = unix() - 60;
  await deliver(checkoutEvent(WAITING, { created })).expect(200);
  const opMail = mailsTo(OPERATOR);
  assert.equal(opMail.length, 1, 'the promise nobody sees is not one — this is what buys the operator their hour');
  const body = `${opMail[0].subject}\n${opMail[0].text}`;
  assert.match(body, /waiting@example\.test/, 'which account');
  assert.match(
    body,
    new RegExp(String(new Date((created + SLA_HOURS * 3600) * 1000).getUTCFullYear())),
    'and by when — a mail that does not state the deadline does not create the obligation'
  );
  // The HTML half (US-057) has to carry the obligation too: the operator reads
  // this in a client that renders it, so a deadline present only in `text` is a
  // deadline they never see.
  assert.ok(opMail[0].html?.length, 'a branded body alongside the text one');
  assert.match(opMail[0].html, /waiting@example\.test/);
  assert.match(opMail[0].html, /npm run activate/, 'and the command to act on it');

  // Everything after it is silent: an operator who is mailed on every
  // subscription.updated stops reading the mail that matters.
  mails.length = 0;
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.created')).expect(200);
  await deliver(subscriptionEvent(WAITING, 'customer.subscription.updated')).expect(200);
  assert.equal(mailsTo(OPERATOR).length, 0, 'one account, one mail');
});

test('the customer is mailed on activation, with a link into the app', async () => {
  await makePending(WAITING);
  mails.length = 0;
  const result = await activation.activateByEmail('waiting@example.test');
  assert.equal(result.ok, true);

  const mail = mailsTo('waiting@example.test');
  assert.equal(mail.length, 1);
  assert.match(`${mail[0].subject} ${mail[0].text}`, /https:\/\/qassist\.test/, 'a link into the app, not just news');
  assert.ok(mail[0].html?.length, 'a branded body alongside the text one (US-057)');
  assert.ok(mail[0].html.includes('href="https://qassist.test"'), 'the link is clickable, not just printed');
});

// --- O: the operator's script (A11) ------------------------------------------

test('pendingAccounts lists exactly who is waiting, oldest first, with time left', async () => {
  await makePending(WAITING, { requestedAt: new Date(Date.now() - 30 * HOUR) });
  await makePending(RUNNING, { requestedAt: new Date(Date.now() - 2 * HOUR) });
  await setActivated(RUNNING, null);

  const pending = await activation.pendingAccounts();
  const emails = pending.map((p) => p.email);
  assert.deepEqual(
    emails,
    ['waiting@example.test', 'running@example.test'],
    'oldest wait first — that is the order the operator should work in'
  );
  assert.equal(pending[0].overdue, true, '30h into a 24h window');
  assert.equal(pending[1].overdue, false);
  assert.ok(pending[1].deadline instanceof Date);
  assert.equal(pending[0].status, 'active', 'the plan/status is shown so the operator knows what they are sizing for');

  await setActivated(RUNNING, new Date());
  const after = await activation.pendingAccounts();
  assert.deepEqual(after.map((p) => p.email), ['waiting@example.test'], 'an activated account leaves the list');
});

test('pendingAccounts never lists an account that is not entitled', async () => {
  await setSubscription(WAITING, 'canceled');
  await setActivated(WAITING, null);
  assert.equal(
    (await activation.pendingAccounts()).some((p) => p.email === 'waiting@example.test'),
    false,
    'an unpaid account is not waiting for capacity — it is waiting for a card'
  );
});

test('activateByEmail matches the whole address, case-insensitively, and nothing else (A11)', async () => {
  await makePending(WAITING);
  await makePending(RUNNING);

  for (const wrong of ['waiting', 'waiting@example.tes', '%@example.test', 'waiting@example.test.uk', '']) {
    const res = await activation.activateByEmail(wrong);
    assert.equal(res.ok, false, `"${wrong}" must not match — activating the wrong account is unrecoverable`);
    assert.equal(await activatedAtOf(WAITING), null, `"${wrong}" activated somebody`);
  }

  const res = await activation.activateByEmail('  WAITING@Example.TEST  ');
  assert.equal(res.ok, true, 'trimmed and case-folded, because the operator is pasting from a mail client');
  assert.equal(res.already, false);
  assert.ok(await activatedAtOf(WAITING));
  assert.equal(await activatedAtOf(RUNNING), null, 'and exactly one account moved');
});

test('activateByEmail is idempotent and does not re-mail (A11)', async () => {
  await makePending(WAITING);
  await activation.activateByEmail('waiting@example.test');
  const first = await activatedAtOf(WAITING);
  mails.length = 0;

  const again = await activation.activateByEmail('waiting@example.test');
  assert.equal(again.ok, true);
  assert.equal(again.already, true, 'an operator will run it twice');
  assert.equal(
    new Date(await activatedAtOf(WAITING)).getTime(),
    new Date(first).getTime(),
    'the timestamp is when they were given room, not when the script was last run'
  );
  assert.equal(mails.length, 0, 'and they are not told twice');
});

test('activating an account with no subscription is allowed and changes nothing about the paywall (A11)', async () => {
  await setSubscription(WAITING, null);
  await setActivated(WAITING, null);
  assert.equal((await activation.activateByEmail('waiting@example.test')).ok, true);
  assert.equal(
    (await trigger(WAITING, RUN_PATHS[0][1])).status,
    402,
    'a precondition here would deadlock the race where the operator activates before the webhook lands'
  );
});

// --- B: the migration must not wall the customers already here (A9) ----------

test('010 backfills activated_at for every account that already has a subscription', async () => {
  // A pool of its own, migrated fully and then rewound by exactly one file, so
  // what runs over the seeded rows is 010_account_activation.sql itself.
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
  const p = new Pool();
  const { runMigrations } = await import('../src/db.js');
  await runMigrations(p, { skipIndexes: true });

  const MIGRATION = '010_account_activation.sql';
  await p.query('delete from schema_migrations where filename = $1', [MIGRATION]);
  await p.query('alter table users drop column activated_at');
  await p.query('alter table subscriptions drop column activation_requested_at');

  const veteran = (await p.query("insert into users (email) values ('veteran@example.test') returning id")).rows[0].id;
  const lapsed = (await p.query("insert into users (email) values ('lapsed@example.test') returning id")).rows[0].id;
  const freeloader = (await p.query("insert into users (email) values ('free@example.test') returning id")).rows[0].id;
  for (const [uid, status] of [[veteran, 'active'], [lapsed, 'canceled']]) {
    await p.query(
      `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status)
       values ($1, $2, $3, $4)`,
      [uid, `cus_${uid.slice(0, 8)}`, `sub_${uid.slice(0, 8)}`, status]
    );
  }

  await runMigrations(p, { skipIndexes: true });

  const at = async (uid) => (await p.query('select activated_at from users where id = $1', [uid])).rows[0].activated_at;
  assert.ok(
    await at(veteran),
    'the day this feature is switched on must not wall a customer who has been running for a month'
  );
  assert.ok(await at(lapsed), 'nor one who has already been served by this box and lapsed');
  assert.equal(await at(freeloader), null, 'but nobody is handed capacity they never bought');
});

// --- U: the surface the wall reads (A12) -------------------------------------

test('GET /api/billing/status carries the fourth step', async () => {
  await makePending(WAITING);
  const waiting = await request(app).get('/api/billing/status').set(asUser(WAITING)).expect(200);
  assert.equal(waiting.body.entitled, true, 'they have paid — the wall is not the paywall');
  assert.equal(waiting.body.activation_pending, true);
  assert.equal(
    new Date(waiting.body.activation_deadline).getTime(),
    new Date(await requestedAtOf(WAITING)).getTime() + SLA_HOURS * HOUR
  );

  await setActivated(WAITING, new Date());
  const ready = await request(app).get('/api/billing/status').set(asUser(WAITING)).expect(200);
  assert.equal(ready.body.activation_pending, false, 'and the wall falls with no reload of anything but state');

  const op = await request(app).get('/api/billing/status').set(asUser(OPERATOR_ID)).expect(200);
  assert.equal(op.body.activation_pending, false, 'exempt is never pending (A5)');
});
