// @ts-check
// The webhook's idempotency ledger, against real Postgres (US-022).
//
// billing-webhook.test.js runs on pg-mem and covers everything about the
// endpoint that is DB-independent — signatures, replay windows, ordering. It
// cannot cover this one, and not by a little: pg-mem reports rowCount 1 (and
// yields a `returning` row) for an `insert … on conflict do nothing` that
// conflicted, where Postgres reports 0 and yields nothing. `claimEvent` IS that
// distinction, so on pg-mem an implementation with no idempotency whatsoever
// passes. Same class as the scheduler claim, and handled the same way: ask for
// a real server, skip when there isn't one.
//
// What is proven here:
//   L1  a second delivery of a seen event id changes nothing — not merely
//       "responds 200", but leaves state the event would have moved.
//   L2  CONCURRENT deliveries of the same id apply exactly once. This is the
//       real threat: Stripe retries in parallel with the original, and a
//       check-then-insert claim would let both through. Nothing but a real
//       server can demonstrate it.
//   L3  the out-of-order guard holds under real timestamp precision — Postgres
//       keeps microseconds where pg-mem keeps milliseconds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_billing_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** @type {pg.Pool | null} */
let pool = null;
/** @type {boolean | string} */
let skip = false;

try {
  const admin = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 2000 });
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const url = new URL(CONNECTION);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString() });
} catch (err) {
  skip = `no Postgres at ${new URL(CONNECTION).host} (${err.code || err.message})`;
  console.log(`billing-webhook-postgres: skipped — ${skip}`);
}

/** @type {any} */
let billing;
let ALICE = '';

before(async () => {
  if (skip || !pool) return;
  // Billing must be ON for isEntitled() to consult the row rather than
  // short-circuit; these are the same preconditions billingEnabled() ANDs.
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = 'test-session-secret-0123456789';
  process.env.MAIL_DEV_CONSOLE = '1';
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_billing';
  process.env.STRIPE_PRICE_ID = 'price_test_123';
  process.env.PUBLIC_BASE_URL = 'https://qassist.test';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  billing = await import('../src/billing.js');
  ALICE = (
    await pool.query('insert into users (email) values ($1) returning id', ['alice@example.test'])
  ).rows[0].id;
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

const now = () => Math.floor(Date.now() / 1000);
const CUSTOMER = 'cus_alice';

// Current API shape (US-051 W8): the period end is on the subscription item,
// with nothing at the top level. Every fixture in the suite builds this shape,
// so none of them can mask a reader that looks only where Stripe used to put it.
const subscriptionEvent = (type, { id = `evt_${randomUUID()}`, created = now(), status = 'active' } = {}) => ({
  id,
  type,
  created,
  data: {
    object: {
      id: 'sub_alice',
      customer: CUSTOMER,
      status,
      cancel_at: null,
      items: { object: 'list', data: [{ id: 'si_alice', current_period_end: created + 86400 }] },
    },
  },
});

const statusOf = async () =>
  (await pool.query('select status from subscriptions where user_id = $1', [ALICE])).rows[0]?.status ?? null;

test('claimEvent is true once and false forever after (L1)', { skip }, async () => {
  const event = { id: 'evt_claim_once', type: 'customer.subscription.updated' };
  assert.equal(await billing.claimEvent(event), true, 'first sight claims it');
  assert.equal(await billing.claimEvent(event), false, 'a conflicting insert means already processed');
  assert.equal(await billing.claimEvent(event), false);
});

test('a repeated event does not re-apply — state it would move is left alone (L1)', { skip }, async () => {
  // Join the customer to the user first; that row is what the update addresses.
  await billing.applySubscriptionEvent({
    id: 'evt_join',
    type: 'checkout.session.completed',
    created: now(),
    data: { object: { client_reference_id: ALICE, customer: CUSTOMER, subscription: 'sub_alice', payment_status: 'paid' } },
  });

  const event = subscriptionEvent('customer.subscription.updated', {
    id: 'evt_repeat',
    status: 'past_due',
    created: now() + 5,
  });
  assert.equal(await billing.claimEvent(event), true);
  await billing.applySubscriptionEvent(event);
  assert.equal(await statusOf(), 'past_due');

  // Move the row somewhere the event would move it away from, then redeliver.
  // A caller that ignored claimEvent's answer would drag it back to past_due.
  await pool.query("update subscriptions set status = 'active' where user_id = $1", [ALICE]);
  if (await billing.claimEvent(event)) await billing.applySubscriptionEvent(event);
  assert.equal(await statusOf(), 'active', 'the redelivery was dropped, not applied a second time');
});

test('concurrent deliveries of one event id apply exactly once (L2)', { skip }, async () => {
  const event = subscriptionEvent('customer.subscription.updated', {
    id: 'evt_concurrent',
    status: 'unpaid',
    created: now() + 10,
  });
  // Stripe retries in parallel with the original delivery. A check-then-insert
  // claim lets every racer through; the primary key lets exactly one.
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => billing.claimEvent(event).catch(() => 'threw'))
  );
  assert.equal(
    claims.filter((c) => c === true).length,
    1,
    'exactly one racer claims the event'
  );
  assert.equal(claims.filter((c) => c === 'threw').length, 0, 'the losers are refused, not errors');

  const { rows } = await pool.query('select count(*)::int as n from stripe_events where id = $1', [event.id]);
  assert.equal(rows[0].n, 1);
});

test('the stale-event guard holds at real timestamp precision (L3)', { skip }, async () => {
  const base = now() + 100;
  await billing.applySubscriptionEvent(
    subscriptionEvent('customer.subscription.deleted', { id: 'evt_pg_del', created: base, status: 'canceled' })
  );
  assert.equal(await statusOf(), 'canceled');

  await billing.applySubscriptionEvent(
    subscriptionEvent('customer.subscription.updated', { id: 'evt_pg_stale', created: base - 1, status: 'active' })
  );
  assert.equal(await statusOf(), 'canceled', 'a stale event cannot resurrect a cancelled subscription');
  assert.equal(await billing.isEntitled(ALICE), false);

  await billing.applySubscriptionEvent(
    subscriptionEvent('customer.subscription.updated', { id: 'evt_pg_fresh', created: base + 1, status: 'active' })
  );
  assert.equal(await billing.isEntitled(ALICE), true, 'a genuine resubscribe still lands');
});
