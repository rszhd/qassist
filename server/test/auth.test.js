// @ts-check
// US-021 — assertion-first spec for the two crypto surfaces of magic-link auth
// (correctness-critical: a break here is silent account takeover). No DB, no
// network: these pin the pure logic in src/auth.js. The DB-backed single-use /
// expiry consume and cross-tenant isolation live in auth-isolation.test.js.
//
// Reviewer's job (per CLAUDE.md assertion-first rule): tighten these BEFORE the
// implementation exists. The two properties they exist to defend:
//
//   S — a session cookie is unforgeable and non-malleable: only signSession can
//       produce a value verifySession accepts, tampering with any byte voids it,
//       and it stops being accepted after SESSION_TTL_MS.
//   M — a login link's secret is never stored (only its hash is), and its TTL is
//       short (≤ 15 min per the acceptance criterion).
//
// Config is read at import time, so the secret must be set before importing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/** @type {typeof import('../src/auth.js')} */
let auth;
const SECRET = 'test-session-secret-0123456789';

before(async () => {
  process.env.SESSION_SECRET = SECRET;
  auth = await import('../src/auth.js');
});

// --- S: session cookie ---

test('a signed session round-trips to the same userId', () => {
  const uid = '11111111-1111-1111-1111-111111111111';
  const cookie = auth.signSession(uid);
  assert.equal(auth.verifySession(cookie), uid);
});

test('a tampered session is rejected, not silently accepted', () => {
  const uid = '11111111-1111-1111-1111-111111111111';
  const cookie = auth.signSession(uid);
  // Flip a character in every position class the value has; each must void it.
  for (const mutate of [
    (/** @type {string} */ c) => c.slice(0, -1) + (c.at(-1) === 'a' ? 'b' : 'a'), // signature
    (/** @type {string} */ c) => 'x' + c.slice(1), // leading byte
    (/** @type {string} */ c) => c.replace(uid, '22222222-2222-2222-2222-222222222222'), // swap the subject
  ]) {
    assert.equal(auth.verifySession(mutate(cookie)), null);
  }
});

test('a session forged without the secret is rejected', () => {
  // The attacker knows the format and the userId but not SESSION_SECRET.
  const forged = '11111111-1111-1111-1111-111111111111.99999999999999.deadbeef';
  assert.equal(auth.verifySession(forged), null);
});

test('an expired session is rejected', () => {
  const uid = '11111111-1111-1111-1111-111111111111';
  const issued = auth.signSession(uid, { now: 0 });
  assert.equal(auth.verifySession(issued, { now: auth.SESSION_TTL_MS - 1 }), uid);
  assert.equal(auth.verifySession(issued, { now: auth.SESSION_TTL_MS + 1 }), null);
});

test('garbage and empty inputs verify to null rather than throwing', () => {
  for (const bad of ['', 'not-a-cookie', '...', 'a.b', undefined, null]) {
    assert.equal(auth.verifySession(/** @type {any} */ (bad)), null);
  }
});

// --- M: login-link secret ---

test('a login link stores only the hash of its secret, and the two match', () => {
  const { token, hash } = auth.mintLoginToken();
  assert.equal(hash, auth.hashLoginToken(token));
  // The stored hash must not be the secret itself.
  assert.notEqual(hash, token);
  // The emailed secret must be high-entropy, not guessable.
  assert.ok(token.length >= 32, `login secret too short: ${token.length}`);
});

test('two minted links never collide', () => {
  const a = auth.mintLoginToken();
  const b = auth.mintLoginToken();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.hash, b.hash);
});

test('login-link TTL satisfies the ≤15-minute acceptance criterion', () => {
  assert.ok(
    auth.LOGIN_TOKEN_TTL_MS <= 15 * 60 * 1000,
    `LOGIN_TOKEN_TTL_MS=${auth.LOGIN_TOKEN_TTL_MS} exceeds 15 min`
  );
  const { expiresAt } = auth.mintLoginToken({ now: 1000 });
  assert.equal(expiresAt.getTime(), 1000 + auth.LOGIN_TOKEN_TTL_MS);
});
