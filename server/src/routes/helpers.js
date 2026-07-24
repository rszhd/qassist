// @ts-check
import { db } from '../db.js';
import { runTests } from '../runs.js';
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

// Fail fast and legibly rather than letting the agent die on the first LLM
// call. Applies to every route that starts a run.
/** @type {import('express').RequestHandler} */
export function requireAgentKey(_req, res, next) {
  if (!OPENAI_API_KEY) {
    res.status(503).json({
      error:
        'OPENAI_API_KEY is not set — copy .env.example to .env, add your key, ' +
        'then restart with: docker compose up -d',
    });
    return;
  }
  next();
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
 */
export function runTestsFromRequest(tests, body = {}) {
  return runTests(tests, {
    start_url: body.start_url,
    variables: body.variables,
    trigger: TRIGGERS.has(body.trigger) ? body.trigger : 'api',
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
