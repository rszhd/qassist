// @ts-check
// Stripe subscription billing (US-022), env-gated. Holds three things: whether
// billing is on at all, whether a given user may start a run, and the Stripe
// wire protocol (three form-encoded POSTs and one HMAC).
//
// No SDK, deliberately — the same call the mail.js transport makes: "a
// dependency that wraps that would be more code to audit than the code it
// replaces". `stripe` would be the fourth runtime dependency after
// express/pg/ws, for a surface this file states in full.
//
// Correctness-critical (backlog/correctness-critical.md): the entitlement
// decision is pinned assertion-first in billing-gate.test.js, the webhook —
// the one endpoint a stranger can POST to — in billing-webhook.test.js, and
// the self-host free path in billing-off.test.js.
import crypto from 'node:crypto';
import { db } from './db.js';
import { authEnabled } from './auth.js';
import {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_API_URL,
  BILLING_EXEMPT_EMAILS,
  PUBLIC_BASE_URL,
} from './config.js';

// --- the switch ---

/**
 * The pure form of billingEnabled(), so "missing any one leaves the instance
 * byte-for-byte free" is one assertion table rather than six deployments.
 * Every part is load-bearing: the three Stripe values are the integration,
 * `baseUrl` is where Checkout sends the customer back, `hasDb` is where a
 * subscription is stored, and `authOn` is the existence of users to charge.
 * @param {{ secretKey: string, webhookSecret: string, priceId: string,
 *           baseUrl: string, hasDb: boolean, authOn: boolean }} parts
 */
export function billingReady({ secretKey, webhookSecret, priceId, baseUrl, hasDb, authOn }) {
  return !!(secretKey && webhookSecret && priceId && baseUrl && hasDb && authOn);
}

/**
 * Whether this instance charges for runs. False on every self-hosted default,
 * and false in the demo sandbox — AUTH_MODE=demo leaves authEnabled() false,
 * so a demo deployment is ungated by construction rather than by a branch.
 */
export function billingEnabled() {
  return billingReady({
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    priceId: STRIPE_PRICE_ID,
    baseUrl: PUBLIC_BASE_URL,
    hasDb: !!db(),
    authOn: authEnabled(),
  });
}

// --- the entitlement decision ---

/** Statuses that entitle outright. `trialing` is here so turning a trial on
 *  later is a Stripe dashboard change, not a code change (decision 4). */
const ENTITLED = new Set(['active', 'trialing']);

/**
 * May this subscription row start a run? `past_due` keeps running until the
 * period it paid for ends (decision 3): Stripe retries a declined card for
 * ~2 weeks, and cutting a paying customer's overnight schedules off on the
 * first failed retry is the worse of the two bugs. With no period end there is
 * no period that was paid for, so it fails closed.
 * @param {{ status?: string|null, current_period_end?: Date|string|null } | null} sub
 * @param {{ now?: number }} [opts]
 */
export function entitledFrom(sub, { now = Date.now() } = {}) {
  if (!sub || !sub.status) return false;
  if (ENTITLED.has(sub.status)) return true;
  if (sub.status !== 'past_due') return false;
  const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : NaN;
  return Number.isFinite(end) && end > now;
}

/** @param {string|null|undefined} email */
export function isExempt(email) {
  return !!email && BILLING_EXEMPT_EMAILS.includes(email.toLowerCase());
}

/**
 * Everything the gate and the Settings panel need about one user, in one
 * query: their subscription (if any), whether they are exempt, and the verdict.
 * @param {string|null} userId
 */
export async function billingStateFor(userId) {
  const none = { entitled: false, exempt: false, status: null, current_period_end: null, customerId: null };
  if (!userId || !db()) return none;
  const { rows } = await db().query(
    `select u.email, s.status, s.current_period_end, s.stripe_customer_id
       from users u left join subscriptions s on s.user_id = u.id
      where u.id = $1`,
    [userId]
  );
  if (!rows.length) return none;
  const row = rows[0];
  const exempt = isExempt(row.email);
  return {
    entitled: exempt || entitledFrom(row),
    exempt,
    status: row.status ?? null,
    current_period_end: row.current_period_end ?? null,
    customerId: row.stripe_customer_id ?? null,
  };
}

/**
 * May this user start a run? Always true when billing is off, which is what
 * keeps the scheduler and the route gate free of `if (billingEnabled())` at
 * every call site.
 * @param {string|null} userId
 */
export async function isEntitled(userId) {
  if (!billingEnabled()) return true;
  return (await billingStateFor(userId)).entitled;
}

// --- webhook: signature, ledger, apply ---

/** Stripe's own tolerance for a signed payload's age, either side of now. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a `Stripe-Signature` header against the exact bytes it covers:
 * `t=<unix-seconds>,v1=<hex>`, where the MAC is HMAC-SHA256 over
 * `${t}.${rawBody}`. This is the webhook's *only* authentication — Stripe
 * holds no credential of ours — so it is total: every malformed input returns
 * false rather than throwing, and the comparison is length-checked before
 * timingSafeEqual, which throws on a length mismatch.
 *
 * Several `v1=` entries are accepted if any matches: that is how Stripe's
 * endpoint-secret rotation delivers, and rejecting them would break a rotation.
 * @param {string|Buffer} raw the untouched request body
 * @param {string} header
 * @param {{ now?: number, secret?: string }} [opts]
 */
export function verifyWebhookSignature(raw, header, { now = Date.now(), secret = STRIPE_WEBHOOK_SECRET } = {}) {
  if (typeof header !== 'string' || !header || !secret) return false;

  /** @type {string|null} */
  let timestamp = null;
  /** @type {string[]} */
  const candidates = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't' && timestamp === null) timestamp = value;
    else if (key === 'v1') candidates.push(value);
  }
  // Bounded digits, not just Number(): an absurdly long "timestamp" would
  // otherwise reach the HMAC as a signed payload we computed for the attacker.
  if (timestamp === null || !candidates.length || !/^\d{1,15}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'));
  const expected = Buffer.from(hmac.digest('hex'), 'utf8');
  return candidates.some((candidate) => {
    const got = Buffer.from(candidate, 'utf8');
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  });
}

/**
 * Record an event id, returning false if it was already recorded. The primary
 * key does the work: Stripe retries deliveries, and a conflicting insert is
 * exactly the statement "we have applied this one".
 * @param {{ id?: string, type?: string }} event
 */
export async function claimEvent(event) {
  if (!event || typeof event.id !== 'string' || !event.id) return false;
  const { rowCount } = await db().query(
    'insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing',
    [event.id, String(event.type || '')]
  );
  return rowCount === 1;
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Write one event's effect on a subscription. Two shapes reach here:
 *
 *  - `checkout.session.completed` is the JOIN — the only event that knows which
 *    of our users a Stripe customer is, via the `client_reference_id` we set on
 *    the session. It carries no subscription status, so a settled payment is
 *    taken as active and anything else waits for the subscription event behind
 *    it. We deliberately do not call Stripe back to read the subscription.
 *  - `customer.subscription.*` addresses the customer, and is resolved back to
 *    a user through the row the join wrote. An event for a customer we have
 *    never seen invents nothing: user_id is the primary key, and there is no
 *    user to key a row on.
 *
 * Anything else is ignored — the endpoint acknowledges every event it can
 * verify, so Stripe does not retry what we chose not to act on.
 * @param {any} event
 */
export async function applySubscriptionEvent(event) {
  const object = event?.data?.object || {};
  const at = new Date(Number(event?.created || 0) * 1000);
  if (!Number.isFinite(at.getTime())) return;

  if (event.type === 'checkout.session.completed') {
    if (!object.client_reference_id || !object.customer) return;
    await writeSubscription({
      userId: String(object.client_reference_id),
      customerId: String(object.customer),
      subscriptionId: object.subscription ? String(object.subscription) : null,
      status: object.payment_status === 'paid' ? 'active' : 'incomplete',
      periodEnd: null,
      at,
    });
    return;
  }

  if (!SUBSCRIPTION_EVENTS.has(event.type) || !object.customer) return;
  const { rows } = await db().query(
    'select user_id from subscriptions where stripe_customer_id = $1',
    [String(object.customer)]
  );
  if (!rows.length) return;
  await writeSubscription({
    userId: rows[0].user_id,
    customerId: String(object.customer),
    subscriptionId: object.id ? String(object.id) : null,
    status:
      event.type === 'customer.subscription.deleted' ? 'canceled' : String(object.status || 'incomplete'),
    periodEnd: object.current_period_end ? new Date(Number(object.current_period_end) * 1000) : null,
    at,
  });
}

/**
 * Upsert a subscription, refusing anything older than what is already applied.
 * The `last_event_at <= $6` guard is the whole out-of-order defence: webhooks
 * are not ordered, and an `updated` generated before a cancellation but
 * delivered after it would otherwise hand a cancelled customer the product.
 * Equal timestamps apply — `checkout.session.completed` and
 * `customer.subscription.created` routinely share a second, and we need both.
 * @param {{ userId: string, customerId: string, subscriptionId: string|null,
 *           status: string, periodEnd: Date|null, at: Date }} fields
 */
async function writeSubscription({ userId, customerId, subscriptionId, status, periodEnd, at }) {
  const params = [userId, customerId, subscriptionId, status, periodEnd, at];
  const { rowCount } = await db().query(
    `update subscriptions
        set stripe_customer_id     = $2,
            stripe_subscription_id = coalesce($3::text, stripe_subscription_id),
            status                 = $4,
            current_period_end     = coalesce($5::timestamptz, current_period_end),
            last_event_at          = $6,
            updated_at             = now()
      where user_id = $1
        and (last_event_at is null or last_event_at <= $6)`,
    params
  );
  if (rowCount) return;
  // Either there is no row yet (insert it) or the update was refused as stale
  // (the conflict then makes this a no-op, which is the point).
  await db().query(
    `insert into subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, last_event_at)
     values ($1, $2, $3::text, $4, $5::timestamptz, $6)
     on conflict (user_id) do nothing`,
    params
  );
}

// --- transport: the three calls we make to Stripe ---

/**
 * One form-encoded POST to the Stripe API. Throws on a non-2xx so the route
 * can report the reason rather than lose it to a log line (as mail.js does).
 * @param {string} pathname
 * @param {Record<string, string>} form
 */
async function stripePost(pathname, form) {
  const res = await fetch(`${STRIPE_API_URL}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`stripe ${pathname} ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

/**
 * A Checkout session for one subscription to the single configured price.
 * `client_reference_id` is how the completed-session webhook finds the user —
 * it is the only thread between a Stripe customer and an account here.
 * No `trial_period_days` (decision 4): the demo sandbox is the
 * try-before-you-buy path, and it needs no card and no cleanup.
 * @param {{ userId: string, email?: string|null, customerId?: string|null }} user
 * @returns {Promise<string>} the URL to send the browser to
 */
export async function createCheckoutSession({ userId, email, customerId }) {
  /** @type {Record<string, string>} */
  const form = {
    mode: 'subscription',
    'line_items[0][price]': STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    success_url: `${PUBLIC_BASE_URL}/?billing=success`,
    cancel_url: `${PUBLIC_BASE_URL}/?billing=cancelled`,
  };
  // Reuse the customer once we know it, so a resubscribe doesn't create a
  // second Stripe customer for the same person.
  if (customerId) form.customer = customerId;
  else if (email) form.customer_email = email;
  return (await stripePost('/checkout/sessions', form)).url;
}

/**
 * A Customer Portal session — Stripe hosts card updates, invoices and
 * cancellation, so none of that is UI we own.
 * @param {string} customerId
 * @returns {Promise<string>}
 */
export async function createPortalSession(customerId) {
  const session = await stripePost('/billing_portal/sessions', {
    customer: customerId,
    return_url: `${PUBLIC_BASE_URL}/`,
  });
  return session.url;
}
