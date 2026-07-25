// @ts-check
// US-039 — assertion-first spec for BYOK-ONLY: a run is funded by the caller's
// key or it does not start. `resolveRunKey`'s precedence is a listed
// correctness-critical surface (backlog/correctness-critical.md), and this
// story deletes a tier from it, so the assertions are written and reviewed
// before the implementation.
//
// This file is the REFUSAL half, multi-user (AUTH_ENABLED=1): the gate on every
// path that can start a run, the scheduler's per-schedule skip, and — the
// assertion that carries the story — that a live-looking OPENAI_API_KEY sitting
// in the environment changes NONE of it. Its companions:
//   • byok-solo.test.js     — the same, auth OFF (config is import-time, so that
//                             needs its own process, as billing-off.test.js does)
//   • byok-postgres.test.js — the POSITIVE half: a caller WITH a stored key
//   • boot.test.js          — the two env vars this story makes mandatory
//
// Why the positive half lives elsewhere: **pg-mem cannot store an encrypted
// key.** It round-trips `bytea` through a string, so the AES-GCM ciphertext
// comes back with UTF-8 replacement bytes (72 bytes in, 120 out) and
// `decryptSecret` throws "unable to authenticate data". Nothing here may
// therefore assert on a *stored* key — an implementation could pass this file
// while being unable to run a keyed user at all. That is exactly the pg-mem
// trap CLAUDE.md warns about, and it is why byok-postgres.test.js exists.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these assertions encode that I could NOT derive from
// the story, and that you're signing off before I implement. Edit the
// assertions directly; they are the spec.
//
//   D1  `resolveRunKey` KEEPS its signature and loses only its third tier:
//         resolveRunKey({ requestKey, storedKey }) === requestKey || storedKey || null
//       The proof that the fallback is *gone* rather than *unconfigured* is
//       negative and therefore easy to fake: this whole file runs with
//       OPENAI_API_KEY set to a live-looking value (SERVER_KEY below), so every
//       503 asserted here would be a 200 under today's code. AC #6 ("staging
//       can have its key restored with no effect") is that, in a test.
//       [REVIEW: confirm — including that `config.js` stops EXPORTING
//       OPENAI_API_KEY at all rather than keeping an unread export.]
//
//   D2  `requireAgentKey` resolves the stored key UNCONDITIONALLY — the current
//       `authEnabled() ? currentUserId() : null` branch goes. currentUserId()
//       already falls back to the seeded operator outside a request context
//       (db.js), which is exactly what makes the auth-off self-host coherent.
//       [REVIEW: confirm the branch deletion is the whole change here.]
//
//   D3  The refusal stays 503 (not 400/402/412) and its message is ONE string
//       for every mode — there is no longer an operator/user distinction to
//       tell them apart. Pinned below as KEYLESS_ERROR:
//         'no OpenAI key: add yours in Settings'
//       and asserted to name neither `.env` nor `OPENAI_API_KEY`, because the
//       thing a registrant on someone else's instance can act on is Settings.
//       [REVIEW: tell me the exact wording you want and I'll pin that instead —
//       the assertion is that the string is stable and mentions Settings.]
//
//   D4  Middleware order is unchanged: checkToken → requireEntitled →
//       requireAgentKey, and the per-request malformed-key 400 still answers
//       before the 503. A caller who sent something key-shaped hears that it's
//       malformed; a caller who sent nothing hears to go to Settings.
//
//   D5  SCHEDULER: the keyless check sits AFTER the claim, beside the billing
//       one, and `tick()` grows a `keyless` counter next to `blocked`. Claiming
//       first is the same reasoning US-022 used (billing-gate D7): a keyless
//       month must not accumulate slots that all fire at once the moment a key
//       is stored — the schedule resumes at its NEXT slot. `startScheduler()`
//       stops refusing to start entirely, because there is no longer a global
//       that could decide the outcome for every owner.
//       [REVIEW: claim-then-skip over skip-before-claim, and the counter name.]
//
//   D6  HEALTH: `agent_ready` is DROPPED from /api/health rather than
//       redefined. Readiness is now per-user and /api/health is ungated — it
//       opens no user context, so it cannot answer "does the caller have a
//       key" without either gating health or parsing the session cookie there.
//       The Settings key-state endpoint (GET /api/account/openai-key) is the
//       answer, and it is now reachable in every mode (D7). The RunView banner
//       is rewired onto it. [REVIEW: drop vs redefine — the story left this
//       open, and dropping a field is the breaking half of the choice.]
//
//   D7  `accountRouter` loses its `authEnabled()` 404 gate; `requireDb` stays
//       and is now always satisfied (DATABASE_URL is a boot requirement). This
//       is what gives a no-auth self-hoster somewhere to put a key at all.
//
//   D8  "Refused means nothing happened" is asserted exactly as billing-gate's
//       D8 does: no `runs` row for that user, counts() unchanged (no slot, no
//       queue entry), and no new directory under ARTIFACTS_DIR — the run dir is
//       the first thing a spawn creates, so an untouched artifacts dir is the
//       no-Python proof.
//
//   D9  RIPPLE: every existing test that started a run over HTTP leaned on the
//       server-key fallback (they set OPENAI_API_KEY and no stored key). The
//       pg-mem corruption is in the bytea PARAMETER path only, so a registered
//       decode() function can smuggle a decryptable ciphertext in as hex —
//       helpers/stored-key.js — and those harnesses now seed their user a
//       stored key instead: api.test.js, the control-plane files, billing-gate,
//       billing-off, notify, scheduler.test.js. Files with no DB pass a
//       per-request key (concurrency-cap-route, verdict). first-run.test.js
//       changed subject: "a fresh clone with no .env" no longer boots, so it
//       now pins the documented minimum config. All behaviour that was MEANT
//       to change (CLAUDE.md's red-test rule); the commit says so. The seeding
//       trick is for tests whose subject is NOT key storage — the product
//       write path still corrupts on pg-mem, which is why the store-then-run
//       flow lives in byok-postgres.test.js.
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
import { RUN_PATHS, seedRunTargets } from './helpers/run-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_SECRET = 'test-session-secret-0123456789';
// Deliberately present and deliberately live-looking. Every refusal in this
// file is asserted with this sitting in the environment (D1).
const SERVER_KEY = 'sk-proj-' + 'ServerFallbackMustNeverFundARun0123456789';
const REQUEST_KEY = 'sk-proj-' + 'Request999request999request999request999b';

/** The one refusal string, pinned (D3). */
const KEYLESS_ERROR = 'no OpenAI key: add yours in Settings';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {(now?: number) => Promise<any>} */
let tick;
/** @type {any} */
let config;
let artifactsDir = '';

/** userId → one of everything runnable, so every start path has a target. */
const fx = /** @type {Record<string, any>} */ ({});
let KEYLESS = '';
let OTHER = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-byok-only-'));
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MAIL_DEV_CONSOLE = '1';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  // The point of the file: the server key is present and must fund nothing.
  process.env.OPENAI_API_KEY = SERVER_KEY;
  delete process.env.AUTH_MODE;
  delete process.env.MAX_CONCURRENT_PER_USER;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
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
  auth = await import('../src/auth.js');
  config = await import('../src/config.js');
  ({ counts } = await import('../src/runs.js'));
  ({ tick } = await import('../src/scheduler.js'));
  ({ app } = await import('../src/server.js'));

  KEYLESS = await makeUser('keyless@example.test');
  OTHER = await makeUser('other@example.test');
  for (const uid of [KEYLESS, OTHER]) fx[uid] = await seedRunTargets(pool, uid);
});

// --- harness -----------------------------------------------------------------

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

const asUser = (uid) => ({ Cookie: `${auth.SESSION_COOKIE}=${auth.signSession(uid)}` });

const trigger = (uid, make, extraBody = {}) => {
  const { url, body } = make(fx[uid]);
  return request(app).post(url).set(asUser(uid)).send({ ...(body || {}), ...extraBody });
};

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

// --- K0: the fallback is gone, not unconfigured (D1) --------------------------

test('config exports no OPENAI_API_KEY — the concept leaves the product', () => {
  assert.equal(
    'OPENAI_API_KEY' in config,
    false,
    'an unread export is still a second way to fund a run; the story removes the concept'
  );
  // And the environment really does hold one, so this is a deletion and not an
  // accident of an unset var.
  assert.equal(process.env.OPENAI_API_KEY, SERVER_KEY);
});

test('/api/health no longer advertises instance-wide agent readiness (D6)', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(
    'agent_ready' in res.body,
    false,
    'readiness is per-user now; Settings key-state says it instead'
  );
});

// --- K1/K2: every start path refuses a keyless caller -------------------------

for (const [name, make] of RUN_PATHS) {
  test(`${name} — 503 for a caller with no key, and nothing happened (D8)`, async () => {
    const before = await snapshot(KEYLESS);
    const res = await trigger(KEYLESS, make);

    assert.equal(res.status, 503, 'the instance cannot serve this caller until they supply a key');
    assert.equal(res.body.error, KEYLESS_ERROR, 'one message, pinned (D3)');
    assert.match(res.body.error, /Settings/, 'names the thing the caller can actually do');
    assert.doesNotMatch(
      res.body.error,
      /\.env|OPENAI_API_KEY|operator/i,
      "a registrant on someone else's instance has no .env to edit"
    );
    await assertNothingHappened(KEYLESS, before, name);
  });
}

// --- K3: the per-request key still funds a run on its own ---------------------

test('a per-request openai_api_key starts a run for a caller with nothing stored', async () => {
  const res = await request(app)
    .post('/api/runs')
    .set(asUser(KEYLESS))
    .send({ goal: 'log in', start_url: 'https://example.test', openai_api_key: REQUEST_KEY })
    .expect(200);
  assert.ok(res.body.runId, 'BYOK-per-request is untouched by this story');
  await drain();
});

test('a malformed per-request key is 400 before the 503 (D4)', async () => {
  const before = await snapshot(KEYLESS);
  const res = await request(app)
    .post('/api/runs')
    .set(asUser(KEYLESS))
    .send({ goal: 'log in', start_url: 'https://example.test', openai_api_key: 'not-a-key' })
    .expect(400);
  assert.match(res.body.error, /sk-/, 'tells them the shape, not to go to Settings');
  await assertNothingHappened(KEYLESS, before, 'malformed key');
});

test('a CI-triggered run is refused on the same terms as a UI one', async () => {
  // 'retry' and 'CI' are triggers, not endpoints: the AC's extra paths are this.
  const before = await snapshot(KEYLESS);
  const res = await trigger(KEYLESS, RUN_PATHS[1][1], { trigger: 'ci' });
  assert.equal(res.status, 503);
  await assertNothingHappened(KEYLESS, before, 'ci trigger');
});

test("one caller's per-request key does not fund another caller", async () => {
  await request(app)
    .post('/api/runs')
    .set(asUser(OTHER))
    .send({ goal: 'log in', start_url: 'https://example.test', openai_api_key: REQUEST_KEY })
    .expect(200);
  await drain();

  const before = await snapshot(KEYLESS);
  const res = await trigger(KEYLESS, RUN_PATHS[0][1]);
  assert.equal(res.status, 503, 'a key is per-run and per-caller, never ambient');
  await assertNothingHappened(KEYLESS, before, 'cross-user');
});

// --- K4: the account surface is what says "ready" now (D6, D7) ---------------

test('GET /api/account/openai-key reports set-state per caller', async () => {
  const res = await request(app).get('/api/account/openai-key').set(asUser(KEYLESS)).expect(200);
  assert.equal(res.body.set, false, 'this is what the RunView banner now keys off');
  assert.equal(res.body.key, undefined, 'never the value');
});

// --- K5: the scheduler skips per-schedule instead of refusing to start (D5) ---

/** A schedule due `dueAt`, owned by `uid`, pointed at that user's test. */
async function makeSchedule(uid, dueAt) {
  const { rows } = await pool.query(
    `insert into schedules (user_id, test_id, kind, interval_hours, tz, next_run_at, enabled)
     values ($1, $2, 'hourly', 1, 'UTC', $3, true) returning id, next_run_at`,
    [uid, fx[uid].testId, new Date(dueAt)]
  );
  return rows[0];
}

test('a due schedule whose owner has no key is claimed, skipped and counted (D5)', async () => {
  await pool.query('delete from schedules');
  const now = Date.UTC(2026, 6, 25, 12, 0, 0);
  const s = await makeSchedule(KEYLESS, now - 1000);
  const before = await snapshot(KEYLESS);

  const result = await tick(now);

  assert.equal(result.keyless, 1, 'the skip is counted, not silent');
  assert.equal(result.fired, 0, 'the slot did not fire');
  assert.equal(result.runs, 0);
  await assertNothingHappened(KEYLESS, before, 'keyless schedule');

  const { rows } = await pool.query('select next_run_at from schedules where id = $1', [s.id]);
  assert.ok(
    new Date(rows[0].next_run_at).getTime() > now,
    'claimed first: a keyless month must not accumulate slots that all fire once a key is stored'
  );
});

test('startScheduler no longer refuses to start on account of a global key (D5)', async () => {
  const { startScheduler } = await import('../src/scheduler.js');
  const timer = startScheduler();
  assert.notEqual(timer, null, 'with a control plane, the ticker runs — owners are judged per slot');
  if (timer) clearInterval(timer);
  await drain();
});
