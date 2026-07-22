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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORT,
  API_TOKEN,
  MAX_CONCURRENT,
  ARTIFACTS_DIR,
  PUBLIC_DIR,
  OPENAI_API_KEY,
} from './config.js';
import { db, initDb, isUuid } from './db.js';
import { createRun, getRun, counts, attachViewer } from './runs.js';
import { h, requireAgentKey } from './routes/helpers.js';
import { testsRouter } from './routes/tests.js';
import { suitesRouter } from './routes/suites.js';
import { projectsRouter } from './routes/projects.js';
import { modulesRouter } from './routes/modules.js';

await initDb();

const app = express();
app.use(express.json({ limit: '1mb' }));

/** @type {import('express').RequestHandler} */
function checkToken(req, res, next) {
  if (!API_TOKEN) return next(); // no token configured => open (dev only)
  if (req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
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

app.post('/api/runs', checkToken, requireAgentKey, (req, res) => {
  const { goal, start_url, max_steps } = req.body || {};
  if (!goal || !start_url) {
    return res.status(400).json({ error: 'goal and start_url are required' });
  }
  const run = createRun({ goal, start_url, max_steps });
  res.json({ runId: run.id, status: run.status });
});

app.get(
  '/api/runs/:id',
  checkToken,
  h(async (req, res) => {
    const run = getRun(req.params.id);
    if (run) {
      return res.json({
        runId: run.id,
        status: run.status,
        goal: run.goal,
        start_url: run.start_url,
        testId: run.test_id,
        result: run.result,
        eventCount: run.events.length,
      });
    }
    // Fallback: finished runs outlive the in-memory relay in the DB.
    if (!db() || !isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { rows } = await db().query('select * from runs where id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const row = rows[0];
    res.json({
      runId: row.id,
      status: row.status,
      goal: row.goal,
      start_url: row.start_url,
      testId: row.test_id,
      result:
        row.success === null && row.final_result === null
          ? null
          : { success: row.success, final_result: row.final_result },
      error: row.error,
      reportStatus: row.report_status,
    });
  })
);

app.get(
  '/api/runs/:id/report.pdf',
  checkToken,
  h(async (req, res) => {
    const run = getRun(req.params.id);
    const pdfPath = run?.reportPath || path.join(ARTIFACTS_DIR, req.params.id, 'report.pdf');
    /** @param {string} status */
    const answer = (status) => {
      if (status === 'ready' && fs.existsSync(pdfPath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="qassist-report-${req.params.id.slice(0, 8)}.pdf"`
        );
        return res.sendFile(pdfPath);
      }
      if (status === 'generating') return res.status(202).json({ status: 'generating' });
      if (status === 'error') return res.status(500).json({ error: 'report generation failed' });
      return res.status(404).json({ error: 'no report (run not finished?)' });
    };
    if (run) return answer(run.reportStatus);
    if (!db() || !isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { rows } = await db().query('select report_status from runs where id = $1', [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    answer(rows[0].report_status);
  })
);

app.use('/api/tests', testsRouter({ checkToken }));
app.use('/api/suites', suitesRouter({ checkToken }));
app.use('/api/projects', projectsRouter({ checkToken }));
app.use('/api/modules', modulesRouter({ checkToken }));

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
