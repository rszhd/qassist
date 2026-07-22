// @ts-check
import { db } from '../db.js';
import { OPENAI_API_KEY } from '../config.js';

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
