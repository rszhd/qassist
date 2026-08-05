// @ts-check
// US-047 — assertion-first spec for stopping a run (correctness-critical).
// Runs the real migrations on pg-mem and drives both the run engine directly
// and the real app over HTTP, like auth-isolation.test.js.
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
// The five properties they defend:
//
//   A — slot accounting survives a stop. A queued run is spliced out and never
//       spawns, so nothing decrements a slot it never took; a running run's
//       slot is released exactly once, by the process's own close. Drift either
//       way is invisible until the box is full: a leak queues every later run
//       forever, a double-decrement takes `active` negative and the cap stops
//       holding.
//
//   V — the agent's verdict never survives a stop. browser-use returns history
//       normally after Agent.stop(), so a stopped run still reports a `done`
//       event, and its self-report may say success. If the engine derives the
//       status from that event as usual, a run the user aborted ends `passed`:
//       US-008's CI gate goes green, US-012 reads it as a pass, and the History
//       row shows a verdict nobody earned. The stop *intent* decides, not the
//       agent's word — and a cancelled run carries no `success` at all.
//
//   L — `cancelled` is assigned by the run's end, never by the request. It is
//       a member of TERMINAL, which retention.js reads to decide a live run's
//       artifacts may be swept and attachViewer reads to tell viewers the run
//       is over. Set at request time, a still-running run has runs/<id>/ pruned
//       from under it and every attached viewer told it ended.
//
//   K — the wedged agent still ends `cancelled`. An agent that never reaches
//       browser-use's stop checkpoint is killed by the existing hard path on a
//       bounded timer, and the close handler must read the intent rather than
//       the exit code — otherwise the honest hard path reports `error`, which
//       US-012 mails and US-008 fails the build on.
//
//   O — stopping is a write keyed on a run id. One user cannot stop another's
//       run, and the refusal must not reveal that it exists (404, not 403).
//       The half that matters is the second: a 404 that stopped the run anyway
//       is the actual bug.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-session-secret-0123456789';
const COOKIE = 'qassist_session';

// The escalation window, small enough to assert against. Production default is
// STOP_GRACE_SECONDS=10 — long enough that a stop landing mid-action (one
// in-flight browser action, not a full LLM round trip) is never pre-empted.
const GRACE_MS = 1000;

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {typeof import('../src/auth.js')} */
let auth;
let artifactsDir;

const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-stop-test-'));
  // Config is read at import time, so env must be set before importing.
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // one slot, so the queue is observable
  process.env.STOP_GRACE_SECONDS = String(GRACE_MS / 1000);
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
  engine = await import('../src/runs.js');
  ({ app } = await import('../src/server.js'));
});

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

/** A WebSocket as far as the relay is concerned: it records what it is sent. */
function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: /** @type {any[]} */ ([]),
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    on() {},
  };
}

/**
 * A run that holds its slot for `holdMs`. `stop` picks the stub's behaviour when
 * a stop command arrives: 'honour' emits its partial evidence and exits (what
 * browser-use does — history returns normally), 'ignore' is the wedged agent.
 */
const started = [];
const start = (uid, { holdMs = 5000, stop = 'honour' } = {}) => {
  // No cap in force and a permitted start_url, so this is always a Run —
  // said once here, so every field read below stays checked.
  const run = /** @type {import('../src/runState.js').Run} */ (
    engine.createRun({
      goal: `hold=${holdMs} stop=${stop}`,
      start_url: 'https://example.test',
      max_steps: 1,
      user_id: uid,
    })
  );
  started.push(run);
  return run;
};

/**
 * A run whose stub is up and reading stdin. Every test that stops a *running*
 * agent goes through this: without it the stop grace window is racing `node`'s
 * own startup, and on a loaded box the escalation wins — which quietly turns a
 * graceful-stop assertion into an escalation one that happens to end in the
 * same status, with `run.result` empty and no verdict to have overridden.
 */
async function startRunning(uid, opts) {
  const run = start(uid, opts);
  await pollUntil(() => run.events.some((e) => e.type === 'log' && e.message === 'stub ready'));
  return run;
}

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const rowFor = async (id) =>
  (await pool.query('select * from runs where id = $1', [id])).rows[0];

// One slot for the whole file, so a run left in flight by one test starts the
// next one *queued* — where `stopRun` takes its no-process branch and the
// running-run assertions quietly stop testing what they name. Drain between
// tests rather than reasoning about it per case. A status reaching `cancelled`
// is not enough: the escalation stamps it before the child's close, which is
// where the slot is actually given back.
afterEach(async () => {
  for (const run of started) engine.stopRun(run);
  await pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  });
  started.length = 0;
});

// --- A: slot accounting ---

test('a queued run is dequeued, never spawns, and does not touch the slot count', async () => {
  const uid = await makeUser('a-queued@example.com');
  const running = await startRunning(uid, { holdMs: 3000 });
  const queued = start(uid, { holdMs: 3000 });
  assert.equal(running.status, 'running');
  assert.equal(queued.status, 'queued');
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });

  const ws = fakeSocket();
  engine.attachViewer(queued, ws);

  // A dequeue is synchronous: there is no process to wait on.
  assert.equal(engine.stopRun(queued), true);
  assert.equal(queued.status, 'cancelled');
  assert.ok(queued.finishedAt);
  // The canary for "never spawns": no child was ever created for it.
  assert.equal(queued.child, undefined);
  // The slot the running run holds is untouched, and the queue is empty.
  assert.deepEqual(engine.counts(), { active: 1, queued: 0 });
  assert.deepEqual(ws.sent.at(-1), { type: 'end', status: 'cancelled' });

  // And the accounting is still honest once the running run drains: `active`
  // returns to 0, which a decrement on the dequeue path would have taken to -1.
  await pollUntil(() => engine.TERMINAL.has(running.status));
  await pollUntil(() => engine.counts().active === 0);
  assert.deepEqual(engine.counts(), { active: 0, queued: 0 });
});

test("a stopped run's slot is released and the queue advances", async () => {
  const uid = await makeUser('a-slot@example.com');
  const first = await startRunning(uid, { holdMs: 30_000 });
  const second = start(uid, { holdMs: 200 });
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });

  engine.stopRun(first);
  await pollUntil(() => first.status === 'cancelled');
  await pollUntil(() => second.status === 'running');
  assert.deepEqual(engine.counts(), { active: 1, queued: 0 });

  await pollUntil(() => engine.TERMINAL.has(second.status));
  await pollUntil(() => engine.counts().active === 0);
});

// --- V: the agent's verdict never survives a stop ---

test('a stopped run ends cancelled even when the agent reports success', async () => {
  const uid = await makeUser('v-green@example.com');
  // The stub's stop path emits `{"type":"done","success":true}` — exactly what
  // browser-use hands back when Agent.stop() lands and history returns normally.
  const run = await startRunning(uid, { holdMs: 30_000 });
  engine.stopRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status));

  assert.equal(run.status, 'cancelled');
  // The evidence is kept — this is what the report is built from...
  assert.ok(run.result, 'the partial result is kept for the report');
  // ...but the verdict is not. A cancelled run answered nothing.
  const row = await rowFor(run.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.success, null);
  assert.equal(row.finished_at !== null, true);

  // The same claim over the wire, where CI and the History row read it.
  const res = await request(app).get(`/api/runs/${run.id}`).set(asUser(uid)).expect(200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.success, null);
});

test('a stopped run is not counted as an error either', async () => {
  const uid = await makeUser('v-error@example.com');
  const run = await startRunning(uid, { holdMs: 30_000 });
  engine.stopRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status));
  const row = await rowFor(run.id);
  // `error` is the column US-012's mail and History's red state read.
  assert.equal(row.error, null);
});

test('cancelled is a status the schema and the history filter both accept', async () => {
  const uid = await makeUser('v-schema@example.com');
  const run = await startRunning(uid, { holdMs: 30_000 });
  engine.stopRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status));
  // The insert reached the table rather than failing the check constraint.
  assert.ok(await rowFor(run.id));
  const res = await request(app)
    .get('/api/runs?status=cancelled')
    .set(asUser(uid))
    .expect(200);
  assert.ok(res.body.runs.some((/** @type {any} */ r) => r.id === run.id));
});

// --- L: cancelled is assigned by the run's end, never by the request ---

test('a stop request does not make the run terminal while its process is alive', async () => {
  const uid = await makeUser('l-live@example.com');
  const run = await startRunning(uid, { holdMs: 30_000, stop: 'ignore' });
  const ws = fakeSocket();
  engine.attachViewer(run, ws);

  engine.stopRun(run);
  // Immediately after the request: still running, still holding its slot, and
  // — the load-bearing half — not yet terminal, so retention cannot sweep its
  // artifacts and no viewer has been told the run ended.
  assert.equal(run.status, 'running');
  assert.equal(engine.TERMINAL.has(run.status), false);
  assert.equal(engine.counts().active, 1);
  assert.equal(
    ws.sent.some((e) => e.type === 'end'),
    false,
    'no end event until the run actually ends'
  );

  await pollUntil(() => run.status === 'cancelled');
});

test('TERMINAL contains cancelled', () => {
  assert.equal(engine.TERMINAL.has('cancelled'), true);
});

// --- K: the wedged agent ---

test('an agent that ignores the stop is killed within the grace window, still cancelled', async () => {
  const uid = await makeUser('k-wedged@example.com');
  const run = await startRunning(uid, { holdMs: 60_000, stop: 'ignore' });
  const pid = run.child.pid;

  const at = Date.now();
  engine.stopRun(run);
  await pollUntil(() => run.status === 'cancelled', GRACE_MS * 4);
  const took = Date.now() - at;

  assert.ok(took >= GRACE_MS, `escalated before the grace window (${took}ms)`);
  assert.ok(took < GRACE_MS * 3, `escalation took ${took}ms, unbounded in practice`);

  // The slot comes back, which only happens on the child's own close.
  await pollUntil(() => engine.counts().active === 0);
  // And the process really is gone, not merely reported as such. Asserted here
  // rather than at the status flip: a killed child is a zombie until Node reaps
  // it in that close handler, and a zombie still answers signal 0 — so the
  // earlier check would pass against an implementation that never killed
  // anything, for the wrong reason.
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const row = await rowFor(run.id);
  assert.equal(row.status, 'cancelled');
});

test('a graceful stop leaves no escalation timer behind', async () => {
  // White-box on purpose: the hazard is unobservable from outside. A timer left
  // armed past the run fires killRunTree on a pid that has since been reused —
  // and the group kill (`process.kill(-pid)`) takes an unrelated process tree
  // with it.
  //
  // Asserted once the slot is back, not when the status flips: on the graceful
  // path `cancelled` is assigned in the stdout `done` branch, which runs before
  // the child's close, so the timer is legitimately still armed in between —
  // harmless, because it re-checks TERMINAL before killing anything, but a
  // check at the earlier moment would fail an implementation that is correct.
  // What must not survive is a timer armed after the run has ended.
  const uid = await makeUser('k-timer@example.com');
  const run = await startRunning(uid, { holdMs: 30_000 });
  engine.stopRun(run);
  await pollUntil(() => run.status === 'cancelled');
  await pollUntil(() => engine.counts().active === 0);
  assert.equal(run.stopTimer, null);
});

// --- terminality ---

test('a run that has already ended cannot be stopped again', async () => {
  const uid = await makeUser('t-again@example.com');
  const run = start(uid, { holdMs: 100 });
  await pollUntil(() => engine.TERMINAL.has(run.status));
  assert.equal(engine.stopRun(run), false);
  await request(app).post(`/api/runs/${run.id}/stop`).set(asUser(uid)).expect(409);
});

// --- O: one user cannot stop another's run ---

test("a user cannot stop another user's run", async () => {
  const a = await makeUser('o-owner@example.com');
  const b = await makeUser('o-stranger@example.com');
  const run = await startRunning(a, { holdMs: 30_000 });

  // 404, not 403: the refusal must not confirm the run exists.
  await request(app).post(`/api/runs/${run.id}/stop`).set(asUser(b)).expect(404);
  // The half that matters — the run is untouched.
  assert.equal(run.status, 'running');
  assert.equal(engine.counts().active, 1);

  // The owner can, over the same route.
  await request(app).post(`/api/runs/${run.id}/stop`).set(asUser(a)).expect(200);
  await pollUntil(() => run.status === 'cancelled');
});

test('an unauthenticated stop is refused', async () => {
  const a = await makeUser('o-anon@example.com');
  const run = await startRunning(a, { holdMs: 30_000 });
  await request(app).post(`/api/runs/${run.id}/stop`).expect(401);
  assert.equal(run.status, 'running');
  engine.stopRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status));
});
