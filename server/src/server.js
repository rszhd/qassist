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
import { PORT, API_TOKEN, MAX_CONCURRENT, PUBLIC_DIR, AUTH_ENABLED, AUTH_MODE, DEMO_CTA_URL, TRUST_PROXY } from './config.js';
import { db, initDb, getOperatorUserId, userContext } from './db.js';
import { missingBootRequirements } from './boot.js';
import { keyEncryptionEnabled } from './crypto.js';
import { mailEnabled } from './mail.js';
import { authEnabled, demoMode, userFromRequest, userFromCredentials, SESSION_COOKIE } from './auth.js';
import { getRun, counts, attachViewer } from './runs.js';
import { demoSessionRouter } from './routes/demoSession.js';
import { startRetention } from './retention.js';
import { startScheduler } from './scheduler.js';
import { startDemoReaper } from './demoReaper.js';
import { runsRouter } from './routes/runs.js';
import { testsRouter } from './routes/tests.js';
import { suitesRouter } from './routes/suites.js';
import { projectsRouter } from './routes/projects.js';
import { modulesRouter } from './routes/modules.js';
import { schedulesRouter } from './routes/schedules.js';
import { notificationsRouter } from './routes/notifications.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';
import { accountRouter } from './routes/account.js';
import { billingRouter, billingWebhookHandler } from './routes/billing.js';
import { billingEnabled } from './billing.js';

await initDb();

const app = express();

// Whose address the per-IP guards count (US-040). Behind the US-007 proxy every
// request arrives from the Traefik container, so without this the demo's
// per-visitor mint throttle is a cap on the whole deployment; on a self-host
// that publishes its own port, trusting the header would make that throttle
// spoofable. Hence off by default and opted into per deployment — see
// parseTrustProxy for why `1` and `true` are different answers.
app.set('trust proxy', TRUST_PROXY);

// US-022: the Stripe webhook is mounted BEFORE express.json() and parses its
// own body with express.raw. Its signature covers the exact bytes Stripe sent,
// so a re-serialized body could never verify. It carries no bearer either —
// Stripe holds no credential of ours, and that signature is its authentication.
// Not mounted at all when billing is off, so it 404s like any unknown route.
if (billingEnabled()) {
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler);
}

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
    // Cookie-auth modes: magic-link (multi) and the demo sandbox both scope every
    // request to the session's user. In demo mode a visitor with no cookie is
    // 401'd here just like multi — they bootstrap a tenant via the one
    // unauthenticated POST /api/demo/session, which sets the cookie.
    if (authEnabled() || demoMode()) {
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
    // No agent_ready: since US-039 a run is funded by its caller's key, so
    // readiness is per-user and this endpoint is ungated (it opens no user
    // context). GET /api/account/openai-key is what answers it, per caller.
    auth: !!API_TOKEN,
    // 'multi' = magic-link login (US-021), 'demo' = per-visitor sandbox (US-036),
    // 'token' = single WORKER_API_TOKEN, 'open' = no credential. The frontend
    // shows a login screen only for 'multi'; 'demo' bootstraps silently.
    auth_mode: authEnabled() ? 'multi' : demoMode() ? 'demo' : API_TOKEN ? 'token' : 'open',
    // Same purpose for notifications: a project can hold recipients on an
    // instance that can't send, and the prefs UI says so rather than looking
    // like it saved something that works.
    mail: mailEnabled(),
    // US-022: whether this instance charges for runs. False on every self-host
    // default, so the SPA renders no billing UI at all rather than an inert one.
    billing: billingEnabled(),
    // US-036: in demo mode the SPA shows a persistent "simulated results" banner
    // whose signup CTA points here (the hosted app's marketing/login page). Null
    // off demo mode, so nothing about the sandbox leaks into a normal deployment.
    cta_url: demoMode() ? DEMO_CTA_URL : null,
  });
});

// Auth endpoints (US-021): request-link and verify carry no bearer — the
// visitor has no credential yet. /me is gated. No-op (404) unless authEnabled().
app.use('/api/auth', authRouter({ checkToken }));
app.use('/api/keys', keysRouter({ checkToken }));
app.use('/api/account', accountRouter({ checkToken }));
// Empty router (so every path under it 404s) unless billingEnabled().
app.use('/api/billing', billingRouter({ checkToken }));

app.use('/api/runs', runsRouter({ checkToken, checkTokenOrQuery }));
app.use('/api/tests', testsRouter({ checkToken }));
app.use('/api/suites', suitesRouter({ checkToken }));
app.use('/api/projects', projectsRouter({ checkToken }));
app.use('/api/modules', modulesRouter({ checkToken }));
app.use('/api/schedules', schedulesRouter({ checkToken }));
// Not wrapped in checkToken as a whole: /unsubscribe is reached by a recipient
// from their inbox and carries its own signature (routes/notifications.js).
app.use('/api/notifications', notificationsRouter({ checkToken }));
// US-036: the demo sandbox's one unauthenticated surface — bootstrap a tenant.
// Only mounted when AUTH_MODE=demo; off, /api/demo 404s like any unknown route.
if (demoMode()) app.use('/api/demo', demoSessionRouter());

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

  // In multi-user mode the browser attaches its session cookie to the upgrade;
  // a programmatic client passes its per-user API key as ?token=. Otherwise the
  // legacy single-token behaviour: ?token= must match, or open when none is set.
  const token = url.searchParams.get('token') || '';
  const cookieMode = authEnabled() || demoMode();
  /** @type {string | null} */
  let userId = null;
  if (cookieMode) {
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
  if (!run || (cookieMode && run.user_id !== userId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(run, ws));
});

// Listen only when run directly (node src/server.js); tests import { app }
// and drive it in-process without opening a port.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Refuse to serve rather than half-enable: a missing requirement is named and
  // the process exits, instead of 401-ing every request (auth), serving an
  // unauthenticated unseeded app (demo) or accepting runs nobody can fund
  // (US-039). The predicate is pure so the matrix is testable — config is read
  // at import time, so one process can only ever exercise one row of it.
  const missing = missingBootRequirements({
    hasDb: !!db(),
    hasKeyEncryption: keyEncryptionEnabled(),
    authRequested: AUTH_ENABLED,
    mailReady: mailEnabled(),
    hasSessionSecret: !!process.env.SESSION_SECRET,
    demoRequested: AUTH_MODE === 'demo',
  });
  if (missing.length) {
    console.error(`qassist can't start — missing: ${missing.join(', ')}.`);
    process.exit(1);
  }
  // Only when actually serving: tests drive the app in-process and would
  // otherwise sweep a temp dir — or start runs on a timer — on every import.
  // sweepArtifacts() and tick() are tested directly instead.
  startRetention();
  startScheduler();
  // US-036: only a demo deployment provisions expiring tenants to reap.
  if (demoMode()) startDemoReaper();
  server.listen(PORT, () => {
    console.log(
      `qassist server on :${PORT}  (max_concurrent=${MAX_CONCURRENT}, auth=${API_TOKEN ? 'on' : 'off'}, db=${db() ? 'on' : 'off'})`
    );
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
