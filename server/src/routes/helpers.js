// @ts-check
import { db } from '../db.js';
import { createRun } from '../runs.js';
import { OPENAI_API_KEY } from '../config.js';

/** Triggers a caller may set; 'schedule' is US-010's, not callers'. */
export const TRIGGERS = new Set(['ui', 'api', 'ci']);

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
 * Start one run per test — the shared batch runner behind suite, module and
 * project triggering (US-023). Callers pass tests already ordered; a start_url
 * override applies to all of them (US-008: point a whole group at a fresh
 * preview URL).
 * @param {{ id: string, goal: string, start_url: string, max_steps: number, model: string|null }[]} tests
 * @param {{ start_url?: string, trigger?: string }} body
 */
export function runTests(tests, body = {}) {
  const trigger = TRIGGERS.has(body.trigger) ? body.trigger : 'api';
  return tests.map((t) => {
    const run = createRun({
      goal: t.goal,
      start_url: body.start_url || t.start_url,
      max_steps: t.max_steps,
      model: t.model,
      test_id: t.id,
      trigger,
    });
    return { runId: run.id, testId: t.id, status: run.status };
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
