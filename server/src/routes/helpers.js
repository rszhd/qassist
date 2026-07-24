// @ts-check
import { db, currentUserId } from '../db.js';
import { authEnabled, demoMode } from '../auth.js';
import { runTests } from '../runs.js';
import { validOpenaiKeyShape } from '../crypto.js';
import { getUserOpenaiKey, resolveRunKey } from '../openaiKey.js';
import { OPENAI_API_KEY } from '../config.js';

/** Triggers a caller may set; 'schedule' is US-010's, not callers'. */
export const TRIGGERS = new Set(['ui', 'api', 'ci']);

/**
 * Every trigger a stored run can carry — the claimable ones plus the
 * scheduler's. History filters on this wider set: a caller may not *say* a run
 * was scheduled, but it may certainly ask to see the ones that were.
 */
export const STORED_TRIGGERS = new Set([...TRIGGERS, 'schedule']);

/**
 * Express 4 doesn't catch async errors — wrap handlers so rejections reach
 * the error middleware instead of crashing the process.
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<any>} fn
 * @returns {import('express').RequestHandler}
 */
export function h(fn) {
  return (req, res, next) => fn(req, res).catch(next);
}

// Resolve which OpenAI key a run will use and fail fast if there is none, rather
// than letting the agent die on the first LLM call. Applies to every route that
// starts a run. BYOK (US-005): a per-request `openai_api_key` wins over the
// caller's stored key, which wins over the server key. The resolved value is
// stashed on `req.runOpenaiKey` for the handler to pass into the run — never
// echoed back. Async because the stored key is decrypted from the DB.
/** @type {import('express').RequestHandler} */
export function requireAgentKey(req, res, next) {
  // US-036: a demo deployment runs no agent — every run is a replay, so it needs
  // no model key. Waive the gate rather than force a dummy key into the env.
  if (demoMode()) return next();

  const requestKey = String((req.body || {}).openai_api_key || '').trim();
  if (requestKey && !validOpenaiKeyShape(requestKey)) {
    res.status(400).json({ error: 'that does not look like an OpenAI key (expected sk-…)' });
    return;
  }

  (async () => {
    const uid = authEnabled() ? currentUserId() : null;
    const storedKey = uid ? await getUserOpenaiKey(uid) : null;
    const key = resolveRunKey({ requestKey, storedKey });
    if (!key && !OPENAI_API_KEY) {
      res.status(503).json({
        error: authEnabled()
          ? 'no OpenAI key: add yours in Settings, or the operator can set OPENAI_API_KEY'
          : 'OPENAI_API_KEY is not set — copy .env.example to .env, add your key, ' +
            'then restart with: docker compose up -d',
      });
      return;
    }
    /** @type {any} */ (req).runOpenaiKey = key;
    next();
  })().catch(next);
}

/** @type {import('express').RequestHandler} */
export function requireDb(_req, res, next) {
  if (!db()) {
    res.status(503).json({ error: 'saved tests need the control plane: set DATABASE_URL' });
    return;
  }
  next();
}

/**
 * The batch enqueue as an HTTP caller reaches it: same runs.js `runTests`, but
 * the trigger is whatever the request claimed, filtered to what a caller is
 * allowed to say it is. The scheduler calls runTests directly with 'schedule'.
 * @param {{ id: string, goal: string, start_url: string, max_steps: number, model: string|null, variables?: any }[]} tests
 * @param {{ start_url?: string, trigger?: string, variables?: Record<string, string> }} body
 * @param {string|null} [openaiApiKey] the run key requireAgentKey resolved (req.runOpenaiKey)
 */
export function runTestsFromRequest(tests, body = {}, openaiApiKey = null) {
  return runTests(tests, {
    start_url: body.start_url,
    variables: body.variables,
    trigger: TRIGGERS.has(body.trigger) ? body.trigger : 'api',
    openai_api_key: openaiApiKey,
  });
}

/**
 * A single-run route's 429 when the caller is over their per-user cap (US-028).
 * The message names the cap — this is a "wait a moment", not a failure, and the
 * UI renders it as such. Batch routes don't use this: they partial-accept and
 * report rejected members in their 200 array instead.
 * @param {import('express').Response} res
 * @param {{ cap: number, inFlight: number }} rejected the marker createRun returned
 */
export function respondOverCap(res, rejected) {
  res.status(429).json({
    error:
      `you already have ${rejected.inFlight} run${rejected.inFlight === 1 ? '' : 's'} ` +
      `in flight (limit ${rejected.cap}) — wait for one to finish`,
    cap: rejected.cap,
    inFlight: rejected.inFlight,
  });
}

/**
 * URL-safe slug: lowercase, non-alphanumerics collapsed to single dashes.
 * Generated once at create time and independently editable afterwards — a
 * rename must never silently break a CI config (US-023 decision 8).
 * @param {string} value
 */
export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
