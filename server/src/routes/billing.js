// @ts-check
// Billing routes (US-022). The whole router is empty — so every path under it
// 404s — unless billingEnabled(), which is the self-hosted default: nothing
// about the paid tier is discoverable on a free instance.
//
// The webhook is NOT here. It needs the raw request body (its signature covers
// the exact bytes Stripe sent) and so is mounted in server.js ahead of
// express.json(); only its handler lives in this file.
import express from 'express';
import { currentUserId, db } from '../db.js';
import {
  billingEnabled,
  billingStateFor,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  claimEvent,
  applySubscriptionEvent,
} from '../billing.js';
import { h } from './helpers.js';

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function billingRouter({ checkToken }) {
  const r = express.Router();
  if (!billingEnabled()) return r;
  r.use(checkToken);

  // What the Settings panel renders, and what the 402's CTA reads.
  r.get(
    '/status',
    h(async (_req, res) => {
      const state = await billingStateFor(currentUserId());
      res.json({
        entitled: state.entitled,
        exempt: state.exempt,
        status: state.status,
        current_period_end: state.current_period_end,
        // Set only while a cancellation is scheduled: the status is still
        // 'active', so this is the one thing that tells the customer it took.
        cancel_at: state.cancel_at,
        // Whether "Manage billing" can be offered at all: the portal needs a
        // Stripe customer, which only exists after a first checkout.
        manageable: !!state.customerId,
      });
    })
  );

  r.post(
    '/checkout',
    h(async (_req, res) => {
      const userId = currentUserId();
      const state = await billingStateFor(userId);
      const { rows } = await db().query('select email from users where id = $1', [userId]);
      const url = await createCheckoutSession({
        userId: /** @type {string} */ (userId),
        email: rows[0]?.email,
        customerId: state.customerId,
      });
      res.json({ url });
    })
  );

  r.post(
    '/portal',
    h(async (_req, res) => {
      const state = await billingStateFor(currentUserId());
      if (!state.customerId) {
        return res.status(409).json({ error: 'no subscription to manage yet — subscribe first' });
      }
      res.json({ url: await createPortalSession(state.customerId) });
    })
  );

  return r;
}

/**
 * The webhook handler. Unauthenticated by design: Stripe has no credential of
 * ours, so the signature *is* the authentication, and `req.body` must be the
 * untouched bytes it was computed over (server.js mounts express.raw here).
 *
 * Every verified event is acknowledged with 200, including ones we ignore —
 * a non-2xx tells Stripe to retry, and retrying something we deliberately
 * dropped just fills their dashboard with failures.
 * @type {import('express').RequestHandler}
 */
export function billingWebhookHandler(req, res, next) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhookSignature(raw, String(req.headers['stripe-signature'] || ''))) {
    // Deliberately terse and 400: there is no credential to have got wrong,
    // only bytes that don't verify, and an attacker learns nothing from it.
    res.status(400).json({ error: 'invalid signature' });
    return;
  }
  /** @type {any} */
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }
  if (!event || typeof event.id !== 'string') {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }

  (async () => {
    if (!(await claimEvent(event))) return res.json({ received: true, duplicate: true });
    await applySubscriptionEvent(event);
    res.json({ received: true });
  })().catch(next);
}
