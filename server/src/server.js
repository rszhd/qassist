// @ts-check
// Express REST API + WebSocket relay for the QA agent.
//
// Flow: POST /api/runs (or /api/tests/:id/run, /api/suites/:id/run) enqueues
// a run in src/runs.js, which spawns agent/run_agent.py and relays its NDJSON
// events to WebSocket subscribers. With DATABASE_URL set, src/db.js persists
// tests/suites/runs to the Postgres control plane; without it the server
// keeps the legacy in-memory behavior (ad-hoc runs only).
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, API_TOKEN, MAX_CONCURRENT, PUBLIC_DIR, OPENAI_API_KEY } from './config.js';
import { db, initDb } from './db.js';
import { getRun, counts, attachViewer } from './runs.js';
import { startRetention } from './retention.js';
import { startScheduler } from './scheduler.js';
import { runsRouter } from './routes/runs.js';
import { testsRouter } from './routes/tests.js';
import { suitesRouter } from './routes/suites.js';
import { projectsRouter } from './routes/projects.js';
import { modulesRouter } from './routes/modules.js';
import { schedulesRouter } from './routes/schedules.js';

await initDb();

const app = express();
app.use(express.json({ limit: '1mb' }));

/** @type {import('express').RequestHandler} */
function checkToken(req, res, next) {
  if (!API_TOKEN) return next(); // no token configured => open (dev only)
  if (req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/** @type {import('express').RequestHandler} */
// For media the browser loads by URL: a <video> element can't send headers, so
// the token may also arrive as ?token=, exactly as the /ws upgrade accepts it.
// Deliberately not the default — query tokens leak into access logs, browser
// history and Referer headers.
function checkTokenOrQuery(req, res, next) {
  if (!API_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
  if (req.query.token === API_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', (_req, res) => {
  const { active, queued } = counts();
  res.json({
    ok: true,
    active,
    queued,
    max_concurrent: MAX_CONCURRENT,
    db: !!db(),
    // Lets the UI tell "not configured yet" apart from "run failed".
    agent_ready: !!OPENAI_API_KEY,
    auth: !!API_TOKEN,
  });
});

app.use('/api/runs', runsRouter({ checkToken, checkTokenOrQuery }));
app.use('/api/tests', testsRouter({ checkToken }));
app.use('/api/suites', suitesRouter({ checkToken }));
app.use('/api/projects', projectsRouter({ checkToken }));
app.use('/api/modules', modulesRouter({ checkToken }));
app.use('/api/schedules', schedulesRouter({ checkToken }));

app.use(express.static(PUBLIC_DIR));
// SPA fallback: anything not matched above returns the React app.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

/** @type {import('express').ErrorRequestHandler} */
// eslint-disable-next-line no-unused-vars
const onError = (err, _req, res, _next) => {
  console.error('unhandled route error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
};
app.use(onError);

// --- WebSocket live feed ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token') || '';
  if (API_TOKEN && token !== API_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const runId = url.searchParams.get('runId') || '';
  const run = getRun(runId);
  if (!run) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(run, ws));
});

// Listen only when run directly (node src/server.js); tests import { app }
// and drive it in-process without opening a port.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Only when actually serving: tests drive the app in-process and would
  // otherwise sweep a temp dir — or start runs on a timer — on every import.
  // sweepArtifacts() and tick() are tested directly instead.
  startRetention();
  startScheduler();
  server.listen(PORT, () => {
    console.log(
      `qassist server on :${PORT}  (max_concurrent=${MAX_CONCURRENT}, auth=${API_TOKEN ? 'on' : 'off'}, db=${db() ? 'on' : 'off'})`
    );
    // First-run guidance: a fresh clone starts with no .env at all.
    if (!OPENAI_API_KEY) {
      console.warn(
        'WARNING: OPENAI_API_KEY is not set — the UI loads but runs will be refused.\n' +
          '         Copy .env.example to .env, add your key, then: docker compose up -d'
      );
    }
    if (!API_TOKEN) {
      console.warn(
        'WARNING: WORKER_API_TOKEN is not set — the API and live feed are open to\n' +
          '         anyone who can reach this port. Fine on localhost; set a token\n' +
          '         in .env before exposing it.'
      );
    }
  });
}

export { app, server };
