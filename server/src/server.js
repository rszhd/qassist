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
import { PORT, API_TOKEN, MAX_CONCURRENT, PUBLIC_DIR, OPENAI_API_KEY, AUTH_ENABLED, DEMO_MODE } from './config.js';
import { db, initDb, getOperatorUserId, userContext } from './db.js';
import { mailEnabled } from './mail.js';
import { authEnabled, userFromRequest, userFromCredentials, SESSION_COOKIE } from './auth.js';
import { getRun, counts, attachViewer } from './runs.js';
import { loadDemo, replayDemo } from './demo.js';
import { demoRouter } from './routes/demo.js';
import { startRetention } from './retention.js';
import { startScheduler } from './scheduler.js';
import { runsRouter } from './routes/runs.js';
import { testsRouter } from './routes/tests.js';
import { suitesRouter } from './routes/suites.js';
import { projectsRouter } from './routes/projects.js';
import { modulesRouter } from './routes/modules.js';
import { schedulesRouter } from './routes/schedules.js';
import { notificationsRouter } from './routes/notifications.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';

await initDb();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Resolve the caller and run the rest of the request as them: sets req.userId
// and opens an AsyncLocalStorage store so user-scoped queries filter on it
// (currentUserId() in db.js) without every handler threading the id. Two modes:
//   - multi-user (authEnabled()): a session cookie or a per-user API key; the
//     legacy shared WORKER_API_TOKEN is not accepted.
//   - single-token / open (unchanged): the WORKER_API_TOKEN bearer, or open
//     when none is configured. `allowQueryToken` adds the ?token= fallback for
//     media the browser loads by URL (a <video> can't send headers) — only in
//     this mode; multi-user media rides the session cookie the browser sends.
/** @param {boolean} allowQueryToken */
function makeGate(allowQueryToken) {
  /** @type {import('express').RequestHandler} */
  return (req, res, next) => {
    const proceed = (/** @type {string|null} */ userId) => {
      /** @type {any} */ (req).userId = userId;
      userContext.run({ userId }, () => next());
    };
    if (authEnabled()) {
      userFromRequest(req).then((uid) => {
        if (!uid) return res.status(401).json({ error: 'unauthorized' });
        proceed(uid);
      }, next);
      return;
    }
    if (!API_TOKEN) return proceed(getOperatorUserId()); // open (dev only)
    const ok =
      req.headers.authorization === `Bearer ${API_TOKEN}` ||
      (allowQueryToken && req.query.token === API_TOKEN);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    proceed(getOperatorUserId());
  };
}
const checkToken = makeGate(false);
const checkTokenOrQuery = makeGate(true);

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
    // 'multi' = magic-link login (US-021), 'token' = single WORKER_API_TOKEN,
    // 'open' = no credential. The frontend shows a login screen only for 'multi'.
    auth_mode: authEnabled() ? 'multi' : API_TOKEN ? 'token' : 'open',
    // Same purpose for notifications: a project can hold recipients on an
    // instance that can't send, and the prefs UI says so rather than looking
    // like it saved something that works.
    mail: mailEnabled(),
    // US-033: is the (unauthenticated) demo replay available? Off = the
    // frontend shows no /demo nav entry and the route doesn't exist server-side.
    demo: DEMO_MODE,
  });
});

// Auth endpoints (US-021): request-link and verify carry no bearer — the
// visitor has no credential yet. /me is gated. No-op (404) unless authEnabled().
app.use('/api/auth', authRouter({ checkToken }));
app.use('/api/keys', keysRouter({ checkToken }));

app.use('/api/runs', runsRouter({ checkToken, checkTokenOrQuery }));
app.use('/api/tests', testsRouter({ checkToken }));
app.use('/api/suites', suitesRouter({ checkToken }));
app.use('/api/projects', projectsRouter({ checkToken }));
app.use('/api/modules', modulesRouter({ checkToken }));
app.use('/api/schedules', schedulesRouter({ checkToken }));
// Not wrapped in checkToken as a whole: /unsubscribe is reached by a recipient
// from their inbox and carries its own signature (routes/notifications.js).
app.use('/api/notifications', notificationsRouter({ checkToken }));
// US-033: the demo surface is unauthenticated by design, and only exists when
// DEMO_MODE is set — off, these paths 404 like any other unknown /api route.
if (DEMO_MODE) app.use('/api/demo', demoRouter());

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

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();

  // US-033: a demo replay is the one socket that carries no credential. It
  // reads a checked-in fixture and touches neither the run registry nor auth,
  // so it branches out before any of the token/cookie handling below.
  const demoSlug = DEMO_MODE ? url.searchParams.get('demo') : null;
  if (demoSlug) {
    if (!loadDemo(demoSlug)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => {
      const cancel = replayDemo(ws, demoSlug);
      ws.on('close', cancel);
    });
  }

  // In multi-user mode the browser attaches its session cookie to the upgrade;
  // a programmatic client passes its per-user API key as ?token=. Otherwise the
  // legacy single-token behaviour: ?token= must match, or open when none is set.
  const token = url.searchParams.get('token') || '';
  /** @type {string | null} */
  let userId = null;
  if (authEnabled()) {
    userId = await userFromCredentials({ cookieHeader: req.headers.cookie, bearer: token });
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
  } else if (API_TOKEN && token !== API_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  const runId = url.searchParams.get('runId') || '';
  const run = getRun(runId);
  // A run the caller doesn't own is reported as absent, not forbidden.
  if (!run || (authEnabled() && run.user_id !== userId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(run, ws));
});

// Listen only when run directly (node src/server.js); tests import { app }
// and drive it in-process without opening a port.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // AUTH_ENABLED must not half-enable: refuse to serve unless everything auth
  // needs is present, naming what is missing rather than 401-ing every request.
  if (AUTH_ENABLED && !authEnabled()) {
    const missing = [
      !db() && 'DATABASE_URL',
      !mailEnabled() && 'a mail sender (RESEND_API_KEY + MAIL_FROM)',
      !process.env.SESSION_SECRET && 'SESSION_SECRET',
    ].filter(Boolean);
    console.error(`AUTH_ENABLED is set but auth can't run — missing: ${missing.join(', ')}.`);
    process.exit(1);
  }
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
