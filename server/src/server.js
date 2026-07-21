// Express REST API + WebSocket relay for the QA agent prototype.
//
// Flow: POST /api/runs spawns agent/run_agent.py as a child process. The
// script prints NDJSON events to stdout; we parse each line and broadcast it
// to any WebSocket clients watching that run. The React viewer renders the
// screenshots live.

import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8080', 10);
const API_TOKEN = process.env.WORKER_API_TOKEN || '';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '4', 10);
const DEFAULT_MAX_STEPS = parseInt(process.env.MAX_STEPS || '60', 10);
const RUN_TTL_MS = parseInt(process.env.RUN_TTL_SECONDS || '3600', 10) * 1000;
const MAX_RUN_MEMORY_MB = parseInt(process.env.MAX_RUN_MEMORY_MB || '1200', 10);
const MEM_POLL_MS = 3000;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, '..', '..', 'agent');
const AGENT_SCRIPT = process.env.AGENT_SCRIPT || path.join(AGENT_DIR, 'run_agent.py');
const REPORT_SCRIPT = process.env.REPORT_SCRIPT || path.join(AGENT_DIR, 'make_report.py');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(__dirname, '..', '..', 'runs');
const MODEL = process.env.BROWSER_USE_MODEL || 'gpt-4.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// --- in-memory run registry (worker is stateless across restarts) ---
/** @type {Map<string, any>} */
const runs = new Map();
let active = 0;
const queue = [];

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

const TERMINAL = new Set(['passed', 'failed', 'completed', 'error']);

// Tell the agent whether anyone is watching: it only captures screencast
// frames while a viewer is attached (saves Chromium encode CPU otherwise).
function setScreencast(run, on) {
  const stdin = run.child?.stdin;
  if (stdin && stdin.writable) {
    stdin.write(JSON.stringify({ cmd: 'screencast', on }) + '\n');
  }
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

  const child = spawn(PYTHON_BIN, [AGENT_SCRIPT], {
    detached: true, // own process group, so the watchdog can kill the whole tree
    env: {
      ...process.env,
      QA_GOAL: run.goal,
      QA_START_URL: run.start_url,
      QA_MAX_STEPS: String(run.max_steps),
      QA_RUN_ID: run.id,
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
      if (evt.type === 'done') {
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
    broadcast(run, { type: 'end', status: run.status, code });
    startNext();
    setTimeout(() => runs.delete(runId), RUN_TTL_MS);
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
    model: MODEL,
    status: run.status,
    success: res.success ?? null,
    duration_seconds: res.duration_seconds ?? null,
    steps_count: res.steps ?? run.events.filter((e) => e.type === 'step').length,
    final_result: res.final_result ?? res.message ?? null,
    errors: res.errors ?? (res.message ? [res.message] : []),
    recording_url: null, // wired up when recordings are hosted
    generated_at: new Date().toISOString(),
    steps: run.events
      .filter((e) => e.type === 'step')
      .map((e) => ({
        step: e.step,
        elapsed: e.elapsed,
        next_goal: e.next_goal,
        evaluation: e.evaluation,
        url: e.url,
        screenshot_file: e.screenshot_file,
      })),
  };
  const dataPath = path.join(runDir, 'report_data.json');
  const pdfPath = path.join(runDir, 'report.pdf');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  const child = spawn(PYTHON_BIN, [REPORT_SCRIPT, dataPath, pdfPath]);
  child.stderr.on('data', (d) => process.stderr.write(`[report ${run.id.slice(0, 8)}] ${d}`));
  child.on('close', (code) => {
    run.reportStatus = code === 0 && fs.existsSync(pdfPath) ? 'ready' : 'error';
    run.reportPath = pdfPath;
    console.log(`report ${run.id.slice(0, 8)}: ${run.reportStatus}`);
  });
}

// --- HTTP ---
const app = express();
app.use(express.json({ limit: '1mb' }));

function checkToken(req, res, next) {
  if (!API_TOKEN) return next(); // no token configured => open (dev only)
  if (req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, active, queued: queue.length, max_concurrent: MAX_CONCURRENT });
});

app.post('/api/runs', checkToken, (req, res) => {
  const { goal, start_url, max_steps } = req.body || {};
  if (!goal || !start_url) {
    return res.status(400).json({ error: 'goal and start_url are required' });
  }
  const runId = randomUUID();
  runs.set(runId, {
    id: runId,
    goal,
    start_url,
    max_steps: Number(max_steps) || DEFAULT_MAX_STEPS,
    status: 'queued',
    events: [],
    subscribers: new Set(),
    result: null,
    createdAt: Date.now(),
  });
  if (active < MAX_CONCURRENT) startRun(runId);
  else queue.push(runId);
  res.json({ runId, status: runs.get(runId).status });
});

app.get('/api/runs/:id', checkToken, (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({
    runId: run.id,
    status: run.status,
    goal: run.goal,
    start_url: run.start_url,
    result: run.result,
    eventCount: run.events.length,
  });
});

app.get('/api/runs/:id/report.pdf', checkToken, (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const pdfPath = run.reportPath || path.join(ARTIFACTS_DIR, run.id, 'report.pdf');
  if (run.reportStatus === 'ready' && fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="qagent-report-${run.id.slice(0, 8)}.pdf"`);
    return res.sendFile(pdfPath);
  }
  if (run.reportStatus === 'generating') return res.status(202).json({ status: 'generating' });
  if (run.reportStatus === 'error') return res.status(500).json({ error: 'report generation failed' });
  return res.status(404).json({ error: 'no report (run not finished?)' });
});

app.use(express.static(PUBLIC_DIR));
// SPA fallback: anything not matched above returns the React app.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

// --- WebSocket live feed ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token') || '';
  if (API_TOKEN && token !== API_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const runId = url.searchParams.get('runId');
  const run = runs.get(runId);
  if (!run) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    run.subscribers.add(ws);
    if (run.subscribers.size === 1) setScreencast(run, true);
    // Replay durable events, then the latest frame, then live updates follow.
    for (const evt of run.events) ws.send(JSON.stringify(evt));
    if (run.lastFrame) ws.send(JSON.stringify(run.lastFrame));
    if (TERMINAL.has(run.status)) ws.send(JSON.stringify({ type: 'end', status: run.status }));
    ws.on('close', () => {
      run.subscribers.delete(ws);
      if (run.subscribers.size === 0) setScreencast(run, false);
    });
  });
});

server.listen(PORT, () => {
  console.log(`qagent server on :${PORT}  (max_concurrent=${MAX_CONCURRENT}, auth=${API_TOKEN ? 'on' : 'off'})`);
});
