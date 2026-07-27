// @ts-check
// Saved browser sessions (US-043): the blob a run's browser starts with, and
// the rules about where its plaintext may exist.
//
// This module is the security boundary, not a storage helper. A `storageState`
// IS the credential — holding one is being logged in, with no password to steal
// and no second factor left to clear — so the plaintext exists in exactly two
// places for exactly as long as one spawn: the in-memory run object, and a file
// this module writes and this module removes.
//
// `scrub` is not the guard here and could not be. US-034/US-035's redaction
// works because a secret variable's value passes through the LLM's context,
// where a string replacement can catch it. A blob never enters that context at
// all — it goes from Postgres to a file to Chromium — so there is nothing to
// match on, and containment is the entire mechanism.
//
// Correctness-critical (backlog/correctness-critical.md). The spec is
// test/session-blob.test.js and test/session-containment.test.js, plus
// agent/tests/test_browser_session.py for the half that proves the mechanism is
// armed at all.
import fs from 'node:fs';
import path from 'node:path';
import { db, isUuid } from './db.js';
import { decryptSecret } from './crypto.js';
import { checkStartUrl } from './navigationPolicy.js';
import {
  SESSIONS_DIR,
  SESSION_MAX_BYTES,
  PREAMBLE_MAX_ACTIONS,
  PREAMBLE_MAX_WAIT_SECONDS,
} from './config.js';

// The filename inside a run's session directory. browser-use owns this path
// once we hand it over — StorageStateWatchdog rewrites it on a 30s timer and on
// browser stop — so the name matters less than the directory around it.
const STATE_FILE = 'storage_state.json';
// Where a login run exports the state it captured. A separate file from the one
// it was given, so a login run that also *used* a session cannot half-overwrite
// its own input mid-flight.
const EXPORT_FILE = 'captured_state.json';

// The deterministic actions a project preamble may ask for. An allowlist, not a
// filter of dangerous ones: US-042 is the standing reminder that a denylist is
// a list of the spellings we happened to think of.
//
// Two exclusions are deliberate. Every index-based action (`click`, `input`) is
// incoherent before any DOM has been observed — there is no index yet to mean.
// And `upload_file`/`read_file` are US-048's boundary; a preamble that could
// name them would be a second, unguarded door to `available_file_paths`.
//
// browser-use has no click-by-selector, so "dismiss the cookie dialog" is
// Escape via send_keys and there is nothing better available. Four that work
// beats a fifth that needs an index the preamble cannot know.
const PREAMBLE_ACTIONS = {
  navigate: navigateParams,
  wait: waitParams,
  send_keys: sendKeysParams,
  scroll: scrollParams,
};

/**
 * Validate a Playwright `storageState` as it arrives from a paste or from a
 * login run's export. Returns `{ error }`, or the canonical JSON text plus the
 * counts that let the UI describe a session without reading it.
 *
 * Re-serialized from what we parsed rather than passed through: the result is
 * written to a file Chromium loads, so it must be JSON this process has already
 * read. It also means a blob with a megabyte of trailing whitespace cannot
 * become a megabyte on disk.
 * @param {unknown} raw JSON text, or the already-parsed object
 * @returns {{ error: string } | { storageState: string, cookies: number, origins: number }}
 */
export function normalizeStorageState(raw) {
  let parsed;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { error: 'a storage state is required' };
    if (Buffer.byteLength(raw, 'utf8') > SESSION_MAX_BYTES) return { error: tooBig() };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: 'that is not JSON — paste the contents of a storageState.json file' };
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  } else {
    return { error: 'a storage state is required' };
  }

  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return { error: 'a storage state must be a JSON object with cookies and/or origins' };
  }
  const { cookies, origins } = /** @type {any} */ (parsed);
  if (cookies !== undefined && !Array.isArray(cookies)) return { error: 'cookies must be an array' };
  if (origins !== undefined && !Array.isArray(origins)) return { error: 'origins must be an array' };
  if (!cookies?.length && !origins?.length) {
    // An empty jar is an anonymous browser. Storing one gives a project a
    // session that authenticates nobody and fails every test in it silently —
    // the false green this whole story exists to remove.
    return { error: 'that storage state has no cookies and no origins — it is not signed in' };
  }
  for (const cookie of cookies || []) {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || !cookie.name) {
      return { error: 'every cookie needs a name — that does not look like a storageState.json' };
    }
  }
  for (const origin of origins || []) {
    if (!origin || typeof origin !== 'object' || typeof origin.origin !== 'string') {
      return { error: 'every origin needs an `origin` — that does not look like a storageState.json' };
    }
  }

  const storageState = JSON.stringify(parsed);
  if (Buffer.byteLength(storageState, 'utf8') > SESSION_MAX_BYTES) return { error: tooBig() };
  return { storageState, cookies: cookies?.length || 0, origins: origins?.length || 0 };
}

function tooBig() {
  const kb = Math.round(SESSION_MAX_BYTES / 1024);
  return `that storage state is larger than the ${kb} KB limit`;
}

/** The key a project's session names are unique on. */
export function sessionKey(name) {
  return String(name).normalize('NFC').trim().toLowerCase();
}

/**
 * One run's session directory. A directory rather than a bare filename because
 * teardown has to be `rm -rf`, and that is the whole point — see
 * `removeSessionFiles`.
 * @param {string} runId
 */
export function sessionDir(runId) {
  if (!isUuid(runId)) throw new TypeError(`sessionDir: not a run id: ${runId}`);
  return path.join(path.resolve(SESSIONS_DIR), runId);
}

/**
 * Write a run's decrypted blob, and answer with the path the spawn passes on.
 *
 * A PATH, never the parsed object, and this is the finding the whole design
 * turns on. `BrowserProfile.storage_state` is typed `str | Path | dict`, so a
 * dict looks supported — and in this version of browser-use it silently loads
 * nothing: the file-loading validator is commented out
 * (browser/profile.py:519-529) and `StorageStateWatchdog._load_storage_state`
 * gates on `os.path.exists(str(load_path))`, which a stringified dict never
 * satisfies. No error, no warning: the browser opens cold and the run fails
 * exactly the way an expired session fails, which is the other thing this story
 * is meant to be able to tell you apart.
 * @param {string} runId
 * @param {string} storageState the canonical JSON from normalizeStorageState
 * @returns {{ path: string }}
 */
export function writeSessionFile(runId, storageState) {
  const dir = sessionDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by the process umask, so say it again.
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, STATE_FILE);
  fs.writeFileSync(file, storageState, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { path: file };
}

/** Where a login run is told to export what it captured. */
export function exportPathFor(runId) {
  return path.join(sessionDir(runId), EXPORT_FILE);
}

/**
 * Read back what a login run exported, or null. Removes nothing — teardown owns
 * that, and it owns the directory rather than any file in it.
 * @param {string} runId
 * @returns {string | null}
 */
export function readExportedState(runId) {
  try {
    return fs.readFileSync(exportPathFor(runId), 'utf8');
  } catch {
    return null; // the run never got far enough to export one
  }
}

/**
 * Remove everything a run's session left on disk.
 *
 * The DIRECTORY, not the file, and that is not fussiness. Handing browser-use a
 * path means browser-use owns that path: `StorageStateWatchdog` auto-saves
 * every 30 seconds and on browser stop, and its writer leaves `X.json.tmp` and
 * `X.json.bak` beside the file it rewrote
 * (watchdogs/storage_state_watchdog.py:200-212). A teardown that unlinks the
 * path we wrote — the obvious implementation, and one that passes an
 * end-to-end test — leaves the credential on disk in the `.bak`, forever, under
 * a name nothing else will ever look at. Removing the directory covers those
 * siblings by construction, including the ones a future browser-use invents.
 *
 * Never throws: this runs on the `close` handler of every run, session or not,
 * and a throw there would take out the slot accounting behind it.
 * @param {string} runId
 */
export function removeSessionFiles(runId) {
  if (!isUuid(runId)) return; // `rm -rf` under an operator-configurable dir earns a check
  try {
    fs.rmSync(sessionDir(runId), { recursive: true, force: true });
  } catch {
    /* already gone, or a disk we cannot write — never worth failing a run over */
  }
}

/**
 * Empty SESSIONS_DIR at boot.
 *
 * Teardown covers every run-end path the app controls, and none of the ones it
 * does not: `kill -9`, an OOM, a container stopped mid-run. Nothing else in the
 * system will ever remove those files and they are credentials — and because a
 * blob is a few KB, the disk never complains, so the absence of this sweep is
 * completely silent.
 */
export function sweepSessions() {
  const dir = path.resolve(SESSIONS_DIR);
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // nothing has run yet
  }
  let swept = 0;
  for (const entry of entries) {
    // Only ever uuid-named directories, for retention.js's reason: this deletes
    // recursively and SESSIONS_DIR is operator-configurable, so anything that
    // is not clearly ours is left alone.
    if (!entry.isDirectory() || !isUuid(entry.name)) continue;
    try {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      swept++;
    } catch {
      /* leave it; the next boot tries again */
    }
  }
  return swept;
}

/**
 * Whether SESSIONS_DIR overlaps either directory it must not, which boot
 * refuses. Both failures arrive purely by configuration, with no bug anywhere
 * in the code — the kind US-048's own overlap guard exists for.
 * @param {{ sessionsDir: string, fixturesDir: string, artifactsDir: string }} dirs
 * @returns {{ error: string } | null}
 */
export function sessionsDirConflict({ sessionsDir: sessions, fixturesDir, artifactsDir }) {
  const s = path.resolve(sessions);
  const f = path.resolve(fixturesDir);
  const a = path.resolve(artifactsDir);
  // Compared on a path boundary, so `/data/runs-sessions` is not "inside"
  // `/data/runs`: the naive startsWith refuses that legitimate layout, and the
  // same bug pointed the other way accepts a genuinely nested one.
  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (contains(f, s) || contains(s, f)) {
    return {
      error:
        `SESSIONS_DIR (${s}) must not overlap FIXTURES_DIR (${f}): a session blob there ` +
        'joins the fixture whitelist, which is the list browser-use gates `read_file` on — ' +
        'the agent could be argued into reading the credential into its own context',
    };
  }
  if (contains(a, s) || contains(s, a)) {
    return {
      error:
        `SESSIONS_DIR (${s}) must not overlap ARTIFACTS_DIR (${a}): a session blob there ` +
        'sits in runs/<id>/ for ARTIFACT_RETENTION_DAYS, beside the files users download',
    };
  }
  return null;
}

// --- resolving a batch of tests' sessions -----------------------------------

/**
 * The session material for a batch of runnable tests, keyed by test id.
 *
 * Resolved HERE, before `createRun`, and not inside `startRun`. The run engine
 * is synchronous and every trigger path funnels through it; decrypting is a DB
 * read. So sessions are pre-resolved by the async caller, exactly as
 * `requireAgentKey` pre-resolves the BYOK key onto `req.runOpenaiKey` — and the
 * plaintext then lives in the in-memory run object and in one spawn's file, and
 * nowhere else.
 *
 * A session that cannot be decrypted resolves to `{ error }` and its test does
 * not run. That is the fail-closed direction on purpose: a run that quietly
 * starts unauthenticated passes nothing and fails everything, which is the
 * false green the whole story exists to remove.
 * @param {{ id: string, browser_session_id?: string|null, captures_session_id?: string|null }[]} tests
 * @returns {Promise<Map<string, { error?: string, storageState?: string,
 *                                 verify?: { url_contains: string|null, text: string|null } | null,
 *                                 captureSessionId?: string|null }>>}
 */
export async function sessionsForTests(tests) {
  /** @type {Map<string, any>} */
  const byTest = new Map();
  for (const t of tests) {
    if (t.captures_session_id) byTest.set(t.id, { captureSessionId: t.captures_session_id });
  }
  const ids = [...new Set(tests.map((t) => t.browser_session_id).filter(Boolean))];
  if (!ids.length || !db()) return byTest;

  // Spelled out as placeholders rather than bound as one array parameter:
  // pg-mem (the test harness) has no array parameter binding, and a batch is a
  // handful of sessions. routes/projects.js documents the same trap.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db().query(
    `select id, name, login_test_id, storage_state_ciphertext, verify_url_contains, verify_text
       from browser_sessions where id in (${placeholders})`,
    ids
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const t of tests) {
    if (!t.browser_session_id) continue;
    const entry = byTest.get(t.id) || {};
    const row = byId.get(t.browser_session_id);
    if (!row) {
      // The row went while the batch was being assembled. Refuse rather than
      // run unauthenticated, for the reason above.
      entry.error = 'the session this test uses no longer exists';
      byTest.set(t.id, entry);
      continue;
    }
    if (!row.storage_state_ciphertext) {
      // A session created for a login run to fill, whose login run has not
      // passed yet. Refusing is the point: running the test anyway would run it
      // signed out, and a test that quietly runs signed out passes nothing and
      // fails everything — the false green this whole story removes.
      entry.error = row.login_test_id
        ? `the session "${row.name}" has not been captured yet — run its login test first`
        : `the session "${row.name}" is empty and has no login test to fill it`;
      byTest.set(t.id, entry);
      continue;
    }
    try {
      entry.storageState = decryptSecret(Buffer.from(row.storage_state_ciphertext));
    } catch {
      // AES-GCM fails closed by design (crypto.js): a rotated
      // KEY_ENCRYPTION_SECRET or tampered bytes throw rather than returning
      // attacker-chosen plaintext. Say so, rather than starting a cold browser.
      entry.error = 'the saved session could not be decrypted — re-save it';
      byTest.set(t.id, entry);
      continue;
    }
    entry.verify =
      row.verify_url_contains || row.verify_text
        ? { url_contains: row.verify_url_contains || null, text: row.verify_text || null }
        : null;
    byTest.set(t.id, entry);
  }
  return byTest;
}

/**
 * Store what a login run captured, encrypted, against the session it refreshes.
 *
 * Called only on a PASSING run, and it is the only thing that writes this
 * column after creation. A failed login run must never touch it: refreshing is
 * "run the login test again, nightly", so a failure is not hypothetical — and
 * overwriting on one would replace a working session with an anonymous
 * browser's empty jar, turning every test in the project red at 3am for a
 * reason that points at the wrong thing.
 * @param {string} sessionId
 * @param {string} exported the raw JSON the agent wrote
 * @returns {Promise<boolean>} whether the session was refreshed
 */
export async function refreshCapturedSession(sessionId, exported) {
  const normalized = normalizeStorageState(exported);
  if ('error' in normalized) {
    // An empty jar reaches here when the login run "passed" without actually
    // signing in — an agent's self-report is not proof of a cookie.
    console.error(`session ${sessionId.slice(0, 8)}: not refreshed — ${normalized.error}`);
    return false;
  }
  const { encryptSecret } = await import('./crypto.js');
  await db().query(
    `update browser_sessions
        set storage_state_ciphertext = $2, cookie_count = $3, origin_count = $4,
            source = 'login_run', captured_at = now(), updated_at = now()
      where id = $1`,
    [sessionId, encryptSecret(normalized.storageState), normalized.cookies, normalized.origins]
  );
  return true;
}

// --- the preamble (AC #5) ---------------------------------------------------

/**
 * Validate a project's `initial_actions` as it arrives on a write. Returns
 * `{ error }` or `{ actions }` — the whole write refused rather than filtered,
 * for US-042's reason: an operator told "saved" must not later discover that
 * the one entry that mattered was silently dropped.
 * @param {unknown} raw
 * @param {import('./navigationPolicy.js').Policy} policy
 * @returns {{ error: string } | { actions: any[] }}
 */
export function normalizePreamble(raw, policy) {
  if (raw === undefined || raw === null) return { actions: [] };
  if (!Array.isArray(raw)) return { error: 'initial_actions must be an array' };
  if (raw.length > PREAMBLE_MAX_ACTIONS) {
    return { error: `a preamble may have at most ${PREAMBLE_MAX_ACTIONS} actions` };
  }
  const actions = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'each action must be an object like {"wait": {"seconds": 2}}' };
    }
    const names = Object.keys(entry);
    if (names.length !== 1) {
      return { error: 'each action must name exactly one action' };
    }
    const [name] = names;
    const validate = Object.prototype.hasOwnProperty.call(PREAMBLE_ACTIONS, name)
      ? PREAMBLE_ACTIONS[name]
      : null;
    if (!validate) {
      return {
        error:
          `${name} is not allowed in a preamble — only ${Object.keys(PREAMBLE_ACTIONS).join(', ')}. ` +
          'The rest need an element index that does not exist before the page has been looked at.',
      };
    }
    const params = validate(entry[name], policy);
    if ('error' in params) return { error: `${name}: ${params.error}` };
    actions.push({ [name]: params.value });
  }
  return { actions };
}

function navigateParams(raw, policy) {
  const url = raw && typeof raw === 'object' ? /** @type {any} */ (raw).url : null;
  if (typeof url !== 'string' || !url.trim()) return { error: 'a url is required' };
  // The same fence a start_url passes (US-042), applied at WRITE time. A
  // preamble is a list of navigations that never reaches `createRun`'s check,
  // so without this it is a documented bypass of it: one saved entry pointed at
  // the metadata endpoint, fired before every run in the project, forever.
  const blocked = checkStartUrl(url, policy);
  if (blocked) return { error: blocked.error };
  return { value: { url: url.trim() } };
}

function waitParams(raw) {
  const seconds = Number(raw && typeof raw === 'object' ? /** @type {any} */ (raw).seconds : NaN);
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: 'seconds must be a positive number' };
  if (seconds > PREAMBLE_MAX_WAIT_SECONDS) {
    return { error: `seconds must be at most ${PREAMBLE_MAX_WAIT_SECONDS}` };
  }
  return { value: { seconds } };
}

function sendKeysParams(raw) {
  const keys = raw && typeof raw === 'object' ? /** @type {any} */ (raw).keys : null;
  if (typeof keys !== 'string' || !keys.trim()) return { error: 'keys is required (e.g. "Escape")' };
  if (keys.length > 64) return { error: 'keys is too long to be a keystroke' };
  return { value: { keys } };
}

function scrollParams(raw) {
  const { down, pages } = /** @type {any} */ (raw && typeof raw === 'object' ? raw : {});
  if (down !== undefined && typeof down !== 'boolean') return { error: 'down must be a boolean' };
  const n = pages === undefined ? 1 : Number(pages);
  if (!Number.isFinite(n) || n <= 0 || n > 10) return { error: 'pages must be between 0 and 10' };
  return { value: { down: down ?? true, pages: n } };
}

/**
 * A stored preamble as the spawn reads it back. Anything unreadable resolves to
 * none.
 *
 * Fails closed in `fixtures.js`'s direction and NOT in `navigation_policy`'s,
 * and the difference is the trap. There, `[]` could not mean "allow nothing"
 * because browser-use reads an empty allowlist as falsy, so an unreadable policy
 * had to refuse to start. Here "no preamble" is the normal state of every
 * project on the instance, so resolving to it is the safe answer — refusing
 * would take out every run in a project over one bad row. Copying either
 * module's rule onto the other breaks it.
 * @param {unknown} stored the project's `initial_actions` column
 * @returns {any[]}
 */
export function preambleForRun(stored) {
  let parsed = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const actions = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const names = Object.keys(entry);
    if (names.length !== 1) continue;
    if (!Object.prototype.hasOwnProperty.call(PREAMBLE_ACTIONS, names[0])) continue;
    actions.push(entry);
  }
  return actions.slice(0, PREAMBLE_MAX_ACTIONS);
}
