// @ts-check
// Run engine: spawns agent/run_agent.py per run, relays its NDJSON events to
// WebSocket subscribers, enforces the memory watchdog, renders the PDF
// report. The in-memory Map is the live relay; when the control plane is
// configured (db.js) every run is also persisted to the runs table, which is
// the source of truth for finished runs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, currentUserId } from './db.js';
import { demoMode } from './auth.js';
import { loadDemo, fixtureForRun, recordingPath, reportPath } from './demo.js';
import { notifyRunFinished } from './notify.js';
import { resolveForRun } from './variables.js';
import {
  MAX_CONCURRENT,
  MAX_CONCURRENT_PER_USER,
  DEFAULT_MAX_STEPS,
  RUN_TTL_MS,
  MAX_RUN_MEMORY_MB,
  MEM_POLL_MS,
  RUN_TIMEOUT_MS,
  PYTHON_BIN,
  AGENT_SCRIPT,
  REPORT_SCRIPT,
  ARTIFACTS_DIR,
  MODEL,
  PUBLIC_BASE_URL,
  RECORDING_FILENAME,
  REPORT_DATA_FILENAME,
  DEMO_SPEED,
} from './config.js';

// --- in-memory run registry (live relay; DB holds the durable copy) ---
/** @type {Map<string, any>} */
const runs = new Map();
let active = 0;
/** @type {string[]} */
const queue = [];

export const TERMINAL = new Set(['passed', 'failed', 'completed', 'error']);

export function getRun(runId) {
  return runs.get(runId);
}

export function counts() {
  return { active, queued: queue.length };
}

// --- per-user concurrency cap (US-028) ---
// Accounting is in-memory, scanned off the live registry: correct for one
// worker, and deliberately not a distributed counter — enforcing the cap across
// a fleet is US-015's shared-state problem, not this story's.

/**
 * The concurrent-run cap for a user, or null when uncapped (env unset = off).
 * Resolved through a function, not the bare constant, so US-022 can turn it into
 * a per-plan lookup without threading a new argument through the run engine.
 * The `userId` is unused in v1 — every user on the box gets the same number.
 * @param {string|null} userId
 * @returns {number | null}
 */
export function getUserConcurrencyCap(userId) {
  void userId;
  return MAX_CONCURRENT_PER_USER;
}

/** How many of a user's runs are running OR queued — what admission counts. */
function inFlightForUser(uid) {
  let n = 0;
  for (const run of runs.values()) {
    if (run.user_id === uid && (run.status === 'running' || run.status === 'queued')) n++;
  }
  return n;
}

/** How many of a user's runs are running — what the start-gate and dequeue count. */
function runningForUser(uid) {
  let n = 0;
  for (const run of runs.values()) {
    if (run.user_id === uid && run.status === 'running') n++;
  }
  return n;
}

// A run may start when a global slot is free AND its owner is under their
// running cap. The second clause is what holds a user (or a scheduled burst
// that bypassed admission) to `cap` running even when global slots are free.
function canStart(run) {
  if (active >= MAX_CONCURRENT) return false;
  const cap = getUserConcurrencyCap(run.user_id);
  return cap == null || runningForUser(run.user_id) < cap;
}

/**
 * A run's activity in the one shape everything reads it in: the report file,
 * the PDF renderer and `GET /api/runs/:id/steps` (US-026), whether it comes
 * from the live buffer or from report_data.json. `progress` events are left
 * out — they carry no step number, and the report's step section is keyed on
 * one, so they stay live-only in the Run view's stream.
 */
export function stepsOf(run) {
  return run.events
    .filter((e) => e.type === 'step')
    .map((e) => ({
      step: e.step,
      elapsed: e.elapsed,
      next_goal: e.next_goal,
      evaluation: e.evaluation,
      url: e.url,
      screenshot_file: e.screenshot_file,
    }));
}

function send(run, evt) {
  const data = JSON.stringify(evt);
  for (const ws of run.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Durable events are buffered for replay; screencast frames are live-only
// (we keep just the most recent one so a late viewer sees something immediately).
function broadcast(run, evt) {
  if (evt.type === 'frame') {
    run.lastFrame = evt;
    send(run, evt);
    return;
  }
  run.events.push(evt);
  send(run, evt);
}

// A waiting run's place in the FIFO (0 = next to start). Live-only, like
// frames: it changes every time the queue drains, so replaying it out of
// `run.events` would make a late viewer watch a countdown that already
// happened. Each waiting run keeps just its current one and `attachViewer`
// sends that.
function setQueuePosition(run, position) {
  run.queueEvent = { type: 'status', status: 'queued', position, concurrency: MAX_CONCURRENT };
  send(run, run.queueEvent);
}

// Tell the agent whether anyone is watching: it only captures screencast
// frames while a viewer is attached (saves Chromium encode CPU otherwise).
function setScreencast(run, on) {
  const stdin = run.child?.stdin;
  if (stdin && stdin.writable) {
    stdin.write(JSON.stringify({ cmd: 'screencast', on }) + '\n');
  }
}

// --- persistence (fire-and-forget: the live relay never waits on the DB) ---

// Writes for one run are chained on `run.persisted` so they reach the DB in
// program order. They are still fire-and-forget from the request's point of
// view — nothing awaits the chain — but each query only issues once the
// previous one has resolved. Without this, `persistInsert` and the `running`
// `persistUpdate` fired back-to-back in `createRun`/`startRun` are two
// independent pool queries: the UPDATE can reach a connection before the
// INSERT commits, match zero rows, and leave the row stuck at `queued`.
function persistInsert(run) {
  if (!db()) return;
  run.persisted = db()
    .query(
      `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, model, status, variables)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        run.id,
        run.test_id,
        run.user_id,
        run.trigger,
        run.goal,
        run.start_url,
        run.max_steps,
        run.model,
        run.status,
        JSON.stringify(run.variables || {}),
      ]
    )
    .catch((err) => console.error(`db: insert run ${run.id.slice(0, 8)} failed:`, err.message));
}

function persistUpdate(run) {
  if (!db()) return;
  const res = run.result || {};
  const failedOrError = run.status === 'error' || run.status === 'failed';
  const update = () =>
    db()
      .query(
        `update runs
            set status        = $2,
                success       = $3,
                final_result  = $4,
                error         = $5,
                steps_count   = $6,
                started_at    = $7,
                finished_at   = $8,
                report_status = $9,
                has_recording = $10
          where id = $1`,
        [
          run.id,
          run.status,
          res.success ?? null,
          res.final_result ?? res.message ?? null,
          failedOrError ? res.message ?? null : null,
          res.steps ?? run.events.filter((e) => e.type === 'step').length,
          run.startedAt ? new Date(run.startedAt) : null,
          run.finishedAt ? new Date(run.finishedAt) : null,
          run.reportStatus || 'none',
          !!run.recordingFile,
        ]
      )
      .catch((err) => console.error(`db: update run ${run.id.slice(0, 8)} failed:`, err.message));
  run.persisted = (run.persisted || Promise.resolve()).then(update);
}

// A run is mailable (US-012) once it has finished *and* the report it would
// attach has stopped changing. Those two arrive in either order — the renderer
// usually outlives the agent process, but a watchdog kill doesn't wait for it —
// so both paths call this and whichever completes the pair wins. The flag is
// belt and braces over the notifications table's own (run_id, recipient) key.
function maybeNotify(run) {
  if (run.notified || !run.finishedAt || run.reportStatus === 'generating') return;
  run.notified = true;
  notifyRunFinished(run).catch((err) =>
    console.error(`notify ${run.id.slice(0, 8)} failed:`, err.message)
  );
}

// --- run lifecycle ---

/**
 * Enqueue a run (starts immediately when under the concurrency cap). Returns
 * the run, or — when the caller is over their per-user cap (US-028) and the
 * submit isn't a schedule/demo replay — a `{ rejected, cap, inFlight }` marker
 * and no run: nothing is inserted or queued. Callers branch with `'rejected' in`.
 * @param {{ goal: string, start_url: string, max_steps?: number,
 *           model?: string | null, test_id?: string | null,
 *           trigger?: string, variables?: Record<string, string>,
 *           secrets?: Record<string, string>, user_id?: string | null,
 *           openai_api_key?: string | null }} fields
 */
export function createRun(fields) {
  // Explicit user_id for the scheduler (no request context); a request-borne run
  // falls back to the caller resolved by the gate (currentUserId()).
  const uid = fields.user_id ?? currentUserId();
  const trigger = fields.trigger || 'api';
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

  const runId = randomUUID();
  const run = {
    id: runId,
    goal: fields.goal,
    start_url: fields.start_url,
    max_steps: Number(fields.max_steps) || DEFAULT_MAX_STEPS,
    model: fields.model || null,
    test_id: fields.test_id || null,
    variables: fields.variables || {},
    // Real secret values, in-memory only — handed to the agent via QA_VARS in
    // startRun and deliberately never persisted or serialized (US-035).
    secrets: fields.secrets || {},
    // BYOK key (US-005): request- or account-resolved, in-memory only. Handed to
    // the agent as OPENAI_API_KEY in startRun; never a column, an event, or an
    // artifact — persistInsert/broadcast/generateReport never read this field.
    openai_api_key: fields.openai_api_key || null,
    user_id: uid,
    trigger,
    status: 'queued',
    events: [],
    subscribers: new Set(),
    result: null,
    createdAt: Date.now(),
  };
  runs.set(runId, run);
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
 * @param {{ id: string, goal: string, start_url: string, max_steps: number, model: string|null, variables?: any }[]} tests
 * @param {{ start_url?: string|null, trigger?: string, variables?: Record<string, string>, user_id?: string|null, openai_api_key?: string|null }} [opts]
 */
export function runTests(tests, opts = {}) {
  return tests.map((t) => {
    const resolved = resolveForRun({
      variables: t.variables || [],
      overrides: opts.variables,
      goal: t.goal,
      start_url: opts.start_url || t.start_url,
    });
    if ('error' in resolved) return { testId: t.id, error: resolved.error };
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
    });
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

// A run is one Python parent plus a dozen-odd Chromium processes, so memory
// accounting must cover the whole tree. Walk /proc (Linux-only, like our
// Docker base image) and sum RSS over the root pid's descendants; the pid
// list doubles as the kill list.
function processTree(rootPid) {
  const procs = new Map(); // pid -> { ppid, rssPages }
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return { rssBytes: 0, pids: [] };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; parse after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), { ppid: Number(rest[1]), rssPages: Number(rest[21]) });
    } catch {
      /* process exited mid-scan */
    }
  }
  const pids = [];
  let rssPages = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    const p = procs.get(pid);
    if (!p) continue;
    pids.push(pid);
    rssPages += p.rssPages;
    for (const [childPid, c] of procs) {
      if (c.ppid === pid) stack.push(childPid);
    }
  }
  return { rssBytes: rssPages * 4096, pids };
}

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

function startRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  active++;
  run.status = 'running';
  run.queueEvent = null;
  run.startedAt = Date.now();
  broadcast(run, { type: 'status', status: 'running' });
  persistUpdate(run);

  // BYOK (US-005/US-039): the run's resolved key is the only key, and this is
  // the only place it travels — into the child's env, nowhere else. Deleted
  // rather than left unset when there is none: the spread below carries the
  // server's own environment, so an absent key would silently inherit whatever
  // OPENAI_API_KEY this process happens to hold and fund the run out of the
  // operator's pocket at the one layer that actually spends money.
  const childEnv = {
    ...process.env,
    QA_GOAL: run.goal,
    QA_START_URL: run.start_url,
    QA_VARS: JSON.stringify(run.secrets || {}),
    QA_MAX_STEPS: String(run.max_steps),
    QA_RUN_ID: run.id,
    BROWSER_USE_MODEL: run.model || MODEL,
    OPENAI_API_KEY: run.openai_api_key,
    ARTIFACTS_DIR,
  };
  if (!run.openai_api_key) delete childEnv.OPENAI_API_KEY;

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
    const { rssBytes, pids } = processTree(child.pid);
    const mb = Math.round(rssBytes / (1024 * 1024));
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
  run.timeoutWatch = setTimeout(() => {
    clearInterval(run.memWatch);
    const secs = Math.round(RUN_TIMEOUT_MS / 1000);
    const msg = `run exceeded the ${secs}s time limit and was stopped`;
    console.error(`[watchdog ${runId.slice(0, 8)}] ${msg}`);
    run.status = 'failed';
    run.result = { success: false, message: msg };
    broadcast(run, { type: 'error', message: msg });
    generateReport(run);
    killRunTree(child, processTree(child.pid).pids);
  }, RUN_TIMEOUT_MS);
  run.timeoutWatch.unref(); // never hold the process open for the ceiling alone

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        evt = { type: 'log', message: line };
      }
      if (evt.type === 'recording') {
        // Always arrives before done/error, so the report can link it.
        run.recordingFile = evt.file;
      } else if (evt.type === 'done') {
        run.result = evt;
        run.status = evt.success === true ? 'passed' : evt.success === false ? 'failed' : 'completed';
        generateReport(run);
      } else if (evt.type === 'error') {
        run.result = evt;
        run.status = 'error';
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
    clearInterval(run.memWatch);
    clearTimeout(run.timeoutWatch);
    if (!TERMINAL.has(run.status)) run.status = code === 0 ? 'completed' : 'error';
    run.finishedAt = Date.now();
    persistUpdate(run);
    broadcast(run, { type: 'end', status: run.status, code });
    maybeNotify(run);
    startNext();
    // unref: an expiry timer must never hold the process open (e.g. in tests)
    setTimeout(() => runs.delete(runId), RUN_TTL_MS).unref();
  });
}

// --- demo replay (US-036): the no-cost stand-in for startRun ---

// Drive a run from a checked-in fixture instead of a Python agent: no spawn, no
// `active++`, no queue. Events replay over the same relay a real run uses, so
// the Run stage and history need no second code path. The fixture is chosen to
// match the test; its recording/PDF are symlinked (not copied) into the run dir
// so the normal media routes serve them and the reaper's rm -rf reclaims them.
function startReplay(run) {
  const slug = fixtureForRun(run);
  const demo = loadDemo(slug);
  run.startedAt = Date.now();
  run.status = 'running';
  broadcast(run, { type: 'status', status: 'running' });
  persistUpdate(run);

  if (!demo) {
    // No usable fixture at all — finish clean so the row still reaches terminal
    // rather than hanging at 'running'.
    finishReplay(run);
    return;
  }
  run.demoSlug = slug;
  linkFixtureArtifacts(run, slug);

  // A demo run has no live screencast — the fixture's recording *is* the stage
  // feed. Announce it up front (durable, so a viewer connecting mid-replay still
  // gets it) so the frontend plays the video from the start instead of waiting
  // on frames that never arrive. `demo: true` tells it to show the video live
  // rather than only offering it as a post-run button.
  if (run.recordingFile) broadcast(run, { type: 'recording', demo: true });

  let last = 0;
  for (const { offset_ms, ...evt } of demo.events) {
    const at = Math.max(0, Number(offset_ms) || 0) / DEMO_SPEED;
    last = Math.max(last, at);
    setTimeout(() => applyReplayEvent(run, evt), at).unref();
  }
  setTimeout(() => finishReplay(run), last).unref();
}

// Same event handling as startRun's stdout loop: a fixture's `done`/`error`
// carries the verdict that sets the terminal status; everything else is relayed.
function applyReplayEvent(run, evt) {
  if (TERMINAL.has(run.status)) return; // a later timer after finishReplay: ignore
  if (evt.type === 'done') {
    run.result = evt;
    run.status = evt.success === true ? 'passed' : evt.success === false ? 'failed' : 'completed';
  } else if (evt.type === 'error') {
    run.result = evt;
    run.status = 'error';
  }
  broadcast(run, evt);
}

function finishReplay(run) {
  if (!TERMINAL.has(run.status)) run.status = 'completed';
  run.finishedAt = Date.now();
  run.reportStatus = run.reportReady ? 'ready' : 'none';
  persistUpdate(run);
  broadcast(run, { type: 'end', status: run.status, demo: true });
  maybeNotify(run);
  setTimeout(() => runs.delete(run.id), RUN_TTL_MS).unref();
}

// Symlink the fixture's shared recording/PDF into runs/<id>/ so /api/runs/:id/
// {recording,report.pdf} serve them unchanged. Symlink, not copy: the fixture
// stays the single shared source, and the reaper's rm -rf runs/<id> removes only
// the links. Best-effort — a run row is honest about what actually linked.
function linkFixtureArtifacts(run, slug) {
  const runDir = path.join(ARTIFACTS_DIR, run.id);
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch {
    /* dir may already exist */
  }
  const rec = recordingPath(slug);
  if (rec) {
    try {
      fs.symlinkSync(rec, path.join(runDir, RECORDING_FILENAME));
      run.recordingFile = path.join(runDir, RECORDING_FILENAME);
    } catch {
      /* leaves has_recording false */
    }
  }
  const rep = reportPath(slug);
  if (rep) {
    try {
      fs.symlinkSync(rep, path.join(runDir, 'report.pdf'));
      run.reportReady = true;
    } catch {
      /* leaves report_status none */
    }
  }
}

function startNext() {
  if (MAX_CONCURRENT_PER_USER == null) {
    // No per-user cap: byte-for-byte the pre-US-028 FIFO drain.
    while (active < MAX_CONCURRENT && queue.length) startRun(queue.shift());
  } else {
    // Fair-share (US-028): promote the first queued run whose owner is under
    // their running cap, not simply the head — otherwise a user who queued a
    // burst early would still drain the worker in order. A linear scan over a
    // small queue; deliberately not a scheduler. A slot may be left idle when
    // the only waiters are users already at their cap.
    while (active < MAX_CONCURRENT) {
      const i = queue.findIndex((id) => {
        const run = runs.get(id);
        return run && canStart(run);
      });
      if (i === -1) break;
      startRun(queue.splice(i, 1)[0]);
    }
  }
  // Everyone still waiting moved up — tell them, so "2 ahead of you" counts
  // down in place rather than only on reload.
  queue.forEach((id, position) => {
    const run = runs.get(id);
    if (run) setQueuePosition(run, position);
  });
}

// Build the run's data JSON and render it to a PDF via the Python renderer
// (which reuses the installed Chromium). Runs once per finished run.
function generateReport(run) {
  if (run.reportStatus === 'generating' || run.reportStatus === 'ready') return;
  run.reportStatus = 'generating';
  const runDir = path.join(ARTIFACTS_DIR, run.id);
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch {
    /* dir may already exist from screenshots */
  }
  const res = run.result || {};
  const data = {
    runId: run.id,
    goal: run.goal,
    start_url: run.start_url,
    model: run.model || MODEL,
    status: run.status,
    success: res.success ?? null,
    duration_seconds: res.duration_seconds ?? null,
    steps_count: res.steps ?? run.events.filter((e) => e.type === 'step').length,
    final_result: res.final_result ?? res.message ?? null,
    errors: res.errors ?? (res.message ? [res.message] : []),
    has_recording: !!run.recordingFile,
    // A PDF can only link a recording that has a public address; without one
    // the report says "recorded" and the app serves the video itself.
    recording_url:
      run.recordingFile && PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}/api/runs/${run.id}/recording`
        : null,
    generated_at: new Date().toISOString(),
    steps: stepsOf(run),
  };
  const dataPath = path.join(runDir, REPORT_DATA_FILENAME);
  const pdfPath = path.join(runDir, 'report.pdf');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  const child = spawn(PYTHON_BIN, [REPORT_SCRIPT, dataPath, pdfPath]);
  child.stderr.on('data', (d) => process.stderr.write(`[report ${run.id.slice(0, 8)}] ${d}`));
  child.on('close', (code) => {
    run.reportStatus = code === 0 && fs.existsSync(pdfPath) ? 'ready' : 'error';
    run.reportPath = pdfPath;
    persistUpdate(run);
    console.log(`report ${run.id.slice(0, 8)}: ${run.reportStatus}`);
    maybeNotify(run);
  });
}

/**
 * Subscribe a WebSocket to a run's live feed: replay durable events, then the
 * live-only state (queue position, latest frame), then live updates follow.
 */
export function attachViewer(run, ws) {
  run.subscribers.add(ws);
  if (run.subscribers.size === 1) setScreencast(run, true);
  for (const evt of run.events) ws.send(JSON.stringify(evt));
  if (run.queueEvent) ws.send(JSON.stringify(run.queueEvent));
  if (run.lastFrame) ws.send(JSON.stringify(run.lastFrame));
  if (TERMINAL.has(run.status)) ws.send(JSON.stringify({ type: 'end', status: run.status }));
  ws.on('close', () => {
    run.subscribers.delete(ws);
    if (run.subscribers.size === 0) setScreencast(run, false);
  });
}
