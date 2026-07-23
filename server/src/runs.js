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
import { db, getOperatorUserId } from './db.js';
import {
  MAX_CONCURRENT,
  DEFAULT_MAX_STEPS,
  RUN_TTL_MS,
  MAX_RUN_MEMORY_MB,
  MEM_POLL_MS,
  PYTHON_BIN,
  AGENT_SCRIPT,
  REPORT_SCRIPT,
  ARTIFACTS_DIR,
  MODEL,
  PUBLIC_BASE_URL,
  REPORT_DATA_FILENAME,
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

// Tell the agent whether anyone is watching: it only captures screencast
// frames while a viewer is attached (saves Chromium encode CPU otherwise).
function setScreencast(run, on) {
  const stdin = run.child?.stdin;
  if (stdin && stdin.writable) {
    stdin.write(JSON.stringify({ cmd: 'screencast', on }) + '\n');
  }
}

// --- persistence (fire-and-forget: the live relay never waits on the DB) ---

function persistInsert(run) {
  if (!db()) return;
  db()
    .query(
      `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, model, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      ]
    )
    .catch((err) => console.error(`db: insert run ${run.id.slice(0, 8)} failed:`, err.message));
}

function persistUpdate(run) {
  if (!db()) return;
  const res = run.result || {};
  const failedOrError = run.status === 'error' || run.status === 'failed';
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
}

// --- run lifecycle ---

/**
 * Enqueue a run (starts immediately when under the concurrency cap).
 * @param {{ goal: string, start_url: string, max_steps?: number,
 *           model?: string | null, test_id?: string | null,
 *           trigger?: string }} fields
 */
export function createRun(fields) {
  const runId = randomUUID();
  const run = {
    id: runId,
    goal: fields.goal,
    start_url: fields.start_url,
    max_steps: Number(fields.max_steps) || DEFAULT_MAX_STEPS,
    model: fields.model || null,
    test_id: fields.test_id || null,
    user_id: getOperatorUserId(),
    trigger: fields.trigger || 'api',
    status: 'queued',
    events: [],
    subscribers: new Set(),
    result: null,
    createdAt: Date.now(),
  };
  runs.set(runId, run);
  persistInsert(run);
  if (active < MAX_CONCURRENT) startRun(runId);
  else queue.push(runId);
  return run;
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
  run.startedAt = Date.now();
  broadcast(run, { type: 'status', status: 'running' });
  persistUpdate(run);

  const child = spawn(PYTHON_BIN, [AGENT_SCRIPT], {
    detached: true, // own process group, so the watchdog can kill the whole tree
    env: {
      ...process.env,
      QA_GOAL: run.goal,
      QA_START_URL: run.start_url,
      QA_MAX_STEPS: String(run.max_steps),
      QA_RUN_ID: run.id,
      BROWSER_USE_MODEL: run.model || MODEL,
      ARTIFACTS_DIR,
    },
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
    if (!TERMINAL.has(run.status)) run.status = code === 0 ? 'completed' : 'error';
    run.finishedAt = Date.now();
    persistUpdate(run);
    broadcast(run, { type: 'end', status: run.status, code });
    startNext();
    // unref: an expiry timer must never hold the process open (e.g. in tests)
    setTimeout(() => runs.delete(runId), RUN_TTL_MS).unref();
  });
}

function startNext() {
  while (active < MAX_CONCURRENT && queue.length) startRun(queue.shift());
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
  });
}

/**
 * Subscribe a WebSocket to a run's live feed: replay durable events, then
 * the latest frame, then live updates follow.
 */
export function attachViewer(run, ws) {
  run.subscribers.add(ws);
  if (run.subscribers.size === 1) setScreencast(run, true);
  for (const evt of run.events) ws.send(JSON.stringify(evt));
  if (run.lastFrame) ws.send(JSON.stringify(run.lastFrame));
  if (TERMINAL.has(run.status)) ws.send(JSON.stringify({ type: 'end', status: run.status }));
  ws.on('close', () => {
    run.subscribers.delete(ws);
    if (run.subscribers.size === 0) setScreencast(run, false);
  });
}
