// @ts-check
// US-053 — assertion-first spec for the CHECKOUT PRECONDITION: an account with
// no stored OpenAI key cannot start a Stripe Checkout session.
//
// This is a billing gate, so it belongs to the correctness-critical class
// (backlog/correctness-critical.md) alongside billing-gate.test.js: it decides
// whether money changes hands. The failure it exists to stop is quiet and
// expensive in both directions — a customer who pays for a product that cannot
// run a single test (US-039: runs are funded by the caller's key and by nothing
// else), or a gate that grows one notch too wide and locks a paying customer
// out of the Portal they need to fix their card.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these assertions encode that I could NOT derive from
// the story, and that you're signing off before I implement. Edit the
// assertions directly; they are the spec, and the implementation is written
// against whatever this file says after you have been through it.
//
//   D1  The precondition sits on POST /api/billing/checkout ONLY. Not on
//       /status (the wall reads it to decide what to render, so gating it would
//       gate the screen that tells you what to do), and emphatically not on
//       /portal: the Portal is where a customer updates a dead card or cancels,
//       and someone who removed their key must still reach it. A forced
//       onboarding flow that also blocks the exit is a trap, not a flow.
//       [REVIEW: confirm /portal stays ungated.]
//
//   D2  The refusal is 409 + { error, openai_key_required: true }.
//       409 because the other "your account isn't in a state for this" answer
//       on this router is already 409 (/portal with no customer yet); 402 is
//       the run gate's ("pay"), 503 is requireAgentKey's ("no key") and reusing
//       either would make one code mean two different fixes. The boolean is
//       the UI contract, mirroring US-022's `billing_required`.
//       [REVIEW: the code, the field name, and the `error` wording — give me
//       the string you want and I'll pin it here like respondOverCap's.]
//
//   D3  Refused means NOTHING was sent to Stripe. Asserted against a stub
//       Stripe that records every request it receives: the check must precede
//       the network call, not clean up after it. Otherwise an unfunded account
//       can hammer a button and mint abandoned Checkout sessions (and, with
//       `customer_email` on them, the customer records Stripe attaches on
//       completion) that no webhook will ever resolve.
//
//   D4  A per-request key does NOT satisfy the precondition. `POST /checkout`
//       with an `openai_api_key` in the body still 409s: that key funds one run
//       and is never stored (US-039 precedence), so treating it as readiness
//       would sell a subscription to an account that still has nothing on file.
//       The check reads the STORED key for currentUserId(), the same state the
//       run gate reads. [REVIEW: confirm — the alternative is to accept it and
//       store it, which I think is a worse surprise.]
//
//   D5  An EXEMPT account is refused too. Exemption says "never charged", not
//       "different rules for Checkout"; the wall never offers the button to an
//       exempt user, so the only way to reach this path is deliberately, and a
//       carve-out here would be an untested branch in a money path.
//       [REVIEW: confirm — the opposite reading is defensible.]
//
//   D6  The precondition is a PRECONDITION, not an invariant. Removing the key
//       after subscribing changes nothing about billing: entitlement stands,
//       the Portal still opens, and runs refuse with the existing 503 until a
//       key comes back. We do not cancel anyone's subscription because they
//       rotated a key. Asserted below, because "obviously we wouldn't" is how
//       a coupling gets added later by someone tidying.
//
//   D7  The self-host free path is untouched, and is asserted where it already
//       lives: billing-off.test.js pins that with STRIPE_* unset the whole
//       router is empty, so /api/billing/checkout 404s and this precondition
//       cannot exist to be tripped over. No assertion here — config is read at
//       import time and "off" needs its own process.
//
// pg-mem cannot round-trip a bytea parameter (helpers/stored-key.js), so the
// stored key is seeded through the registered-decode path and the product's own
// PUT is not exercised here — openai-key-postgres.test.js owns that.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-session-secret-0123456789';
const OPERATOR = 'operator@qassist.test';
const CHECKOUT_URL = 'https://checkout.stripe.test/c/pay_123';
const PORTAL_URL = 'https://billing.stripe.test/p/session_123';
const REQUEST_KEY = 'sk-proj-' + 'Request0000request0000request0000request0';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
/** @type {http.Server} */
let stripe;
/** Every request the stub Stripe received: the "nothing was sent" proof (D3). */
let stripeCalls = /** @type {{ path: string, form: URLSearchParams }[]} */ ([]);

let FUNDED = '';
let UNFUNDED = '';
let LAPSED = '';
let EXEMPT = '';

before(async () => {
  // A stub Stripe that answers the two POSTs billing.js makes, and remembers
  // being asked. Started before config is imported so STRIPE_API_URL can point
  // at it — config.js reads the environment once, at import time.
  stripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      stripeCalls.push({ path: String(req.url), form: new URLSearchParams(body) });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'cs_test_1',
          url: String(req.url).includes('portal') ? PORTAL_URL : CHECKOUT_URL,
        })
      );
    });
  });
  await new Promise((resolve) => stripe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (stripe.address());

  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.MAIL_DEV_CONSOLE = '1';
  process.env.OPERATOR_EMAIL = OPERATOR;
  process.env.STRIPE_SECRET_KEY = 'sk_test_checkout';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_checkout';
  process.env.STRIPE_PRICE_ID = 'price_test_123';
  process.env.STRIPE_API_URL = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_BASE_URL = 'https://qassist.test';
  process.env.BILLING_EXEMPT_EMAILS = 'exempt@example.test';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  delete process.env.AUTH_MODE;

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  auth = await import('../src/auth.js');
  ({ app } = await import('../src/server.js'));

  FUNDED = await makeUser('funded@example.test', { key: true });
  UNFUNDED = await makeUser('unfunded@example.test', { key: false });
  // A customer whose subscription lapsed AND whose key is gone: the account
  // that must still be able to reach the Portal (D1) and must not be told its
  // subscription is affected by the missing key (D6).
  LAPSED = await makeUser('lapsed@example.test', { key: false });
  await pool.query(
    `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
     values ($1, 'cus_lapsed', 'sub_lapsed', 'canceled', null)`,
    [LAPSED]
  );
  EXEMPT = await makeUser('exempt@example.test', { key: false });
});

after(() => {
  stripe?.close();
});

beforeEach(() => {
  stripeCalls = [];
});

/** @param {string} email @param {{ key: boolean }} opts */
async function makeUser(email, { key }) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  if (key) await seedStoredKey(pool, rows[0].id);
  return rows[0].id;
}

const asUser = (uid) => ({ Cookie: `${auth.SESSION_COOKIE}=${auth.signSession(uid)}` });

// --- the precondition --------------------------------------------------------

test('no stored key: checkout is refused, and Stripe is never called', async () => {
  const res = await request(app).post('/api/billing/checkout').set(asUser(UNFUNDED)).send({});

  assert.equal(res.status, 409, 'an account with no key on file may not subscribe');
  assert.equal(res.body.openai_key_required, true, 'the UI contract: which step is outstanding');
  assert.match(res.body.error, /key/i);
  assert.equal(res.body.url, undefined, 'no Checkout URL leaks out of a refusal');
  assert.deepEqual(stripeCalls, [], 'the check runs BEFORE the network call (D3)');
});

test('a per-request key does not buy a subscription', async () => {
  const res = await request(app)
    .post('/api/billing/checkout')
    .set(asUser(UNFUNDED))
    .send({ openai_api_key: REQUEST_KEY });

  assert.equal(res.status, 409, 'readiness is the STORED key, not one passed in passing (D4)');
  assert.deepEqual(stripeCalls, []);

  const { rows } = await pool.query('select openai_key_ciphertext from users where id = $1', [UNFUNDED]);
  assert.equal(rows[0].openai_key_ciphertext, null, 'and the request key is not quietly stored');
});

test('an exempt account is refused the same way', async () => {
  const res = await request(app).post('/api/billing/checkout').set(asUser(EXEMPT)).send({});

  assert.equal(res.status, 409, 'exemption means "never charged", not "different rules" (D5)');
  assert.deepEqual(stripeCalls, []);
});

test('stored key: checkout proceeds exactly as before', async () => {
  const res = await request(app).post('/api/billing/checkout').set(asUser(FUNDED)).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.url, CHECKOUT_URL);
  assert.equal(stripeCalls.length, 1, 'one session, created once');
  assert.equal(stripeCalls[0].path, '/checkout/sessions');
  assert.equal(
    stripeCalls[0].form.get('client_reference_id'),
    FUNDED,
    'the thread the completed-session webhook follows back to the user is intact'
  );
});

// --- what the precondition must NOT reach ------------------------------------

test('the Portal is not gated: a keyless customer can still fix their card', async () => {
  const res = await request(app).post('/api/billing/portal').set(asUser(LAPSED)).send({});

  assert.equal(res.status, 200, 'the way out of a lapsed subscription stays open (D1)');
  assert.equal(res.body.url, PORTAL_URL);
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].path, '/billing_portal/sessions');
});

test('billing status is readable without a key — it is what tells you to add one', async () => {
  const res = await request(app).get('/api/billing/status').set(asUser(UNFUNDED));

  assert.equal(res.status, 200);
  assert.equal(res.body.entitled, false);
  assert.equal(res.body.status, null);
  assert.deepEqual(stripeCalls, [], 'status is read from our own tables');
});

test('removing the key does not touch an existing subscription', async () => {
  // Entitled and funded, then the key goes away: billing is unmoved.
  await pool.query(
    `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
     values ($1, 'cus_funded', 'sub_funded', 'active', null)`,
    [FUNDED]
  );
  await pool.query('update users set openai_key_ciphertext = null where id = $1', [FUNDED]);

  const status = await request(app).get('/api/billing/status').set(asUser(FUNDED));
  assert.equal(status.body.entitled, true, 'a rotated key never cancels anything (D6)');
  assert.equal(status.body.manageable, true);

  const portal = await request(app).post('/api/billing/portal').set(asUser(FUNDED)).send({});
  assert.equal(portal.status, 200, 'and the Portal stays reachable');

  // Restore, so ordering between tests carries no meaning.
  await seedStoredKey(pool, FUNDED);
  await pool.query('delete from subscriptions where user_id = $1', [FUNDED]);
});
