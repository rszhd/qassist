// @ts-check
// Run engine: admission, the queue, and the life of one agent process — spawn,
// the two watchdogs, the NDJSON stdout loop, stop and teardown. This file is
// the engine's entry point and re-exports the surface the routes import.
//
// The concerns it used to also hold live beside it, one seam per file, and the
// imports only ever point this way: `runState.js` (the registry and how a run
// is read), `runRelay.js` (what subscribers are sent), `runPersistence.js` (the
// row, the session, the mail), `runReport.js`, `runReplay.js` (US-036 demo).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { currentUserId } from './db.js';
import { getUserConcurrencyCap, anyCapInForce } from './concurrency.js';
import { demoMode } from './auth.js';
import { resolveForRun } from './variables.js';
import { fixturePathsFor } from './fixtures.js';
import {
  writeSessionFile,
  removeSessionFiles,
  exportPathFor,
  readExportedState,
  preambleForRun,
} from './browserSession.js';
import {
  MAX_CONCURRENT,
  DEFAULT_MAX_STEPS,
  MAX_RUN_MEMORY_MB,
  MEM_POLL_MS,
  PAUSE_MAX_MS,
  RUN_TIMEOUT_MS,
  STOP_GRACE_MS,
  PYTHON_BIN,
  AGENT_SCRIPT,
  ARTIFACTS_DIR,
  MODEL,
  CAPTURE_HAR,
  CALCULATE_COST,
  instancePolicy,
} from './config.js';
import { checkStartUrl, agentEnvFor } from './navigationPolicy.js';
import { processTree } from './procMemory.js';
import { addRun, allRuns, evictLater, getRun, TERMINAL } from './runState.js';
import { broadcast, setQueuePosition, setScreencast } from './runRelay.js';
import {
  captureSession, maybeNotify, persistInsert, persistUpdate, storeLearned,
} from './runPersistence.js';
import { memoryFor, MEMORY_FORMAT_VERSION } from './testMemory.js';
import { generateReport } from './runReport.js';
import { startReplay } from './runReplay.js';

// The engine's public surface: every caller outside it imports from here, so a
// seam moving between the modules above stays invisible to the routes.
export { diagnosticsOf, getRun, hintsOf, stepsOf, TERMINAL, verdictOf } from './runState.js';
export { attachViewer } from './runRelay.js';

/**
 * @typedef {import('./runState.js').Run} Run
 * @typedef {import('./runEvents.js').RunEvent} RunEvent
 *
 * The two ways `createRun` can answer with no run: nothing inserted, nothing
 * queued. Neither carries an `id`, so the `in` check a caller makes to tell
 * them apart is also what proves it holds a `Run` afterwards.
 * @typedef {{ blocked: true, error: string, reason: string }} Blocked
 * @typedef {{ rejected: true, cap: number, inFlight: number }} Rejected *
 * One row of `RUNNABLE_TEST_COLS` (routes/helpers.js), which is what every
 * batch trigger hands `runTests`. Declared here rather than beside the columns
 * because this is the shape the *engine* requires — the query exists to satisfy
 * it, and a column dropped from that select should fail here, at the consumer.
 * @typedef {{ id: string, goal: string, start_url: string, max_steps: number,
 *             model: string|null,
 *             variables?: import('./variables.js').VariableSpec[],
 *             project_id?: string|null, allowed_domains?: string[],
 *             browser_session_id?: string|null, captures_session_id?: string|null,
 *             initial_actions?: any }} RunnableTest
 */

let active = 0;
/** @type {string[]} */
const queue = [];

export function counts() {
  return { active, queued: queue.length };
}

// --- per-user concurrency cap (US-028, per-user override US-058) ---
// Accounting is in-memory, scanned off the live registry: correct for one
// worker, and deliberately not a distributed counter — enforcing the cap across
// a fleet is US-015's shared-state problem, not this story's. The cap itself is
// resolved in concurrency.js, which owns the one order the three gates below
// read it in; re-exported here because that is where callers import it from.
export { getUserConcurrencyCap };

/** How many of a user's runs are running OR queued — what admission counts.
 * @param {string} uid */
function inFlightForUser(uid) {
  let n = 0;
  for (const run of allRuns()) {
    if (run.user_id === uid && (run.status === 'running' || run.status === 'queued')) n++;
  }
  return n;
}

/** How many of a user's runs are running — what the start-gate and dequeue count.
 * @param {string} uid */
function runningForUser(uid) {
  let n = 0;
  for (const run of allRuns()) {
    if (run.user_id === uid && run.status === 'running') n++;
  }
  return n;
}

// A run may start when a global slot is free AND its owner is under their
// running cap. The second clause is what holds a user (or a scheduled burst
// that bypassed admission) to `cap` running even when global slots are free.
/** @param {Run} run */
function canStart(run) {
  if (active >= MAX_CONCURRENT) return false;
  const cap = getUserConcurrencyCap(run.user_id);
  return cap == null || runningForUser(run.user_id) < cap;
}

/**
 * What a run of these fields would be given (US-081), without creating one.
 *
 * `createRun` and the memory panel both call this, and that sharing is the whole
 * reason it is a function. The story's rule is that the next run receives exactly
 * the content the panel shows — so a second assembly of these inputs is not a
 * tidiness question: two spellings drift, and the panel then displays a notebook
 * the agent was never handed. Same lesson as `RUNNABLE_TEST_COLS`, which US-048
 * learned the other way round.
 * @param {Parameters<typeof createRun>[0]} fields
 */
export function previewMemory(fields) {
  return memoryFor({
    stored: fields.memory ?? null,
    // The resolved instructions and start URL, and nothing else — `fingerprint`
    // documents why. Both arrive already substituted, so a variable that reaches
    // either is already in the text.
    inputs: { goal: fields.goal, start_url: fields.start_url },
  });
}

// --- run lifecycle ---

/**
 * Enqueue a run (starts immediately when under the concurrency cap). Returns
 * the run, or one of two markers and no run — nothing inserted, nothing queued:
 * `{ blocked, error, reason }` when the start_url is outside what this instance
 * or this project may visit (US-042), and `{ rejected, cap, inFlight }` when the
 * caller is over their per-user cap (US-028) and the submit isn't a
 * schedule/demo replay. Callers branch with `'blocked' in` / `'rejected' in`,
 * and that `in` is what narrows the return to a `Run` for everything after it.
 * @param {{ goal: string, start_url: string, max_steps?: number,
 *           model?: string | null, test_id?: string | null,
 *           trigger?: string, variables?: Record<string, string>,
 *           secrets?: Record<string, string>, user_id?: string | null,
 *           openai_api_key?: string | null, project_id?: string | null,
 *           allowed_domains?: string[], har?: boolean,
 *           storage_state?: string | null,
 *           session_verify?: import('./browserSession.js').SessionMaterial['verify'],
 *           capture_session_id?: string | null,
 *           preamble?: import('./browserSession.js').PreambleAction[],
 *           memory?: import('./testMemory.js').StoredMemory | null,
 *           schedule_id?: string | null, scheduled_for?: Date | null }} fields
 * @returns {Run | Blocked | Rejected}
 */
export function createRun(fields) {
  // Explicit user_id for the scheduler (no request context); a request-borne run
  // falls back to the caller resolved by the gate (currentUserId()).
  const uid = fields.user_id ?? currentUserId();
  const trigger = fields.trigger || 'api';

  // The navigation fence (US-042), before admission and before the insert. This
  // is the sole funnel every trigger path reaches — the same property US-036's
  // demo interceptor leans on — so no start path can acquire the fence by being
  // remembered, and a refused run costs neither a row, a slot, nor a call on
  // the caller's key. First, deliberately: a caller pointed at the metadata
  // endpoint should hear that, not "you are over your concurrency cap".
  const policy = instancePolicy(fields.allowed_domains);
  const blocked = checkStartUrl(fields.start_url, policy);
  if (blocked) return { blocked: true, ...blocked };
  // Admission (US-028): an interactive submit over the user's in-flight cap is
  // refused here, not queued — queueing silently would make the wait unbounded
  // and US-027's position meaningless. Demo replays claim no slot, and a
  // schedule must never be dropped (it fires with no human watching), so both
  // bypass admission; a schedule instead queues past the cap and is held to
  // `cap` running by canStart/startNext.
  const cap = getUserConcurrencyCap(uid);
  if (!demoMode() && trigger !== 'schedule' && cap != null) {
    const inFlight = inFlightForUser(uid);
    if (inFlight >= cap) return { rejected: true, cap, inFlight };
  }

  // What this run is given, and what it may write back (US-081). Settled here,
  // before the run exists, for the reason `storage_state` is: the engine is
  // synchronous and the stored notebook is a DB read, so the async caller
  // resolves it and hands it in. A caller that passes nothing gets a fingerprint
  // and no advice — which is a saved test's first run, and correct.
  // An ad-hoc run has no test, so there is nothing to read and nothing to write
  // it back to. Skipping the fingerprint entirely is what makes that spawn
  // identical to one from before this shipped — `memory_fingerprint` is the flag
  // `startRun` and `recordMemory` both read as "this run has no notebook".
  const memory = fields.test_id
    ? previewMemory(fields)
    : { fingerprint: null, used: false, supplied: null, withheld: null };

  const runId = randomUUID();
  /** @type {Run} */
  const run = {
    id: runId,
    goal: fields.goal,
    start_url: fields.start_url,
    max_steps: Number(fields.max_steps) || DEFAULT_MAX_STEPS,
    model: fields.model || null,
    test_id: fields.test_id || null,
    variables: fields.variables || {},
    // The resolved policy, in-memory only (US-042): it is derived from config
    // and the project's row, so persisting it would be a second copy that can
    // disagree with both. Handed to the agent in startRun.
    policy,
    // The owning project, for the fixture whitelist alone (US-048). It arrives
    // off the test's row — never off a request body — because a caller who
    // could name the project could name someone else's, and the whitelist is
    // what browser-use gates both `upload_file` and `read_file` on. A run with
    // no project (the ad-hoc path) resolves to no files at all.
    project_id: fields.project_id || null,
    // Real secret values, in-memory only — handed to the agent via QA_VARS in
    // startRun and deliberately never persisted or serialized (US-035).
    secrets: fields.secrets || {},
    // Whether this run also writes a full HAR (US-044). Opt-in per run, with an
    // instance-wide default for an operator debugging their whole box. In-memory
    // only: it is an argument to one spawn, not a property of the run worth a
    // column — the file's presence on disk is what the download route reads.
    har: fields.har ?? CAPTURE_HAR,
    // BYOK key (US-005): request- or account-resolved, in-memory only. Handed to
    // the agent as OPENAI_API_KEY in startRun; never a column, an event, or an
    // artifact — persistInsert/broadcast/generateReport never read this field.
    openai_api_key: fields.openai_api_key || null,
    // The decrypted session blob (US-043), in-memory only and under exactly the
    // containment `openai_api_key` has above — with one addition it does not
    // need: this one also reaches a FILE, because browser-use will only load a
    // storage state from a path (a dict silently loads nothing). `startRun`
    // writes it, `close` removes the directory it is in.
    //
    // A session blob IS the credential, and `scrub` is not the guard: it never
    // enters the LLM's context, so there is nothing to match on. Containment is
    // the whole mechanism.
    storage_state: fields.storage_state || null,
    session_verify: fields.session_verify || null,
    // The session this run's PASS refreshes, when this test is a login test.
    capture_session_id: fields.capture_session_id || null,
    // The project's deterministic preamble (AC #5), already validated at write
    // time and re-filtered on read.
    preamble: fields.preamble || [],
    // US-081, all decided by `previewMemory` above off the test's stored
    // notebook — which the async caller resolved before this synchronous engine
    // was entered, exactly as the session blob and the stored secrets are.
    // `memory_supplied` is in-memory only, like the policy: it is derived from
    // the test's row, and persisting it would be a second copy that can disagree.
    memory_fingerprint: memory.fingerprint,
    memory_used: memory.used,
    memory_supplied: memory.supplied,
    memory_withheld: memory.withheld,
    user_id: uid,
    trigger,
    // Which schedule started this and which of its firings (US-069). Only the
    // tick sets them — every other caller of this function leaves both null,
    // which is what keeps a non-null `schedule_id` meaning "the scheduler
    // started this" rather than "someone passed the field".
    schedule_id: fields.schedule_id || null,
    scheduled_for: fields.scheduled_for || null,
    status: 'queued',
    events: [],
    subscribers: new Set(),
    result: null,
    createdAt: Date.now(),
  };
  addRun(run);
  persistInsert(run);
  // US-036: on a demo deployment every run is a replay. The interceptor sits
  // here, before the concurrency branch, so NO trigger path (this fn is the sole
  // funnel — ad-hoc, test, suite, module, schedule, retry all reach it) spawns
  // Python, claims a slot, or queues. The row is still written and driven to a
  // terminal verdict from a fixture, so it looks real in the visitor's history.
  if (demoMode()) {
    startReplay(run);
  } else if (canStart(run)) {
    startRun(runId);
  } else {
    queue.push(runId);
    setQueuePosition(run, queue.length - 1);
  }
  return run;
}

/**
 * Start one run per test — the shared batch enqueue behind suite, module and
 * project triggering (US-023) and behind the scheduler (US-010). Tests arrive
 * already ordered; a `start_url` override applies to all of them (US-008:
 * point a whole group at a fresh preview URL). A `variables` override (US-035)
 * sprays every member: each test substitutes the names it declares and fills
 * the rest from its own defaults. A test that can't resolve (a required
 * variable with no value) is skipped with an `error` marker rather than
 * starting a broken run — one misconfigured member never blocks the batch.
 * @param {RunnableTest[]} tests
 * @param {{ start_url?: string|null, trigger?: string,
 *           variables?: Record<string, string>, user_id?: string|null,
 *           openai_api_key?: string|null,
 *           sessions?: Map<string, import('./browserSession.js').SessionMaterial>,
 *           storedSecrets?: Map<string, import('./testSecrets.js').StoredSecrets>,
 *           memory?: Map<string, import('./testMemory.js').StoredMemory>,
 *           schedule_id?: string|null, scheduled_for?: Date|null }} [opts]
 */
export function runTests(tests, opts = {}) {
  return tests.map((t) => {
    // The stored secrets the caller pre-resolved (US-064), beside the session
    // below and refused the same way: a member whose credential will not
    // decrypt must not start a run that types nothing into the password field.
    const secrets = opts.storedSecrets?.get(t.id) || {};
    if (secrets.error) return { testId: t.id, error: secrets.error };
    const resolved = resolveForRun({
      variables: t.variables || [],
      overrides: opts.variables,
      stored: secrets.values,
      goal: t.goal,
      start_url: opts.start_url || t.start_url,
    });
    if ('error' in resolved) return { testId: t.id, error: resolved.error };
    // The session material the caller pre-resolved (US-043). A session that
    // could not be decrypted skips its test with an error marker rather than
    // starting a run that silently isn't logged in — one misconfigured member
    // never blocks the batch, and a run that quietly starts anonymous is the
    // false green the whole story exists to remove.
    const session = opts.sessions?.get(t.id) || {};
    if (session.error) return { testId: t.id, error: session.error };
    const run = createRun({
      goal: resolved.goal,
      start_url: resolved.start_url,
      max_steps: t.max_steps,
      model: t.model,
      test_id: t.id,
      trigger: opts.trigger || 'api',
      variables: resolved.variables,
      secrets: resolved.secrets,
      user_id: opts.user_id,
      openai_api_key: opts.openai_api_key,
      // The owning project's allowlist and id, joined in by whoever selected
      // the test (RUNNABLE_TEST_COLS).
      allowed_domains: t.allowed_domains,
      project_id: t.project_id,
      storage_state: session.storageState,
      session_verify: session.verify,
      capture_session_id: session.captureSessionId,
      preamble: preambleForRun(t.initial_actions),
      // What earlier passing runs of this test learned (US-081).
      memory: opts.memory?.get(t.id) || null,
      // One slot's members all carry the same pair (US-069), which is what
      // makes a suite schedule's ten runs one mark on the strip instead of ten.
      schedule_id: opts.schedule_id,
      scheduled_for: opts.scheduled_for,
    });
    // Blocked (US-042) is a per-member outcome, beside the {error} above and
    // for the same reason: one test pointed at localhost must not cost a suite
    // the other nine results.
    if ('blocked' in run) {
      return { testId: t.id, blocked: true, error: run.error, reason: run.reason };
    }
    // Partial accept (US-028): a batch over the cap starts what fits and reports
    // the rest as rejected rather than failing wholesale. Admission is applied
    // per member as it enqueues, so the first H (headroom) win and the rest are
    // refused, in order. Distinct from the {error} a member that can't resolve gets.
    if ('rejected' in run) {
      return { testId: t.id, rejected: true, cap: run.cap, inFlight: run.inFlight };
    }
    return { runId: run.id, testId: t.id, status: run.status };
  });
}

// Whether this box can report PSS at all is a property of its kernel and its
// permissions, not of any one run, so the warning belongs to the process and
// is said once — a per-poll log would repeat every 3 s for the life of the box.
let warnedRssFallback = false;

/** @param {import('node:child_process').ChildProcess} child @param {number[]} pids */
function killRunTree(child, pids) {
  // Group kill first (child is its own group leader via detached), then each
  // known pid in case anything escaped the group.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * Arm the wall clock (US-005) for `ms`, and record when it will fire.
 *
 * `ms` is the whole ceiling on a fresh run and the *remainder* on a resume
 * (US-079) — a pause must not hand the run a new budget, or the ceiling is
 * defeated by pausing repeatedly rather than by omitting the timer. The message
 * still names RUN_TIMEOUT_MS, because the ceiling the run exceeded is the whole
 * one however many pieces it was served in.
 * @param {Run} run @param {number} ms
 */
function armWallClock(run, ms) {
  run.timeoutAt = Date.now() + ms;
  run.timeoutWatch = setTimeout(() => {
    run.timeoutWatch = null;
    clearInterval(run.memWatch);
    const secs = Math.round(RUN_TIMEOUT_MS / 1000);
    const msg = `run exceeded the ${secs}s time limit and was stopped`;
    console.error(`[watchdog ${run.id.slice(0, 8)}] ${msg}`);
    run.status = 'failed';
    run.result = { success: false, message: msg };
    broadcast(run, { type: 'error', message: msg });
    generateReport(run);
    killRunTree(run.child, processTree(run.child.pid).pids);
  }, ms);
  run.timeoutWatch.unref(); // never hold the process open for the ceiling alone
}

/** @param {Run} run */
function disarmWallClock(run) {
  if (run.timeoutWatch) clearTimeout(run.timeoutWatch);
  run.timeoutWatch = null;
}

// Take down the pause budget and clear the flag, WITHOUT giving the wall clock
// back: that is `resumeRun`'s job and only its job. A stop landing on a paused
// run goes through here, and re-arming there would let a run paused near its
// ceiling be reported `failed` by a watchdog that fired during its own stop.
/** @param {Run} run */
function disarmPause(run) {
  if (run.pauseTimer) clearTimeout(run.pauseTimer);
  run.pauseTimer = null;
  run.paused = false;
}

/**
 * Hold a run before its next action (US-079). False when there is nothing to
 * hold: a queued run has no process and no wall clock to suspend, a finished one
 * has nothing to say, and a second pause must not push the budget out — a client
 * polling the button would otherwise keep a run alive forever.
 *
 * `paused` is a flag and never a status, for US-047's reason: `TERMINAL` is what
 * `retention.js` reads to sweep a live run's artifacts and what `attachViewer`
 * reads to announce the end, and a paused run is still running.
 * @param {Run} run
 */
export function pauseRun(run) {
  if (!run || run.paused || run.cancelling || TERMINAL.has(run.status)) return false;
  const stdin = run.child?.stdin;
  if (!stdin || !stdin.writable) return false;

  run.paused = true;
  // Banked before the timer comes down, because after it there is nothing left
  // to read the remainder off.
  run.timeoutRemainingMs = Math.max(0, run.timeoutAt - Date.now());
  disarmWallClock(run);
  stdin.write(JSON.stringify({ cmd: 'pause' }) + '\n');

  // The pause's own bound. Without it, suspending the wall clock turns a
  // forgotten pause into a leaked browser, a leaked process and a held slot.
  // It escalates through `stopRun` so an abandoned run ends the way an abandoned
  // run should: `cancelled`, with the evidence it did gather.
  run.pauseDeadlineAt = Date.now() + PAUSE_MAX_MS;
  run.pauseTimer = setTimeout(() => {
    run.pauseTimer = null;
    if (TERMINAL.has(run.status)) return;
    const secs = Math.round(PAUSE_MAX_MS / 1000);
    console.error(`[pause ${run.id.slice(0, 8)}] paused for ${secs}s with no resume — cancelling`);
    stopRun(run);
  }, PAUSE_MAX_MS);
  run.pauseTimer.unref(); // the pause budget must never hold the process open

  broadcast(run, { type: 'paused', until: new Date(run.pauseDeadlineAt).toISOString() });
  return true;
}

/**
 * Let a paused run carry on (US-079), with the wall clock it had left.
 *
 * Not guaranteed to work, and deliberately not pretended otherwise: the tested
 * app's own session can expire while the run is held (US-043) and browser-use's
 * own note on `resume()` says the browser may be found closed. Either way the
 * agent fails the run on its next action, which is the honest ending.
 * @param {Run} run
 */
export function resumeRun(run) {
  if (!run || !run.paused || run.cancelling || TERMINAL.has(run.status)) return false;
  disarmPause(run);
  armWallClock(run, run.timeoutRemainingMs);
  const stdin = run.child?.stdin;
  if (stdin && stdin.writable) stdin.write(JSON.stringify({ cmd: 'resume' }) + '\n');
  broadcast(run, { type: 'resumed' });
  return true;
}

/**
 * Tell a live run what to do (US-079). The agent appends it to its own history
 * as a follow-up request, so the original goal survives and the run carries on
 * from the step it was on.
 *
 * A hint sent to a paused run also releases it, so the user types once. The
 * agent does the same on its side; both are independently correct and the order
 * on the wire is what matters — the text lands before the release.
 * @param {Run} run @param {string} text
 */
export function hintRun(run, text) {
  if (!run || run.cancelling || TERMINAL.has(run.status)) return false;
  const stdin = run.child?.stdin;
  if (!stdin || !stdin.writable) return false;
  stdin.write(JSON.stringify({ cmd: 'hint', text }) + '\n');
  const elapsed = run.startedAt ? (Date.now() - run.startedAt) / 1000 : 0;
  broadcast(run, { type: 'hint', text, elapsed: Math.round(elapsed * 10) / 10 });
  if (run.paused) resumeRun(run);
  return true;
}

/**
 * Stop a run early (US-047). False when there is nothing to stop — the run has
 * already reached a terminal status, or a stop is already in flight.
 *
 * Only the *intent* is recorded here; the status is left alone until the run
 * actually ends. `cancelled` is in TERMINAL, which `retention.js` reads to
 * decide a live run's artifacts may be swept and `attachViewer` reads to tell
 * viewers the run is over — so assigning it at request time would prune
 * `runs/<id>/` out from under a process that is still writing to it, and tell
 * everyone watching that a run they can still see moving has finished.
 * @param {Run} run
 */
export function stopRun(run) {
  if (!run || TERMINAL.has(run.status) || run.cancelling) return false;
  run.cancelling = true;
  // A paused run is stoppable, and this is also the path its own budget takes.
  // The wall clock stays down: browser-use's stop releases the pause event, so
  // the agent is on its way out, and a remainder re-armed here could report the
  // run `failed` in the middle of the stop that was already ending it.
  disarmPause(run);

  const queued = queue.indexOf(run.id);
  if (queued >= 0) queue.splice(queued, 1);

  // Nothing was spawned: a queued run, which never took a slot and so has none
  // to give back, or a demo replay (US-036), which has no process to signal.
  // Finish it here — the replay's pending timers then see a terminal status on
  // their next tick and stand down.
  if (!run.child) {
    finishCancelled(run);
    if (queued >= 0) startNext(); // everyone behind it moves up
    return true;
  }

  // Running: ask the agent to stop itself, over the stdin channel the screencast
  // already uses. browser-use checks the flag before every action within a step,
  // so this normally lands within one in-flight action — and `agent.run()` then
  // returns its history as usual, so run_agent.py's `finally` block finalizes
  // the recording and the report is still built. That is the whole point:
  // SIGKILL leaves an mp4 with no moov atom, unplayable, at exactly the moment
  // someone wanted to look at it.
  broadcast(run, { type: 'stopping' });
  const stdin = run.child.stdin;
  if (stdin && stdin.writable) stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');

  // The backstop, and the honest reason the hard path is not deleted: an agent
  // wedged inside an action never reaches the checkpoint, so the graceful route
  // is preferred, never trusted.
  run.stopTimer = setTimeout(() => {
    run.stopTimer = null;
    if (TERMINAL.has(run.status)) return;
    const secs = Math.round(STOP_GRACE_MS / 1000);
    console.error(`[stop ${run.id.slice(0, 8)}] agent did not stop within ${secs}s — killing tree`);
    killRunTree(run.child, processTree(run.child.pid).pids);
    // Stamped after the kill, and before the report so it renders as stopped
    // rather than as whatever it was mid-flight. `close` preserves it.
    run.status = 'cancelled';
    generateReport(run);
  }, STOP_GRACE_MS);
  run.stopTimer.unref(); // the grace window must never hold the process open

  return true;
}

// What this run leaves in its test's notebook (US-081), decided once the verdict
// is resolved and called from both terminal branches.
//
// Only a pass writes, and a run that did not pass changes nothing at all. An
// earlier draft marked the notebook suspect on a failure and withheld it from the
// next run; that was wrong, because the commonest reason a QA test fails is that
// it found the bug it exists to find, and the cold run it forced would then
// replace a notebook none of whose lessons had failed.
//
// Every passing run contributes whatever help it had — the shape of the write is
// what stops advice confirming itself, not silence, and `agent/run_memory.py`
// applied that shape before this row is touched.
/** @param {Run} run */
function recordMemory(run) {
  // An ad-hoc run has no test to remember anything, and a null fingerprint is a
  // run that was never offered a notebook — one started before this shipped.
  // Neither may write.
  if (run.status !== 'passed' || !run.test_id || !run.memory_fingerprint) return;

  // A pass that produced nothing usable must not reach the notebook: a vacuous
  // write would displace real lessons and read as freshly learned. This is also
  // the settled-test path — the agent skips the generator when its trace met no
  // incident, so `run.memory` is absent and the row keeps pointing at the run
  // that actually contributed.
  const learned = run.memory || {};
  if (Object.values(learned).some((section) => section?.length)) storeLearned(run, learned);
}

// End a run that has no process to wait for. The `close` handler's job, minus
// the slot bookkeeping it does not owe: nothing was spawned, so nothing was
// counted.
/** @param {Run} run */
function finishCancelled(run) {
  run.status = 'cancelled';
  // The other end: a queued run stopped before it ever spawned has no `close`
  // to reach. It has no session file either — startRun writes it — but calling
  // this is free and the alternative is a rule that holds only by coincidence.
  removeSessionFiles(run.id);
  run.queueEvent = null;
  run.finishedAt = Date.now();
  persistUpdate(run);
  broadcast(run, { type: 'end', status: 'cancelled' });
  maybeNotify(run);
  evictLater(run.id);
}

// What the feed says about this run's notebook, or nothing.
/** @param {Run} run */
function memoryNote(run) {
  if (run.memory_used) return 'Starting with what earlier runs of this test learned.';
  if (run.memory_withheld === 'inputs_changed') {
    return 'Running cold: the test changed, so what it learned before no longer applies.';
  }
  return null;
}

/** @param {string} runId */
function startRun(runId) {
  const run = getRun(runId);
  if (!run) return;
  active++;
  run.status = 'running';
  run.queueEvent = null;
  run.startedAt = Date.now();
  broadcast(run, { type: 'status', status: 'running' });
  // US-081. One line, before the first step, so somebody watching a run that
  // behaves oddly can see whether it was working from advice — and, when it was
  // not, why the advice this test holds is being kept back. Silent when there is
  // nothing to report: an ad-hoc run and a test that has never learned are the
  // ordinary cases, and a feed line for either would be noise on every run.
  const note = memoryNote(run);
  if (note) broadcast(run, { type: 'progress', message: note });
  persistUpdate(run);

  // BYOK (US-005/US-039): the run's resolved key is the only key, and this is
  // the only place it travels — into the child's env, nowhere else. Deleted
  // rather than left unset when there is none: the spread below carries the
  // server's own environment, so an absent key would silently inherit whatever
  // OPENAI_API_KEY this process happens to hold and fund the run out of the
  // operator's pocket at the one layer that actually spends money.
  /** @type {Record<string, string>} */
  const childEnv = {
    ...process.env,
    QA_GOAL: run.goal,
    QA_START_URL: run.start_url,
    QA_VARS: JSON.stringify(run.secrets || {}),
    QA_MAX_STEPS: String(run.max_steps),
    // The files this run may attach (US-048), read off the project's fixture
    // directory rather than from the DB: the list browser-use gates
    // `upload_file` and `read_file` on has to be the thing that actually
    // exists on disk. Always sent, even empty — absent and `[]` must be
    // distinguishable in the child, and only one of them is a statement.
    QA_FIXTURES: JSON.stringify(fixturePathsFor(run.project_id)),
    QA_RUN_ID: run.id,
    // US-043. A PATH, never the blob itself and never the parsed object:
    // `BrowserProfile.storage_state` is typed `str | Path | dict`, and in this
    // version a dict silently loads NOTHING — the file-loading validator is
    // commented out and the watchdog gates on `os.path.exists(str(load_path))`.
    // The run would then open a cold browser and fail exactly the way an
    // expired session fails, which is the other thing this story has to be able
    // to tell apart. Set below, so it is absent when there is no session.
    QA_INITIAL_ACTIONS: JSON.stringify(run.preamble || []),
    // US-044. Sent as '1'/'0' rather than left unset, for the same reason as
    // QA_FIXTURES: the spread below carries the server's own environment, and an
    // unsent variable would inherit whatever this process happens to hold.
    QA_HAR: run.har ? '1' : '0',
    // US-046. Sent as '1'/'0' for QA_HAR's reason, and with one of its own: the
    // agent turns this into `BROWSER_USE_CALCULATE_COST` before importing
    // browser-use, because that library ORs its kwarg with the environment. An
    // unsent variable would leave the decision to whatever this process holds.
    QA_CALCULATE_COST: CALCULATE_COST ? '1' : '0',
    // US-081. Both are *conditionally* set, and that is the difference from
    // QA_HAR and QA_CALCULATE_COST above: those always send a value because an
    // unsent variable would inherit the server's own environment. These two are
    // never in the server's environment, and an ad-hoc run must produce a spawn
    // identical to today's rather than one carrying an empty notebook. The
    // `delete` below is what makes the absent case absent rather than `''`.
    QA_MEMORY: run.memory_supplied ? JSON.stringify(run.memory_supplied) : '',
    // A saved test always learns; only an ad-hoc run, which has no test to
    // remember anything, does not. `memory_fingerprint` is null exactly there.
    QA_LEARN_MEMORY: run.memory_fingerprint ? '1' : '',
    BROWSER_USE_MODEL: run.model || MODEL,
    OPENAI_API_KEY: run.openai_api_key,
    ARTIFACTS_DIR,
    // US-042: the same policy the start_url was judged against, now arming
    // SecurityWatchdog inside the browser — which is what catches a redirect
    // from a permitted host to a blocked one. Always sent, even when every
    // setting is off: an unsent variable leaves the profile on browser-use's
    // own default, and its default for block_ip_addresses is False.
    ...agentEnvFor(run.policy || instancePolicy()),
  };
  if (!run.openai_api_key) delete childEnv.OPENAI_API_KEY;
  if (!childEnv.QA_MEMORY) delete childEnv.QA_MEMORY;
  if (!childEnv.QA_LEARN_MEMORY) delete childEnv.QA_LEARN_MEMORY;

  // The session's plaintext reaches disk here and only here, in a directory of
  // this run's own — teardown is `rm -rf` on that directory rather than an
  // unlink of this path, because browser-use rewrites the file we hand it and
  // leaves `.json.bak`/`.json.tmp` siblings holding the same credential.
  if (run.storage_state) {
    try {
      childEnv.QA_STORAGE_STATE = writeSessionFile(run.id, run.storage_state).path;
      if (run.session_verify) childEnv.QA_SESSION_VERIFY = JSON.stringify(run.session_verify);
    } catch (err) {
      // Refuse rather than run unauthenticated: a run that silently isn't
      // logged in fails its goal and blames the goal.
      const msg = `could not prepare the saved session: ${/** @type {any} */ (err).message}`;
      run.status = 'failed';
      run.result = { success: false, message: msg, failure_reason: 'session_expired' };
      active--;
      run.finishedAt = Date.now();
      persistUpdate(run);
      broadcast(run, { type: 'error', message: msg, failure_reason: 'session_expired' });
      broadcast(run, { type: 'end', status: run.status });
      removeSessionFiles(run.id);
      maybeNotify(run);
      startNext();
      evictLater(runId);
      return;
    }
  }
  // Where a login run writes what it captured. Inside the same per-run
  // directory, so the export is swept by the same teardown.
  if (run.capture_session_id) childEnv.QA_STORAGE_STATE_OUT = exportPathFor(run.id);

  const child = spawn(PYTHON_BIN, [AGENT_SCRIPT], {
    detached: true, // own process group, so the watchdog can kill the whole tree
    env: childEnv,
  });
  run.child = child;
  // Viewer may have attached while the run sat in the queue.
  if (run.subscribers.size > 0) setScreencast(run, true);

  // Memory watchdog: a leaky page can never starve the other runs on this
  // box. Over the cap => kill the tree; the normal 'close' path then emits
  // 'end' and starts the next queued run.
  run.memWatch = setInterval(() => {
    const { bytes, pids, fellBack } = processTree(child.pid);
    if (fellBack.length && !warnedRssFallback) {
      warnedRssFallback = true;
      console.warn(
        `[watchdog] /proc/<pid>/smaps_rollup unreadable — measuring RSS for ` +
          `${fellBack.length} of ${pids.length} processes, which over-reports ` +
          `Chromium's shared pages. MAX_RUN_MEMORY_MB is sized in PSS terms.`
      );
    }
    const mb = Math.round(bytes / (1024 * 1024));
    if (mb <= MAX_RUN_MEMORY_MB) return;
    clearInterval(run.memWatch);
    const msg = `resource limit exceeded: run used ${mb} MB (limit ${MAX_RUN_MEMORY_MB} MB)`;
    console.error(`[watchdog ${runId.slice(0, 8)}] ${msg} — killing ${pids.length} processes`);
    run.status = 'failed';
    run.result = { success: false, message: msg };
    broadcast(run, { type: 'error', message: msg });
    generateReport(run);
    killRunTree(child, pids);
  }, MEM_POLL_MS);

  // Wall-clock watchdog (US-005): MAX_STEPS bounds steps, not time. A stuck or
  // rate-limited (429-retrying) run — likely on a throttled BYOK key — would
  // otherwise squat a browser slot forever. Kill the tree at the ceiling and
  // report failed; the 'close' path then frees the slot for the next run.
  armWallClock(run, RUN_TIMEOUT_MS);

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      // A line that will not parse is still worth showing — as a log event,
      // which is a shape the viewer already renders.
      /** @type {RunEvent} */
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        evt = { type: 'log', message: line };
      }
      if (evt.type === 'recording') {
        // Always arrives before done/error, so the report can link it.
        run.recordingFile = evt.file;
      } else if (evt.type === 'memory') {
        // Held, not stored (US-081). Whether this run may write is a question
        // about the run's *ending* — stopped, edited underneath, or fine — and
        // none of that is known yet.
        run.memory = evt.learned;
      } else if (evt.type === 'done') {
        run.result = evt;
        // A stop decides the outcome, the agent does not (US-047). browser-use
        // returns history normally out of Agent.stop(), so this event still
        // carries a self-report — and honouring it would end an aborted run
        // `passed`, which is a green build in CI for a run nobody finished.
        // The event's payload is still kept: it is the partial evidence the
        // report is built from.
        run.status = run.cancelling
          ? 'cancelled'
          : evt.success === true
            ? 'passed'
            : evt.success === false
              ? 'failed'
              : 'completed';
        // A login run refreshes its session, and ONLY on a pass (US-043). Read
        // synchronously here, before `close` removes the directory; the DB
        // write is chained on `run.persisted` like every other write for this
        // run. A failed login run must not touch the stored blob — refreshing
        // is "run the login test again, nightly", so a failure is Tuesday, and
        // overwriting on one would replace a working session with an anonymous
        // browser's empty jar and turn the whole project red for a reason that
        // points at the wrong thing.
        if (run.capture_session_id && run.status === 'passed') {
          const exported = readExportedState(run.id);
          if (exported) captureSession(run, exported);
        }
        recordMemory(run);
        generateReport(run);
      } else if (evt.type === 'error') {
        run.result = evt;
        run.status = run.cancelling ? 'cancelled' : 'error';
        recordMemory(run);
        generateReport(run);
      }
      broadcast(run, evt);
    }
  });

  // browser-use logs heavily to stderr — keep it off the live feed, send to
  // the server console for debugging only.
  child.stderr.on('data', (d) => process.stderr.write(`[agent ${runId.slice(0, 8)}] ${d}`));

  child.on('close', (code) => {
    active--;
    // The session's plaintext goes here, and this is the one funnel every way a
    // run can end passes through: a clean agent exit, either watchdog's kill, a
    // stop, and a spawn that failed outright. Tearing down in the `done`
    // handler instead would look correct and leave a credential on disk after
    // all four of the others.
    removeSessionFiles(run.id);
    clearInterval(run.memWatch);
    disarmWallClock(run);
    // Same hazard as the grace window below, reached by the pause: a budget
    // still counting down after the run has ended calls stopRun on a dead run.
    disarmPause(run);
    // An armed grace window outlives the pid it was going to kill, and
    // killRunTree's group kill would then take whatever inherited that pid.
    if (run.stopTimer) {
      clearTimeout(run.stopTimer);
      run.stopTimer = null;
    }
    // The intent outranks the exit code: an agent killed for ignoring a stop
    // exits non-zero, and reporting that as `error` is a build failure and a
    // US-012 alert for something the user did on purpose.
    if (!TERMINAL.has(run.status)) {
      run.status = run.cancelling ? 'cancelled' : code === 0 ? 'completed' : 'error';
    }
    run.finishedAt = Date.now();
    persistUpdate(run);
    broadcast(run, { type: 'end', status: run.status, code });
    maybeNotify(run);
    startNext();
    evictLater(runId);
  });
}

function startNext() {
  if (!anyCapInForce()) {
    // Nothing capped anywhere: byte-for-byte the pre-US-028 FIFO drain. The
    // test is "is any cap in force", not "is the env set" (US-058) — an
    // override on an instance with no default is exactly what the latter would
    // swallow, cap and all.
    while (active < MAX_CONCURRENT && queue.length) startRun(queue.shift());
  } else {
    // Fair-share (US-028): promote the first queued run whose owner is under
    // their running cap, not simply the head — otherwise a user who queued a
    // burst early would still drain the worker in order. A linear scan over a
    // small queue; deliberately not a scheduler. A slot may be left idle when
    // the only waiters are users already at their cap.
    while (active < MAX_CONCURRENT) {
      const i = queue.findIndex((id) => {
        const run = getRun(id);
        return run && canStart(run);
      });
      if (i === -1) break;
      startRun(queue.splice(i, 1)[0]);
    }
  }
  // Everyone still waiting moved up — tell them, so "2 ahead of you" counts
  // down in place rather than only on reload.
  queue.forEach((id, position) => {
    const run = getRun(id);
    if (run) setQueuePosition(run, position);
  });
}
