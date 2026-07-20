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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8080', 10);
const API_TOKEN = process.env.WORKER_API_TOKEN || '';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '4', 10);
const DEFAULT_MAX_STEPS = parseInt(process.env.MAX_STEPS || '60', 10);
const RUN_TTL_MS = parseInt(process.env.RUN_TTL_SECONDS || '3600', 10) * 1000;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const AGENT_SCRIPT =
  process.env.AGENT_SCRIPT || path.join(__dirname, '..', '..', 'agent', 'run_agent.py');
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

function startRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  active++;
  run.status = 'running';
  run.startedAt = Date.now();
  broadcast(run, { type: 'status', status: 'running' });

  const child = spawn(PYTHON_BIN, [AGENT_SCRIPT], {
    env: {
      ...process.env,
      QA_GOAL: run.goal,
      QA_START_URL: run.start_url,
      QA_MAX_STEPS: String(run.max_steps),
    },
  });
  run.child = child;

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
      } else if (evt.type === 'error') {
        run.result = evt;
        run.status = 'error';
      }
      broadcast(run, evt);
    }
  });

  // browser-use logs heavily to stderr — keep it off the live feed, send to
  // the server console for debugging only.
  child.stderr.on('data', (d) => process.stderr.write(`[agent ${runId.slice(0, 8)}] ${d}`));

  child.on('close', (code) => {
    active--;
    if (!TERMINAL.has(run.status)) run.status = code === 0 ? 'completed' : 'error';
    broadcast(run, { type: 'end', status: run.status, code });
    startNext();
    setTimeout(() => runs.delete(runId), RUN_TTL_MS);
  });
}

function startNext() {
  while (active < MAX_CONCURRENT && queue.length) startRun(queue.shift());
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
    // Replay durable events, then the latest frame, then live updates follow.
    for (const evt of run.events) ws.send(JSON.stringify(evt));
    if (run.lastFrame) ws.send(JSON.stringify(run.lastFrame));
    if (TERMINAL.has(run.status)) ws.send(JSON.stringify({ type: 'end', status: run.status }));
    ws.on('close', () => run.subscribers.delete(ws));
  });
});

server.listen(PORT, () => {
  console.log(`qagent server on :${PORT}  (max_concurrent=${MAX_CONCURRENT}, auth=${API_TOKEN ? 'on' : 'off'})`);
});
