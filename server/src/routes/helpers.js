// @ts-check
import { db, currentUserId } from '../db.js';
import { demoMode } from '../auth.js';
import { runTests } from '../runs.js';
import { validOpenaiKeyShape } from '../crypto.js';
import { getUserOpenaiKey, resolveRunKey } from '../openaiKey.js';
import { billingEnabled } from '../billing.js';
import { runGateFor, retryAfterSeconds } from '../activation.js';
import { refreshUserConcurrencyCap } from '../concurrency.js';

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

// Resolve which OpenAI key a run will use and refuse the run if there is none,
// rather than letting the agent die on the first LLM call. Applies to every
// route that starts a run. BYOK (US-005/US-039): a per-request `openai_api_key`
// wins over the caller's stored key, and there is nothing after that — the
// instance never funds a run out of its own pocket. The resolved value is
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
    // The stored key is the request user's when auth is on and the seeded
    // operator's when it is off (currentUserId covers both), so a solo
    // self-host stores its key exactly like a tenant does. Not decrypted when
    // a request key is present — precedence says it could never win.
    const storedKey = requestKey ? null : await getUserOpenaiKey(currentUserId());
    const key = resolveRunKey({ requestKey, storedKey });
    if (!key) {
      // One message for every mode. Someone who registered on an instance they
      // don't operate has no `.env` to edit; Settings is what they can act on.
      res.status(503).json({ error: 'no OpenAI key: add yours in Settings' });
      return;
    }
    /** @type {any} */ (req).runOpenaiKey = key;
    next();
  })().catch(next);
}

/**
 * The run-start gate: refuse an account that may not start a run, for either of
 * the two reasons it may not. A no-op unless billingEnabled(), so on a
 * self-hosted instance — and in the demo sandbox, where authEnabled() is false —
 * this returns before it can touch anything.
 *
 * Both gates, one middleware and one database read, deliberately (US-054):
 * every route that has the billing check therefore has the activation check
 * too, and "one of the start paths missed it" stops being a thing that can
 * happen by omission. Entitlement answers first — an account that has not paid
 * hears "pay", not "wait for capacity you never bought".
 *
 * Sits *before* requireAgentKey on every run-starting route: a caller who is
 * blocked here should hear the thing that is actually blocking them, not
 * "configure a key" they would then still be refused for.
 *
 * Unlike US-028's per-user cap this refuses the whole request rather than
 * partial-accepting a batch — neither entitlement nor activation varies between
 * the members of a suite, so there is nothing to accept.
 * @type {import('express').RequestHandler}
 */
export function requireEntitled(req, res, next) {
  if (!billingEnabled()) return next();
  (async () => {
    const gate = await runGateFor(currentUserId());
    if (gate.allow) return next();

    if (gate.reason === 'activation') {
      const { activation } = gate;
      // 503, not the 402: the caller has paid, nothing is wrong with their
      // request, and the correct instruction to a CI runner is come back later.
      // `activation_pending` is what distinguishes this from the keyless 503,
      // the same way `billing_required` distinguishes the 402.
      res.set('Retry-After', String(retryAfterSeconds(activation)));
      res.status(503).json({
        error:
          'your workspace is being prepared — this instance is adding capacity for your account, ' +
          'and we will email you the moment it is ready',
        activation_pending: true,
        activation_deadline: activation.deadline ? activation.deadline.toISOString() : null,
      });
      return;
    }

    // 402 rather than 403 so a CI caller can tell "you must pay" from "your
    // token is wrong". `subscription_status` lets the UI say "resubscribe"
    // rather than "subscribe" to someone who used to pay.
    res.status(402).json({
      error: 'an active subscription is required to start runs — subscribe in Settings',
      billing_required: true,
      subscription_status: gate.state.status,
    });
  })().catch(next);
}

/**
 * Re-read the caller's per-user concurrency override before their run is
 * admitted (US-058). The operator sets it with `npm run concurrency`, which
 * runs in its own process and so cannot reach this one's cache — this is what
 * makes their write land on the account's next submit rather than at the next
 * restart, and a restart would kill every run in flight on a box that is
 * serving.
 *
 * Its own middleware rather than folded into requireEntitled (which returns
 * before its DB read when billing is off, and a self-hoster needs the override
 * just as much) or requireAgentKey (waived in demo mode, skipped when the
 * request brings its own key). Not in the request gate either: that runs on
 * every media byte and history page, and this is one query the run paths owe.
 *
 * Unlike the billing and activation gates, a start path that missed this would
 * fall back to the instance default — a stale cap, not an open door — so it is
 * deliberately not fused into them the way US-054 fused activation into billing.
 * @type {import('express').RequestHandler}
 */
export function withUserCap(_req, _res, next) {
  if (!db()) return next();
  refreshUserConcurrencyCap(currentUserId())
    .then(() => next())
    // A cap that can't be read is a cap that isn't overridden: fall through to
    // the instance default rather than refusing a run over a cache refresh.
    .catch(() => next());
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
