// @ts-check
// US-079 — assertion-first spec for pausing a run (correctness-critical).
// Same shape as stop-run.test.js: real migrations on pg-mem, the real engine and
// the real app, a stub agent that holds its slot until it is released.
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
//
// The subject is a PAIR OF TIMERS, one of which must be suspended exactly when
// the other starts. Both are invisible until a box is full or a run is
// abandoned, which is why this is here and not test-alongside. The five
// properties they defend:
//
//   W — the wall clock is SUSPENDED by a pause, not merely ignored. A run left
//       paused past RUN_TIMEOUT_MS is still running and must not be reported as
//       a resource failure. The watchdog's message says the run "exceeded the
//       time limit and was stopped", which is a lie about a run that was doing
//       exactly what it was told, and US-012 mails it and US-008 fails the
//       build on it.
//
//   R — a resume re-arms the wall clock WITH THE TIME THE RUN HAD LEFT. Two
//       ways to get this wrong and they fail in opposite directions: forget to
//       re-arm and a resumed run has no wall-clock bound at all, so a wedged
//       agent squats a slot forever; re-arm with a fresh RUN_TIMEOUT_MS and the
//       bound is defeated by repetition — N pauses buy N × the ceiling, which is
//       the same unbounded run reached politely.
//
//   P — the pause is itself BOUNDED, and its bound ends the run as `cancelled`.
//       A pause left on someone's second monitor is an abandoned run, and an
//       abandoned run ends the way US-047 ends one: cancelled, evidence intact,
//       `error` null. Ending it as `failed` reports a resource problem nobody
//       caused; leaving it unbounded leaks a browser, a process and a slot.
//
//   S — the slot comes back, exactly once. Whatever ends a paused run — the
//       pause budget, a user's stop, the wall clock after a resume — `active`
//       returns to 0 and the queue advances. A leak queues every later run
//       forever; a double-decrement takes `active` negative and the cap stops
//       holding.
//
//   I — `paused` is a flag, never a status. `run.status` stays `running`, so
//       TERMINAL never contains it, retention.js cannot sweep runs/<id>/ out
//       from under a live process, and attachViewer never tells a viewer that a
//       run they can still watch has ended.
//
// Neither timer may outlive the run. A timer armed past the pid it was going to
// act on is US-047's pid-reuse hazard, reached by a second route.
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

// The two windows under test, sized so each is observable without racing the
// other. WALL_MS must comfortably exceed `node`'s own startup, or a run is
// already out of time by the moment the stub says it is ready — which turns
// every assertion below into a test of the watchdog it is trying to suspend.
// PAUSE_MAX_MS must comfortably exceed WALL_MS, or W cannot wait past the wall
// clock without tripping the pause budget instead.
// Production defaults are RUN_TIMEOUT_SECONDS=600 and PAUSE_MAX_SECONDS=600.
const WALL_MS = 2000;
const PAUSE_MAX_MS = 5000;
const GRACE_MS = 1000;
// How far past the wall clock W waits before claiming it was suspended.
const PAST_WALL_MS = 3000;
// Slack for a timer re-armed across a process boundary. Tight enough that a
// fresh full budget (a 400ms+ error here) fails; loose enough for a loaded box.
const TIMER_TOLERANCE_MS = 250;

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {typeof import('../src/auth.js')} */
let auth;
let artifactsDir;
let releaseDir;

const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-pause-test-'));
  releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-pause-release-'));
  // Config is read at import time, so env must be set before importing.
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // one slot, so the queue is observable
  process.env.RUN_TIMEOUT_SECONDS = String(WALL_MS / 1000);
  process.env.PAUSE_MAX_SECONDS = String(PAUSE_MAX_MS / 1000);
  process.env.STOP_GRACE_SECONDS = String(GRACE_MS / 1000);
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.QA_STUB_RELEASE_DIR = releaseDir;

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

const started = [];

/**
 * A run whose stub never finishes on its own. `release=` rather than `hold=`
 * deliberately: every window here is a server-side timer, and a stub that also
 * runs a clock would let a test pass because the agent happened to exit first.
 */
const start = (uid, name) => {
  const run = /** @type {import('../src/runState.js').Run} */ (
    engine.createRun({
      goal: `release=${name}`,
      start_url: 'https://example.test',
      max_steps: 1,
      user_id: uid,
    })
  );
  started.push(run);
  return run;
};

/** A run whose stub is up and reading stdin — every window is measured from here. */
async function startRunning(uid, name) {
  const run = start(uid, name);
  await pollUntil(() => run.events.some((e) => e.type === 'log' && e.message === 'stub ready'));
  return run;
}

const release = (name) => fs.writeFileSync(path.join(releaseDir, name), '');

async function pollUntil(fn, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const rowFor = async (id) => (await pool.query('select * from runs where id = $1', [id])).rows[0];

// One slot for the whole file: a run left in flight by one test starts the next
// one *queued*, where every pause assertion below silently stops testing what it
// names. Release first so a stub exits gracefully, then stop whatever is left.
afterEach(async () => {
  release('all');
  for (const run of started) engine.stopRun(run);
  await pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  });
  started.length = 0;
  fs.rmSync(path.join(releaseDir, 'all'), { force: true });
});

// --- W: the pause suspends the wall clock ---

test('a run paused past the wall-clock ceiling is still running, not timed out', async () => {
  const uid = await makeUser('w-suspend@example.com');
  const run = await startRunning(uid, 'w-suspend');
  const ws = fakeSocket();
  engine.attachViewer(run, ws);

  assert.equal(engine.pauseRun(run), true);
  // Well past RUN_TIMEOUT_MS, well short of PAUSE_MAX_MS.
  await wait(PAST_WALL_MS);

  assert.equal(run.paused, true);
  assert.equal(run.status, 'running');
  assert.equal(engine.counts().active, 1);
  // The watchdog's own three symptoms, none of which may appear.
  assert.equal(run.result, null, 'no resource-failure result was written');
  assert.equal(
    ws.sent.some((e) => e.type === 'error'),
    false,
    'the wall-clock watchdog fired on a paused run'
  );
  assert.ok(run.child.pid);
  assert.doesNotThrow(() => process.kill(run.child.pid, 0), 'the tree was killed while paused');
});

test('the wall clock is disarmed by the pause, not left running against a longer deadline', async () => {
  // White-box on purpose: an implementation that pushes the deadline out far
  // enough to be untestable passes W and still kills a long pause later.
  const uid = await makeUser('w-disarmed@example.com');
  const run = await startRunning(uid, 'w-disarmed');
  engine.pauseRun(run);
  assert.equal(run.timeoutWatch, null, 'the wall-clock timer must be cleared, not rescheduled');
  assert.ok(
    run.timeoutRemainingMs > 0 && run.timeoutRemainingMs <= WALL_MS,
    `remaining budget ${run.timeoutRemainingMs}ms is not what the run had left`
  );
});

// --- R: the resume re-arms it with the time the run had left ---

test('a resumed run is bounded again, by the budget it had left and not a fresh one', async () => {
  const uid = await makeUser('r-remaining@example.com');
  const run = await startRunning(uid, 'r-remaining');

  await wait(WALL_MS / 2); // spend a knowable part of the budget
  engine.pauseRun(run);
  const remaining = run.timeoutRemainingMs;
  assert.ok(
    remaining < WALL_MS - TIMER_TOLERANCE_MS,
    `the pause recorded ${remaining}ms of a ${WALL_MS}ms budget — nothing was spent`
  );

  await wait(PAST_WALL_MS);
  const at = Date.now();
  assert.equal(engine.resumeRun(run), true);
  assert.equal(run.paused, false);

  // Re-armed, and for what was left. A fresh RUN_TIMEOUT_MS here is the failure
  // that repetition turns into an unbounded run.
  assert.ok(run.timeoutWatch, 'the resumed run has no wall-clock bound at all');
  const armedFor = run.timeoutAt - at;
  assert.ok(
    Math.abs(armedFor - remaining) <= TIMER_TOLERANCE_MS,
    `resumed with ${armedFor}ms against ${remaining}ms left before the pause`
  );

  // And it really fires: the run ends as the wall clock's own failure, which is
  // the honest outcome for an agent that never finished.
  await pollUntil(() => engine.TERMINAL.has(run.status));
  assert.equal(run.status, 'failed');
  assert.match(run.result.message, /time limit/);
  await pollUntil(() => engine.counts().active === 0);
});

test('repeated pauses do not buy more wall clock', async () => {
  const uid = await makeUser('r-repeat@example.com');
  const run = await startRunning(uid, 'r-repeat');

  let previous = Infinity;
  for (let i = 0; i < 3; i++) {
    await wait(WALL_MS / 4);
    engine.pauseRun(run);
    assert.ok(
      run.timeoutRemainingMs < previous,
      `pause ${i + 1} recorded ${run.timeoutRemainingMs}ms, up from ${previous}ms — the budget grew`
    );
    previous = run.timeoutRemainingMs;
    await wait(WALL_MS); // a pause longer than the whole ceiling, three times over
    engine.resumeRun(run);
  }

  // Three pauses each longer than the ceiling, and the run still dies of the one
  // ceiling it was given.
  await pollUntil(() => engine.TERMINAL.has(run.status));
  assert.equal(run.status, 'failed');
  assert.match(run.result.message, /time limit/);
});

test('a resume disarms the pause budget', async () => {
  const uid = await makeUser('r-disarm@example.com');
  const run = await startRunning(uid, 'r-disarm');
  engine.pauseRun(run);
  engine.resumeRun(run);
  assert.equal(run.pauseTimer, null, 'a resumed run is still counting down to cancellation');
  // Proven by outcome as well as by the field: this run ends on the wall clock,
  // which is a different ending from the pause budget's.
  await pollUntil(() => engine.TERMINAL.has(run.status));
  assert.equal(run.status, 'failed');
});

// --- P: the pause is bounded, and the bound cancels ---

test('a pause nobody resumes ends the run as cancelled, with its evidence', async () => {
  const uid = await makeUser('p-forgotten@example.com');
  const run = await startRunning(uid, 'p-forgotten');
  const ws = fakeSocket();
  engine.attachViewer(run, ws);

  const at = Date.now();
  engine.pauseRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status), PAUSE_MAX_MS * 3);
  const took = Date.now() - at;

  assert.ok(took >= PAUSE_MAX_MS, `the pause budget ended early (${took}ms)`);
  assert.ok(took < PAUSE_MAX_MS + GRACE_MS * 2, `the pause budget took ${took}ms — unbounded`);
  assert.equal(run.status, 'cancelled');

  // Cancelled, not failed: nobody caused a resource problem, and `error` is the
  // column US-012's mail and History's red state read.
  const row = await rowFor(run.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.error, null);
  assert.equal(row.success, null);
  // The evidence survives — the same promise a user's own stop makes.
  assert.ok(fs.existsSync(path.join(artifactsDir, run.id, 'recording.mp4')));
  assert.deepEqual(ws.sent.at(-1).type, 'end');
});

test('the pause budget escalates through the stop path, so a wedged agent still ends', async () => {
  // The stub is released only by a file, so nothing about its own behaviour ends
  // this run: the budget must reach the same graceful-then-kill path US-047
  // built, or an agent that ignores the stop is a leak the pause introduced.
  const uid = await makeUser('p-wedged@example.com');
  const run = await startRunning(uid, 'p-wedged');
  const pid = run.child.pid;
  engine.pauseRun(run);
  await pollUntil(() => engine.TERMINAL.has(run.status), PAUSE_MAX_MS * 3);
  await pollUntil(() => engine.counts().active === 0);
  assert.equal(run.status, 'cancelled');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

// --- S: the slot comes back ---

test('a forgotten pause gives its slot back and the queue advances', async () => {
  const uid = await makeUser('s-slot@example.com');
  const first = await startRunning(uid, 's-first');
  const second = start(uid, 's-second');
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });

  engine.pauseRun(first);
  // While paused the slot is HELD — the run is still running and its browser is
  // still open. The bound is what frees it, not the pause.
  await wait(PAST_WALL_MS);
  assert.equal(second.status, 'queued');
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });

  await pollUntil(() => second.status === 'running', PAUSE_MAX_MS * 3);
  assert.equal(first.status, 'cancelled');
  assert.deepEqual(engine.counts(), { active: 1, queued: 0 });

  release('s-second');
  await pollUntil(() => engine.TERMINAL.has(second.status));
  await pollUntil(() => engine.counts().active === 0);
  // Exactly once: a second decrement on the pause path would show up here.
  assert.deepEqual(engine.counts(), { active: 0, queued: 0 });
});

test('a paused run can still be stopped, and neither timer outlives it', async () => {
  const uid = await makeUser('s-stop@example.com');
  const run = await startRunning(uid, 's-stop');
  engine.pauseRun(run);
  assert.equal(engine.stopRun(run), true);
  await pollUntil(() => run.status === 'cancelled');
  await pollUntil(() => engine.counts().active === 0);
  // Both windows are disarmed by the run's end. A timer that outlives the pid it
  // was going to kill takes whatever inherits that pid with it.
  assert.equal(run.pauseTimer, null);
  assert.equal(run.stopTimer, null);
  assert.equal(run.timeoutWatch, null);
});

// --- I: paused is a flag, never a status ---

test('a paused run is not terminal and no viewer is told it ended', async () => {
  const uid = await makeUser('i-flag@example.com');
  const run = await startRunning(uid, 'i-flag');
  const ws = fakeSocket();
  engine.attachViewer(run, ws);

  engine.pauseRun(run);
  assert.equal(run.status, 'running');
  assert.equal(engine.TERMINAL.has(run.status), false);
  assert.equal(engine.TERMINAL.has('paused'), false);
  assert.equal(
    ws.sent.some((e) => e.type === 'end'),
    false,
    'a paused run announced its own end'
  );
  // The DB row agrees: `paused` is never written as a status.
  const row = await rowFor(run.id);
  assert.equal(row.status, 'running');
  // What viewers DO hear is the server's own flag event, durable so a viewer
  // attaching mid-pause sees the same state as the tab that asked for it.
  // Filtered rather than read off the end: the stub echoes every control line it
  // receives, so the last event on the socket is its `log` and not the server's.
  const flags = () => ws.sent.filter((e) => e.type === 'paused' || e.type === 'resumed');
  assert.deepEqual(
    flags().map((e) => e.type),
    ['paused']
  );
  // And it says when the budget ends the run, so the viewer can count down
  // against its own clock rather than a number that went stale in the buffer.
  assert.equal(new Date(flags()[0].until).getTime(), run.pauseDeadlineAt);

  engine.resumeRun(run);
  assert.equal(run.status, 'running');
  assert.deepEqual(
    flags().map((e) => e.type),
    ['paused', 'resumed']
  );
});

test('pausing is idempotent and does not restart the budget', async () => {
  const uid = await makeUser('i-twice@example.com');
  const run = await startRunning(uid, 'i-twice');
  assert.equal(engine.pauseRun(run), true);
  const deadline = run.pauseDeadlineAt;
  await wait(500);
  // False, and — the half that matters — the budget is not pushed out, or a
  // client polling a pause button would keep a run alive forever.
  assert.equal(engine.pauseRun(run), false);
  assert.equal(run.pauseDeadlineAt, deadline);
});

test('a queued run cannot be paused, and a finished one cannot be resumed', async () => {
  const uid = await makeUser('i-queued@example.com');
  const running = await startRunning(uid, 'i-running');
  const queued = start(uid, 'i-queued');
  assert.equal(queued.status, 'queued');
  // No process, so there is nothing to pause — and nothing that would make the
  // wall clock it has not started yet mean anything.
  assert.equal(engine.pauseRun(queued), false);
  await request(app).post(`/api/runs/${queued.id}/pause`).set(asUser(uid)).expect(409);

  release('i-running');
  await pollUntil(() => engine.TERMINAL.has(running.status));
  assert.equal(engine.pauseRun(running), false);
  assert.equal(engine.resumeRun(running), false);
  await request(app).post(`/api/runs/${running.id}/resume`).set(asUser(uid)).expect(409);
});
