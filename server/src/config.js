// @ts-check
// Central env config, read once at import time (tests set env before
// importing the app).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DENIED_HOSTS } from './navigationPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.PORT || '8080', 10);
export const API_TOKEN = process.env.WORKER_API_TOKEN || '';
export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '4', 10);
// Per-user fair-use cap on concurrent runs (US-028), unset = off. When set, one
// user (real users arrive with US-021) can hold at most this many runs in flight
// so no single person fills MAX_CONCURRENT and queues everyone else. Off by
// default so a solo self-host is byte-for-byte the pre-US-028 single global queue.
export const MAX_CONCURRENT_PER_USER = process.env.MAX_CONCURRENT_PER_USER
  ? parseInt(process.env.MAX_CONCURRENT_PER_USER, 10)
  : null;
export const DEFAULT_MAX_STEPS = parseInt(process.env.MAX_STEPS || '60', 10);
export const RUN_TTL_MS = parseInt(process.env.RUN_TTL_SECONDS || '3600', 10) * 1000;
// PSS over the run's process tree — what the machine actually pays, after
// Chromium's shared pages are divided among the processes sharing them
// (US-024). 1000 is ~1.4x the measured 704 MB peak of a recording run; it is
// also marginally MORE permissive than the 1600 MB of summed RSS it replaces,
// which measured the same run at 1187 MB. Sizing rule this implies: ~700 MB
// per concurrent run. Re-measure with `agent/measure_memory.py`.
export const MAX_RUN_MEMORY_MB = parseInt(process.env.MAX_RUN_MEMORY_MB || '1000', 10);
export const MEM_POLL_MS = 3000;
// Hard wall-clock ceiling per run (US-005). MAX_STEPS bounds steps, not time —
// a slow or rate-limited (429-retrying) BYOK key would otherwise squat a browser
// slot indefinitely. The watchdog kills the tree and reports the run failed.
export const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_SECONDS || '600', 10) * 1000;
// How long a stop is given to land gracefully before the hard kill (US-047).
// browser-use checks the stop flag before every action within a step, so a
// healthy agent stops within roughly one in-flight action — but an agent wedged
// inside one never reaches the checkpoint, which is why the graceful path is
// preferred and never trusted. Generous rather than tight: a stop that
// pre-empts its own agent throws away the recording it was about to finalize,
// which is the failure this story exists to fix.
export const STOP_GRACE_MS = parseInt(process.env.STOP_GRACE_SECONDS || '10', 10) * 1000;
// How long a run may stay paused before the engine ends it (US-079). A pause
// suspends the wall clock above, so without a budget of its own a pause left on
// a second monitor leaks a browser, a process and a concurrency slot for as long
// as the box is up. It escalates through `stopRun`, so a forgotten pause ends
// `cancelled` with its evidence — an abandoned run, which is what it is — rather
// than as a resource failure nobody caused.
export const PAUSE_MAX_MS = parseInt(process.env.PAUSE_MAX_SECONDS || '600', 10) * 1000;
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
export const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, '..', '..', 'agent');
export const AGENT_SCRIPT = process.env.AGENT_SCRIPT || path.join(AGENT_DIR, 'run_agent.py');
export const REPORT_SCRIPT = process.env.REPORT_SCRIPT || path.join(AGENT_DIR, 'make_report.py');
// Whether a finished run is rendered to a PDF at all. Off by default while the
// report is being reworked — off means the renderer is never spawned, the
// endpoint 404s and no UI offers a download, so nothing points at a file that
// isn't coming. What it does NOT switch off is `report_data.json`: the step
// list and the diagnostics are read out of that file, not out of the PDF.
export const REPORTS_ENABLED = /^(1|true|yes|on)$/i.test((process.env.REPORTS_ENABLED || '').trim());
export const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(__dirname, '..', '..', 'runs');
export const MODEL = process.env.BROWSER_USE_MODEL || 'gpt-4.1';
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Where this instance is reachable from outside (US-007 sets it). The PDF
// report needs an absolute URL to link a recording; unset = no link in the
// PDF, the recording is still served in-app.
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

/**
 * How much of `X-Forwarded-For` to believe — which decides whose address every
 * per-IP guard counts (the demo's mint throttle, the magic-link limiter).
 *
 * Off by default, and that default is load-bearing in both directions. A plain
 * `docker compose up` self-host publishes its port, so trusting the header there
 * would let any caller claim any address and mint past DEMO_IP_MAX. Behind the
 * US-007 proxy the opposite bites: unset, `req.ip` is the Traefik container's on
 * every request, so a per-visitor cap silently becomes a deployment-wide one.
 * So a proxied deployment sets the number of hops it actually has (ours: 1).
 *
 * `1` and `true` are not the same value and the difference matters: one hop
 * counts the address the proxy vouched for, `true` counts whatever the client
 * wrote. Numeric strings therefore stay numbers, and `true` is only reachable by
 * writing it out. Anything else goes to Express verbatim, which is how subnet
 * lists and its own keywords (`loopback`) work — and an address list that means
 * nothing is rejected there at boot rather than quietly trusting.
 * @param {string | undefined} raw
 * @returns {boolean | number | string}
 */
export function parseTrustProxy(raw) {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value === 'false' || value === 'off' || value === 'no') return false;
  if (value === 'true') return true;
  // Blank already returned above, so Number('') can't sneak in as 0 here.
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return (raw || '').trim();
}

export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// Where a run's browser may navigate (US-042). ON by default, because a fence
// that has to be switched on is off wherever it matters — this instance is
// registrable by strangers the moment US-021's auth is enabled, and the agent
// runs on the compose network with whatever egress the box has.
//
// Off is the escape hatch for the self-hoster whose whole use case is testing
// `http://localhost:3000`, which is real and common and cannot simply be
// hardcoded away. It is ONE switch on purpose: it clears the address-literal
// block AND the default hostname denylist below, because a half-open hatch —
// literals allowed, `localhost` still refused — is an operator who set the
// documented flag and still cannot test their own machine.
export const BLOCK_PRIVATE_NETWORKS = !/^(0|false|no|off)$/i.test(
  (process.env.QA_BLOCK_PRIVATE_NETWORKS || '').trim()
);
// Hostnames refused by name. Not redundant with the flag above: browser-use's
// `block_ip_addresses` blocks IP *literals*, so despite its docstring it does
// not stop `http://localhost:8080` (this app), `http://db:5432` (the control
// plane) or `http://metadata.google.internal`. This list is what does.
// Explicitly set = exactly that list, whatever the floor is doing; unset =
// the defaults while the floor is up, and nothing once it is down.
export const DENIED_HOSTS =
  process.env.QA_DENIED_HOSTS !== undefined
    ? process.env.QA_DENIED_HOSTS.split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    : BLOCK_PRIVATE_NETWORKS
      ? DEFAULT_DENIED_HOSTS
      : [];

/**
 * This instance's navigation policy, with a project's allowlist folded in.
 * Lives here rather than in navigationPolicy.js so that module stays pure and
 * free of an import cycle — it is the thing config reads its default denylist
 * from.
 * @param {string[]} [allowedDomains] the project's `allowed_domains`, if any
 */
export function instancePolicy(allowedDomains = []) {
  return {
    blockPrivate: BLOCK_PRIVATE_NETWORKS,
    deniedHosts: DENIED_HOSTS,
    allowedDomains: allowedDomains || [],
  };
}

// Project fixtures (US-048): files a project's tests may attach. Deliberately
// NOT under ARTIFACTS_DIR — retention prunes uuid-named directories there and a
// fixture directory is named after its project, so the natural-looking nested
// layout would delete a customer's fixtures a week after they uploaded them.
// `fixturesDirConflict` refuses that at boot rather than trusting this default.
export const FIXTURES_DIR = process.env.FIXTURES_DIR || path.join(__dirname, '..', '..', 'fixtures');
// Per-file and per-project ceilings. Modest by default: a fixture is a CV, an
// ID scan, a CSV — the things upload flows actually ask for — and an operator
// who needs more says so, rather than everyone silently underwriting a video.
export const FIXTURE_MAX_BYTES = parseInt(process.env.FIXTURE_MAX_BYTES || '10485760', 10);
export const FIXTURE_PROJECT_QUOTA_BYTES = parseInt(
  process.env.FIXTURE_PROJECT_QUOTA_BYTES || '52428800',
  10
);

// Saved browser sessions (US-043): where a run's decrypted `storageState` lives
// for the length of one spawn. Its own directory, and NOT under either of the
// two above — `sessionsDirConflict` refuses both at boot, because either
// overlap leaks a credential with no bug anywhere in the code:
//   * under FIXTURES_DIR the blob becomes an entry in `available_file_paths`,
//     which is the list browser-use gates `read_file` on — the agent could be
//     argued into reading the credential into its own LLM context.
//   * under ARTIFACTS_DIR it sits in runs/<id>/ for ARTIFACT_RETENTION_DAYS,
//     beside the files users download.
export const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', '..', 'sessions');
// A storageState is cookies and localStorage; a megabyte is already a very
// chatty app. The cap is here so a paste cannot make the spawn's temp write,
// the AES round-trip and the row unbounded on someone else's input.
export const SESSION_MAX_BYTES = parseInt(process.env.SESSION_MAX_BYTES || '1048576', 10);
// A preamble is per-project config that fires before every run in it, so both
// ceilings bound something an operator would otherwise never see going wrong:
// the wall-clock watchdog is all that stands between a 3600-second `wait` and a
// squatted browser slot.
export const PREAMBLE_MAX_ACTIONS = 12;
export const PREAMBLE_MAX_WAIT_SECONDS = 30;

export const RECORDING_FILENAME = 'recording.mp4';
// The full network archive (US-044), written by the browser when a run asks for
// it. Off by default: the curated diagnostics summary is the always-on artifact,
// and this one is large and — unlike the summary — is written by Chromium, so
// `scrub` never sees it and a secret in a query string lands in it verbatim.
// CAPTURE_HAR=1 turns it on for every run on this instance; a caller can also
// ask per run with `har: true`.
export const HAR_FILENAME = 'network.har';
export const CAPTURE_HAR = /^(1|true|yes)$/i.test(process.env.CAPTURE_HAR || '');
// What generateReport() writes and both the PDF renderer and US-026's steps
// endpoint read back.
export const REPORT_DATA_FILENAME = 'report_data.json';
// US-011 retention: how long runs/<id>/ survives. The history row is bytes and
// is kept forever; the PDF and the mp4 beside it are tens of MB, so they are
// what has to go. 0 disables pruning (keep artifacts until the disk fills).
export const ARTIFACT_RETENTION_DAYS = parseInt(process.env.ARTIFACT_RETENTION_DAYS || '7', 10);

// There is deliberately no OPENAI_API_KEY here (US-039). A run is funded by the
// key its caller supplied — per-request, else the caller's stored one — and by
// nothing else, so that standing this app up in front of other people cannot
// spend the operator's tokens. One way to fund a run, not two plus a rule about
// which applies when.

// Encrypts users' stored BYOK keys at rest (US-005). Deliberately its OWN
// secret, not SESSION_SECRET: rotating SESSION_SECRET is the documented
// session-revocation lever (auth.js), and it must never silently make every
// stored OpenAI key undecryptable. Required since US-039 — with no server key
// to fall back on, blank would leave no way to supply a key at all (boot.js).
export const KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || '';

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

// Demo fixtures (checked-in `demo/<slug>/`, outside runs/ so retention never
// sees them). Read by the demo-sandbox run interceptor (US-036), which replays
// a fixture that matches the visitor's test instead of spawning an agent.
export const DEMO_DIR = process.env.DEMO_DIR || path.join(__dirname, '..', '..', 'demo');
// Wall-clock scale for the replay: >1 plays faster than recorded.
export const DEMO_SPEED = Math.max(0.1, parseFloat(process.env.DEMO_SPEED || '1') || 1);
// Where the sandbox's signup CTA points — the hosted app's signup/login page.
export const DEMO_CTA_URL = process.env.DEMO_CTA_URL || 'https://app.qassist.run';

// Demo sandbox (US-036). AUTH_MODE=demo turns the whole deployment into a
// per-visitor sandbox: anonymous cookie tenants, seeded fake data, every run a
// replay. Any other value (including unset) leaves self-host and the magic-link
// app byte-for-byte unchanged — none of the provision/seed/interceptor/reaper
// machinery exists. demoMode() in auth.js ANDs the runtime preconditions
// (control plane + SESSION_SECRET) the cookie tenants need.
export const AUTH_MODE = (process.env.AUTH_MODE || '').toLowerCase();
// A demo tenant's lifetime: created_at + DEMO_TTL is when the reaper deletes it
// and its artifacts. Absolute for v1 (no last_seen bump). Default 1h.
export const DEMO_TTL_MS = parseInt(process.env.DEMO_TTL_SECONDS || '3600', 10) * 1000;
// Hard ceiling on concurrent live demo tenants. The provision endpoint is
// public and writable, so it rejects past this rather than growing unbounded
// between reaper passes.
export const DEMO_MAX_TENANTS = parseInt(process.env.DEMO_MAX_TENANTS || '200', 10);
// Per-IP throttle on tenant creation: at most DEMO_IP_MAX new tenants per
// DEMO_IP_WINDOW, so one caller can't mint the whole cap.
export const DEMO_IP_MAX = parseInt(process.env.DEMO_IP_MAX || '5', 10);
export const DEMO_IP_WINDOW_MS = parseInt(process.env.DEMO_IP_WINDOW_SECONDS || '3600', 10) * 1000;

// Control plane (US-009). Required since US-039: a run needs its caller's key,
// and that key lives on a `users` row — so without the control plane there is
// nothing this app can do. The legacy in-memory mode is gone; server.js refuses
// to boot rather than serving a half-app (boot.js).
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'operator@qassist.local';
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db', 'migrations');

// Stripe billing (US-022). All three unset — the self-host default — is billing
// entirely off: no UI, no gating, no /api/billing surface at all. Self-host is
// always free (CLAUDE.md), so the switch has to be the absence of config rather
// than a flag someone could get wrong. billingEnabled() in billing.js ANDs
// these with PUBLIC_BASE_URL (Stripe needs somewhere to send the customer
// back), the control plane, and authEnabled() — billing charges *users*, and
// without real users the only account is the seeded operator.
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
// Overridable so a test can point the transport at a local server instead of
// stubbing fetch — the request that goes out is then the real one (as RESEND_API_URL).
export const STRIPE_API_URL = (process.env.STRIPE_API_URL || 'https://api.stripe.com/v1').replace(/\/+$/, '');
// The activation window (US-054): how long after subscribing an account waits
// while the operator adds the capacity it just bought. Unset or 0 is off — no
// fourth onboarding step, no gate, nothing read — so an instance that already
// charges does not acquire a hold on its next customer because we upgraded it.
// Only meaningful with billing on; activationEnabled() ANDs the two.
//
// Turning it off is a one-line .env change and a restart, and it RELEASES
// everyone currently waiting rather than stranding them: off resolves to
// "activated" for every account (activation.js), not to "skip the check". So an
// operator who has since bought a box big enough to stop rationing capacity
// deletes the line and never has to activate the backlog by hand.
export const ACTIVATION_SLA_HOURS = parseInt(process.env.ACTIVATION_SLA_HOURS || '0', 10) || 0;
// Accounts that run without subscribing. The operator must be able to
// smoke-test production without buying their own product, and a self-hosting
// org needs to exempt its own staff — an explicit, logged-in-config bypass
// rather than a hidden one.
export const BILLING_EXEMPT_EMAILS = (process.env.BILLING_EXEMPT_EMAILS || OPERATOR_EMAIL)
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
