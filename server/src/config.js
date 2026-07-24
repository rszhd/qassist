// @ts-check
// Central env config, read once at import time (tests set env before
// importing the app).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.PORT || '8080', 10);
export const API_TOKEN = process.env.WORKER_API_TOKEN || '';
export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '4', 10);
export const DEFAULT_MAX_STEPS = parseInt(process.env.MAX_STEPS || '60', 10);
export const RUN_TTL_MS = parseInt(process.env.RUN_TTL_SECONDS || '3600', 10) * 1000;
// Summed RSS over the run's process tree, so it double-counts Chromium's
// shared pages (~1.8x the real PSS footprint — US-024 fixes the metric).
// 1600 because US-006's recording adds ~100 MB: measured peak 1177 MB with
// recording vs 1076 MB without, which left only 23 MB under the old 1200.
export const MAX_RUN_MEMORY_MB = parseInt(process.env.MAX_RUN_MEMORY_MB || '1600', 10);
export const MEM_POLL_MS = 3000;
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
export const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, '..', '..', 'agent');
export const AGENT_SCRIPT = process.env.AGENT_SCRIPT || path.join(AGENT_DIR, 'run_agent.py');
export const REPORT_SCRIPT = process.env.REPORT_SCRIPT || path.join(AGENT_DIR, 'make_report.py');
export const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(__dirname, '..', '..', 'runs');
export const MODEL = process.env.BROWSER_USE_MODEL || 'gpt-4.1';
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Where this instance is reachable from outside (US-007 sets it). The PDF
// report needs an absolute URL to link a recording; unset = no link in the
// PDF, the recording is still served in-app.
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
export const RECORDING_FILENAME = 'recording.mp4';
// What generateReport() writes and both the PDF renderer and US-026's steps
// endpoint read back.
export const REPORT_DATA_FILENAME = 'report_data.json';
// US-011 retention: how long runs/<id>/ survives. The history row is bytes and
// is kept forever; the PDF and the mp4 beside it are tens of MB, so they are
// what has to go. 0 disables pruning (keep artifacts until the disk fills).
export const ARTIFACT_RETENTION_DAYS = parseInt(process.env.ARTIFACT_RETENTION_DAYS || '7', 10);

// The agent can't run without a model key. Checked up front so a missing key
// is a clear message at startup and on POST, not a Python traceback ~15s into
// the first run. US-005 (BYOK) will extend this to per-request/stored keys.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Email notifications (US-012). Unset key or sender = the feature is off:
// prefs are still stored and editable, nothing is sent.
export const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
export const MAIL_FROM = process.env.MAIL_FROM || '';
// Dev-only transport: log each message (sign-in links, reports) to the server
// console instead of calling Resend, so the whole auth/email flow is testable
// locally without an account. Counts as "mail configured" so auth can boot.
// Never set this in production — nothing would actually be delivered.
export const MAIL_DEV_CONSOLE = /^(1|true|yes)$/i.test(process.env.MAIL_DEV_CONSOLE || '');
// Overridable so the tests can point the sender at a local server instead of
// stubbing fetch — the request that goes out is then the real one.
export const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
// Instance fallbacks for tests that belong to no project.
export const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);
export const NOTIFY_MODE = process.env.NOTIFY_MODE || 'failure';
// Signs unsubscribe links. Derived from the API token when unset so a link
// keeps working across restarts; the random fallback only matters on an
// instance with no token at all, where the links last as long as the process.
export const NOTIFY_SECRET =
  process.env.NOTIFY_SECRET || API_TOKEN || crypto.randomBytes(32).toString('hex');

// Multi-user auth (US-021). Off by default: an unset AUTH_ENABLED keeps the
// single-token / open behavior unchanged. When on, it needs the control plane
// (to store users/keys), a mail sender (to send login links) and SESSION_SECRET
// (to sign cookies) — server.js refuses to boot without all three so the switch
// can't half-enable. authEnabled() in auth.js ANDs those runtime preconditions.
export const AUTH_ENABLED = /^(1|true|yes)$/i.test(process.env.AUTH_ENABLED || '');
// Signs stateless session cookies. No fallback: a rotating secret would sign
// everyone out on restart, and a shared default would forge sessions across
// instances — so auth stays off until it is set explicitly.
export const SESSION_SECRET = process.env.SESSION_SECRET || '';

// Live demo replay (US-033). Off by default: an unset DEMO_MODE means no demo
// route, no /ws?demo branch, no `demo` flag in /api/health — the one
// unauthenticated surface simply doesn't exist. Fixtures live in DEMO_DIR
// (checked-in `demo/<slug>/`, outside runs/ so retention never sees them).
export const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
export const DEMO_DIR = process.env.DEMO_DIR || path.join(__dirname, '..', '..', 'demo');
// Wall-clock scale for the replay: >1 plays faster than recorded. The frontend
// says "condensed replay" whenever this isn't 1, rather than quietly lying
// about how fast a run really is (US-033 decision 3).
export const DEMO_SPEED = Math.max(0.1, parseFloat(process.env.DEMO_SPEED || '1') || 1);
// Where the end-of-replay signup CTA points when the instance can't offer its
// own login (token/open mode). In multi-user mode the CTA links to the app's
// own magic-link screen instead and this is unused.
export const DEMO_CTA_URL = process.env.DEMO_CTA_URL || 'https://qassist.run';

// Control plane (US-009). No DATABASE_URL = legacy in-memory mode: ad-hoc
// runs work, saved tests/suites respond 503.
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'operator@qassist.local';
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db', 'migrations');
