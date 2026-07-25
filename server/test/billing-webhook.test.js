// @ts-check
// US-022 — assertion-first spec for the STRIPE WEBHOOK, the one endpoint on the
// instance a stranger can POST to. It carries no bearer (Stripe holds no
// credential of ours), so its signature IS its authentication, and what it
// writes is the entitlement decision itself. A forged, replayed or out-of-order
// event that lands is either free service or a paying customer cut off.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — decisions encoded here that I could NOT derive from the story.
// Edit the assertions directly; they are the spec.
//
//   W1  Stripe's scheme, reimplemented (story decision 9, no SDK):
//         header  Stripe-Signature: t=<unix-seconds>,v1=<hex>[,v1=<hex>…]
//         signed  HMAC-SHA256(STRIPE_WEBHOOK_SECRET, `${t}.${rawBody}`)
//       Multiple v1= entries are accepted if ANY matches — that is how Stripe's
//       own secret rotation works, and rejecting them would break a rotation.
//       Tolerance: 300s either side. [REVIEW: the 300s window.]
//
//   W2  The route is mounted in server.js BEFORE express.json(), with
//       express.raw({type:'application/json'}). The whitespace case below is the
//       real proof: the body is signed with odd spacing and key order, so a
//       re-serialized body would produce a different MAC and fail.
//
//   W3  Responses: bad signature → 400; unparseable JSON → 400; already-seen
//       event id → 200 (Stripe must not retry something we deliberately
//       dropped); unknown event type → 200 and no write. [REVIEW: 400 vs 401
//       for a bad signature — I chose 400 because there is no credential to
//       have got wrong, only bytes that don't verify.]
//
//   W4  ORDERING uses the event's own `created` (unix seconds) against the
//       stored `last_event_at`: strictly-older is DROPPED, equal is APPLIED.
//       Equal must apply because checkout.session.completed and
//       customer.subscription.created routinely share a second and we need
//       both. [REVIEW: the equal-applies tiebreak.]
//
//   W5  checkout.session.completed is the JOIN: `client_reference_id` is the
//       user id we put on the Checkout session, `customer`/`subscription` are
//       the Stripe ids. Status comes from `payment_status === 'paid'` → active;
//       anything else leaves the row unentitled and waits for a subscription
//       event. The session object carries no status/current_period_end, and
//       decision 9 says no SDK — so we do NOT call back to Stripe to fetch it.
//       [REVIEW: this is the load-bearing shortcut. Confirm, or tell me to make
//       one GET /v1/subscriptions/<id> the exception to "three POSTs".]
//
//   W6  A subscription event whose `customer` we've never seen is CLAIMED
//       (recorded in stripe_events) and otherwise ignored — no row is invented,
//       because user_id is the primary key and we have no user to key it on.
//       Safe because the join event is what entitles; an update that arrives
//       before it can only ever have been a not-yet-paid state. [REVIEW.]
//
//   W7  "Timing-safe" is asserted structurally — that comparison never throws
//       on a length mismatch or non-hex input, which is the bug
//       crypto.timingSafeEqual actually causes when used naively. Timing itself
//       isn't observable from a test; flagging rather than pretending.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK_SECRET = 'whsec_test_billing';
const HOOK = '/api/billing/webhook';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {any} */
let billing;
let ALICE = '';
let BOB = '';

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-billing-hook-'));
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = 'test-session-secret-0123456789';
  process.env.MAIL_DEV_CONSOLE = '1';
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_ID = 'price_test_123';
  process.env.PUBLIC_BASE_URL = 'https://qassist.test';
  delete process.env.AUTH_MODE;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  billing = await import('../src/billing.js');
  ({ app } = await import('../src/server.js'));

  ALICE = (await pool.query('insert into users (email) values ($1) returning id', ['alice@example.test'])).rows[0].id;
  BOB = (await pool.query('insert into users (email) values ($1) returning id', ['bob@example.test'])).rows[0].id;
});

beforeEach(async () => {
  await pool.query('delete from subscriptions');
  await pool.query('delete from stripe_events');
});

// --- harness -----------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

/** Stripe's Stripe-Signature header for exact bytes. */
function sign(raw, { secret = WEBHOOK_SECRET, t = now() } = {}) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** POST raw bytes with a header we control completely (no bearer, ever). */
const post = (raw, signature) =>
  request(app).post(HOOK).set('Content-Type', 'application/json').set('Stripe-Signature', signature).send(raw);

/** A checkout.session.completed that joins `uid` to a Stripe customer. */
const checkoutEvent = (uid, { id = `evt_${randomUUID()}`, created = now(), customer = `cus_${uid.slice(0, 8)}`, subscription = `sub_${uid.slice(0, 8)}`, payment_status = 'paid' } = {}) => ({
  id,
  type: 'checkout.session.completed',
  created,
  data: { object: { client_reference_id: uid, customer, subscription, payment_status, status: 'complete' } },
});

/** A customer.subscription.* event, addressed by Stripe customer id. */
const subscriptionEvent = (type, customer, { id = `evt_${randomUUID()}`, created = now(), status = 'active', periodEnd = now() + 86400 } = {}) => ({
  id,
  type,
  created,
  data: { object: { id: `sub_${customer.slice(4)}`, customer, status, current_period_end: periodEnd } },
});

/** Deliver an event exactly as Stripe would. */
const deliver = (event, opts = {}) => {
  const raw = JSON.stringify(event);
  return post(raw, sign(raw, opts));
};

const subscriptionOf = async (uid) =>
  (await pool.query('select * from subscriptions where user_id = $1', [uid])).rows[0] || null;

// --- W5: the join, and what it entitles -------------------------------------

test('checkout.session.completed joins the Stripe customer to the right user and entitles them', async () => {
  await deliver(checkoutEvent(ALICE)).expect(200);

  const sub = await subscriptionOf(ALICE);
  assert.ok(sub, 'a subscriptions row exists for the user named by client_reference_id');
  assert.equal(sub.stripe_customer_id, `cus_${ALICE.slice(0, 8)}`);
  assert.equal(sub.stripe_subscription_id, `sub_${ALICE.slice(0, 8)}`);
  assert.equal(sub.status, 'active', 'payment_status=paid is what makes it active (W5)');
  assert.equal(await billing.isEntitled(ALICE), true);
  assert.equal(await billing.isEntitled(BOB), false, 'nobody else was touched');
});

test('an unpaid checkout session does not entitle', async () => {
  await deliver(checkoutEvent(ALICE, { payment_status: 'unpaid' })).expect(200);
  assert.equal(await billing.isEntitled(ALICE), false);
});

test('a later customer.subscription.deleted blocks that user and nobody else', async () => {
  await deliver(checkoutEvent(ALICE)).expect(200);
  await deliver(checkoutEvent(BOB)).expect(200);
  assert.equal(await billing.isEntitled(BOB), true);

  await deliver(
    subscriptionEvent('customer.subscription.deleted', `cus_${ALICE.slice(0, 8)}`, {
      status: 'canceled',
      created: now() + 10,
    })
  ).expect(200);

  assert.equal(await billing.isEntitled(ALICE), false);
  assert.equal(await billing.isEntitled(BOB), true, 'one cancellation is one customer');
});

test('a subscription event for an unknown customer invents nothing (W6)', async () => {
  await deliver(subscriptionEvent('customer.subscription.updated', 'cus_stranger')).expect(200);
  const { rows } = await pool.query('select count(*)::int as n from subscriptions');
  assert.equal(rows[0].n, 0, 'no user to key the row on — so no row');
});

test('an unknown event type is acknowledged and writes nothing (W3)', async () => {
  await deliver(checkoutEvent(ALICE)).expect(200);
  const before = await subscriptionOf(ALICE);
  await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.created', created: now(), data: { object: {} } }).expect(200);
  assert.deepEqual(await subscriptionOf(ALICE), before);
});

// --- forgery: the signature is the authentication ---------------------------

test('a signature computed with the WRONG SECRET is rejected and changes nothing', async () => {
  const raw = JSON.stringify(checkoutEvent(ALICE));
  await post(raw, sign(raw, { secret: 'whsec_attacker' })).expect(400);
  assert.equal(await subscriptionOf(ALICE), null);
  assert.equal(await billing.isEntitled(ALICE), false);
});

test('a signature over DIFFERENT BYTES is rejected — the body cannot be swapped', async () => {
  const signed = JSON.stringify(checkoutEvent(ALICE));
  const sent = JSON.stringify(checkoutEvent(BOB));
  await post(sent, sign(signed)).expect(400);
  assert.equal(await subscriptionOf(BOB), null);
});

test('no signature at all is rejected — there is no unauthenticated path in', async () => {
  const raw = JSON.stringify(checkoutEvent(ALICE));
  await request(app).post(HOOK).set('Content-Type', 'application/json').send(raw).expect(400);
  assert.equal(await subscriptionOf(ALICE), null);
});

test('the signature covers the EXACT bytes Stripe sent, not a re-serialization (W2)', async () => {
  // Odd spacing and key order: JSON.parse → JSON.stringify would produce
  // different bytes and a different MAC. Only express.raw survives this.
  const raw = `{ "type" : "checkout.session.completed",\n  "id": "evt_whitespace",\n"created": ${now()},\n "data" : { "object" : { "client_reference_id" : "${ALICE}", "customer": "cus_ws", "subscription": "sub_ws", "payment_status": "paid" } } }`;
  await post(raw, sign(raw)).expect(200);
  assert.equal(await billing.isEntitled(ALICE), true);
});

test('a body that is not JSON is refused, not crashed into', async () => {
  const raw = 'not json at all';
  const res = await post(raw, sign(raw));
  assert.equal(res.status, 400);
});

// --- replay and idempotency --------------------------------------------------

test('a timestamp outside the tolerance is rejected — a captured POST cannot be replayed (W1)', async () => {
  const raw = JSON.stringify(checkoutEvent(ALICE));
  await post(raw, sign(raw, { t: now() - 3600 })).expect(400);
  assert.equal(await subscriptionOf(ALICE), null);

  // A future-dated timestamp is equally outside the window (clock-skew attack).
  await post(raw, sign(raw, { t: now() + 3600 })).expect(400);
  assert.equal(await subscriptionOf(ALICE), null);

  // …and inside it, the same bytes are accepted.
  await post(raw, sign(raw, { t: now() - 60 })).expect(200);
  assert.ok(await subscriptionOf(ALICE));
});

// The APPLIED-ONCE half of replay defence lives in billing-webhook-postgres.js,
// not here, and that is not a convenience: pg-mem reports rowCount 1 (and
// `returning` yields a row) for an `on conflict do nothing` insert that
// conflicted, where Postgres reports 0. The ledger claim is precisely that
// distinction, so pg-mem cannot express it in either direction — it would pass
// an implementation with no idempotency at all. Same class as the scheduler
// claim (docs/testing.md).
test('the ledger records one row per event id, and a repeat delivery is acknowledged', async () => {
  await deliver(checkoutEvent(ALICE)).expect(200);
  const evt = subscriptionEvent('customer.subscription.updated', `cus_${ALICE.slice(0, 8)}`, {
    id: 'evt_replay_me',
    status: 'past_due',
    periodEnd: now() - 10,
    created: now() + 5,
  });
  await deliver(evt).expect(200);
  await deliver(evt).expect(200); // never a 5xx, and never a retry-inducing non-2xx

  const { rows } = await pool.query('select count(*)::int as n from stripe_events where id = $1', ['evt_replay_me']);
  assert.equal(rows[0].n, 1, 'one ledger row per event id — the primary key holds');
});

// --- ordering ----------------------------------------------------------------

test('an event OLDER than the one already applied cannot resurrect a cancelled sub (W4)', async () => {
  const customer = `cus_${ALICE.slice(0, 8)}`;
  const t0 = now();
  await deliver(checkoutEvent(ALICE, { created: t0 })).expect(200);
  await deliver(
    subscriptionEvent('customer.subscription.deleted', customer, { status: 'canceled', created: t0 + 100 })
  ).expect(200);
  assert.equal(await billing.isEntitled(ALICE), false);

  // Stripe delivers out of order: an 'updated' generated BEFORE the deletion
  // arrives after it. Applying it would hand a cancelled customer the product.
  await deliver(
    subscriptionEvent('customer.subscription.updated', customer, { status: 'active', created: t0 + 50 })
  ).expect(200);
  assert.equal(
    await billing.isEntitled(ALICE),
    false,
    'a stale update must not overwrite a newer state'
  );

  // Strictly-newer still applies, so a genuine resubscribe works.
  await deliver(
    subscriptionEvent('customer.subscription.updated', customer, { status: 'active', created: t0 + 200 })
  ).expect(200);
  assert.equal(await billing.isEntitled(ALICE), true);
});

test('two events sharing a second both apply — equal is not stale (W4)', async () => {
  const t0 = now();
  const customer = `cus_${ALICE.slice(0, 8)}`;
  await deliver(checkoutEvent(ALICE, { created: t0, payment_status: 'unpaid' })).expect(200);
  await deliver(
    subscriptionEvent('customer.subscription.created', customer, { status: 'active', created: t0 })
  ).expect(200);
  assert.equal(
    await billing.isEntitled(ALICE),
    true,
    'checkout.session.completed and customer.subscription.created routinely share a second'
  );
});

// --- malformed headers never throw (W7) -------------------------------------

for (const header of [
  '',
  't=',
  'v1=',
  't=,v1=',
  't=abc,v1=deadbeef',
  `t=${'9'.repeat(400)},v1=deadbeef`,
  'v1=deadbeef',
  't=1700000000',
  't=1700000000,v1=',
  't=1700000000,v1=nothexatall',
  't=1700000000,v1=aa', // valid hex, wrong length — the timingSafeEqual throw case
  't=1700000000,v1=' + 'a'.repeat(64),
  'garbage',
  't=1,v1=x,t=2,v1=y',
]) {
  test(`a malformed Stripe-Signature (${JSON.stringify(header).slice(0, 40)}) is rejected, never a 500 (W7)`, async () => {
    const raw = JSON.stringify(checkoutEvent(ALICE));
    const res = await post(raw, header);
    assert.equal(res.status, 400, 'refused as unverifiable, not crashed on');
    assert.equal(await subscriptionOf(ALICE), null);
  });
}

test('one correct v1 among several is accepted — secret rotation must not break (W1)', async () => {
  const raw = JSON.stringify(checkoutEvent(ALICE));
  const t = now();
  const good = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  await post(raw, `t=${t},v1=${'0'.repeat(64)},v1=${good}`).expect(200);
  assert.ok(await subscriptionOf(ALICE));
});

test('several wrong v1 entries are still rejected', async () => {
  const raw = JSON.stringify(checkoutEvent(ALICE));
  const t = now();
  await post(raw, `t=${t},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`).expect(400);
  assert.equal(await subscriptionOf(ALICE), null);
});

// --- the unit behind all of it ----------------------------------------------

test('verifyWebhookSignature is a pure, total function over (raw, header)', () => {
  const raw = '{"id":"evt_1"}';
  const t = now();
  assert.equal(billing.verifyWebhookSignature(raw, sign(raw, { t })), true);
  assert.equal(billing.verifyWebhookSignature(raw, sign(raw, { t, secret: 'other' })), false);
  assert.equal(billing.verifyWebhookSignature(raw, sign(raw, { t: t - 3600 })), false);
  // In-tolerance timestamps, so these reach the comparison itself: a short hex
  // digest is the length mismatch crypto.timingSafeEqual throws on, and non-hex
  // is what a naive Buffer.from(…, 'hex') silently truncates.
  assert.equal(billing.verifyWebhookSignature(raw, `t=${t},v1=aa`), false);
  assert.equal(billing.verifyWebhookSignature(raw, `t=${t},v1=nothexatall`), false);
  assert.equal(billing.verifyWebhookSignature(raw, `t=${t},v1=${'f'.repeat(128)}`), false);
  for (const bad of [undefined, null, '', 'x', 't=1,v1=zz']) {
    assert.equal(
      billing.verifyWebhookSignature(raw, /** @type {any} */ (bad)),
      false,
      `bad input must return false, never throw: ${bad}`
    );
  }
});
