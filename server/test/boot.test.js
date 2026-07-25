// @ts-check
// US-039 — assertion-first spec for the BOOT PRECONDITIONS. The story's two
// accepted consequences are that DATABASE_URL and KEY_ENCRYPTION_SECRET stop
// being optional: without the control plane there is no `users` row for a key
// to live on, and without the encryption secret the only remaining way to
// supply one is hand-crafted POST bodies. Both must refuse to serve rather than
// degrade — the same choice SESSION_SECRET and AUTH_ENABLED already made.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — decisions here, beyond the D-list in byok-only.test.js:
//
//   D12 The check is a PURE predicate in a new `src/boot.js`:
//         missingBootRequirements({ hasDb, hasKeyEncryption, authRequested,
//                                   mailReady, hasSessionSecret,
//                                   demoRequested }) => string[]
//       server.js's `isMain` block calls it, prints the names and exits 1.
//       Why a seam at all: config.js is read at import time, so a matrix of
//       missing-var cases cannot be exercised in one process — the same reason
//       billingReady() was split out of billingEnabled() in US-022. An empty
//       array means "serve".
//       [REVIEW: the new module, the parameter names, and whether folding the
//       EXISTING AUTH_ENABLED / AUTH_MODE=demo half-enable checks into it is in
//       scope. They are the same "refuse rather than half-enable" shape and it
//       is ~25 lines replacing ~18 inline, but it is a refactor the story did
//       not ask for. I default to folding them in; say the word and I'll leave
//       them where they are and have boot.js cover only the two new ones.]
//
//   D13 The names reported are the ENV VAR names, verbatim, so the operator can
//       grep their .env for the string we printed. Auth's mail requirement is
//       the one exception and keeps its existing prose form, because it is a
//       pair of vars satisfying one need.
//       [REVIEW: confirm — the alternative is prose for all of them.]
//
//   D14 Order is fixed and deterministic: DATABASE_URL, KEY_ENCRYPTION_SECRET,
//       then auth's, then demo's. A stable order means the message is stable,
//       which means it can be asserted at all.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { missingBootRequirements } = await import('../src/boot.js');

/** A fully configured single-token self-host: the control plane and the key secret. */
const SELF_HOST = {
  hasDb: true,
  hasKeyEncryption: true,
  authRequested: false,
  mailReady: false,
  hasSessionSecret: false,
  demoRequested: false,
};

test('a configured self-host has nothing missing and serves', () => {
  assert.deepEqual(missingBootRequirements(SELF_HOST), []);
});

test('DATABASE_URL is required — the in-memory mode is gone (story consequence 1)', () => {
  assert.deepEqual(missingBootRequirements({ ...SELF_HOST, hasDb: false }), ['DATABASE_URL']);
});

test('KEY_ENCRYPTION_SECRET is required — there is nowhere else to put a key (consequence 2)', () => {
  assert.deepEqual(missingBootRequirements({ ...SELF_HOST, hasKeyEncryption: false }), [
    'KEY_ENCRYPTION_SECRET',
  ]);
});

test('both missing are both named — a fresh clone fixes its .env once, not twice', () => {
  assert.deepEqual(missingBootRequirements({ ...SELF_HOST, hasDb: false, hasKeyEncryption: false }), [
    'DATABASE_URL',
    'KEY_ENCRYPTION_SECRET',
  ]);
});

test('a half-enabled AUTH_ENABLED still refuses, and names only what it lacks', () => {
  assert.deepEqual(
    missingBootRequirements({
      ...SELF_HOST,
      authRequested: true,
      mailReady: false,
      hasSessionSecret: false,
    }),
    ['a mail sender (RESEND_API_KEY + MAIL_FROM)', 'SESSION_SECRET']
  );
  assert.deepEqual(
    missingBootRequirements({
      ...SELF_HOST,
      authRequested: true,
      mailReady: true,
      hasSessionSecret: true,
    }),
    [],
    'fully configured multi-user serves'
  );
});

test('a half-enabled demo sandbox refuses rather than serving an open, unseeded app', () => {
  assert.deepEqual(
    missingBootRequirements({ ...SELF_HOST, demoRequested: true, hasSessionSecret: false }),
    ['SESSION_SECRET']
  );
});

test('a requirement is never reported twice when two features need it', () => {
  // Auth and the demo sandbox both need SESSION_SECRET; DATABASE_URL is now
  // needed unconditionally as well as by both. The operator should see one line
  // per thing to fix.
  const missing = missingBootRequirements({
    hasDb: false,
    hasKeyEncryption: true,
    authRequested: true,
    mailReady: true,
    hasSessionSecret: false,
    demoRequested: true,
  });
  assert.deepEqual(new Set(missing).size, missing.length, 'no duplicates');
  assert.deepEqual(missing, ['DATABASE_URL', 'SESSION_SECRET'], 'and in the fixed order (D14)');
});
