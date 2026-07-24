// @ts-check
// US-035: pure-logic tests for variable declaration, reference validation and
// per-run resolution. No DB or spawn — the substitution boundary and the 400s
// it produces are decided here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeclarations,
  referencedNames,
  validateReferences,
  resolveForRun,
} from '../src/variables.js';

test('normalizeDeclarations fills defaults and preserves flags', () => {
  const r = normalizeDeclarations([
    { name: 'env', value: 'staging' },
    { name: 'pw', secret: true, optional: true },
  ]);
  assert.deepEqual(r, {
    variables: [
      { name: 'env', value: 'staging', secret: false, optional: false },
      { name: 'pw', value: '', secret: true, optional: true },
    ],
  });
});

test('normalizeDeclarations accepts empty / missing input', () => {
  assert.deepEqual(normalizeDeclarations(undefined), { variables: [] });
  assert.deepEqual(normalizeDeclarations([]), { variables: [] });
});

test('normalizeDeclarations rejects bad shapes', () => {
  assert.match(/** @type {any} */ (normalizeDeclarations('nope')).error, /array/);
  assert.match(/** @type {any} */ (normalizeDeclarations([{ name: '1bad' }])).error, /invalid/);
  assert.match(/** @type {any} */ (normalizeDeclarations([{ name: 'a has space' }])).error, /invalid/);
  assert.match(
    /** @type {any} */ (normalizeDeclarations([{ name: 'x' }, { name: 'x' }])).error,
    /duplicate/
  );
  assert.match(
    /** @type {any} */ (normalizeDeclarations([{ name: 'x', value: 5 }])).error,
    /value/
  );
});

test('referencedNames extracts {{name}} across texts, tolerating whitespace', () => {
  assert.deepEqual([...referencedNames('go to {{ url }}', 'as {{user}}')], ['url', 'user']);
  assert.deepEqual([...referencedNames('nothing here')], []);
});

test('validateReferences rejects an undeclared reference', () => {
  const vars = [{ name: 'env' }];
  assert.equal(validateReferences(vars, 'use {{env}}', 'https://x'), null);
  assert.match(validateReferences(vars, 'use {{coupon}}'), /undefined variable \{\{coupon\}\}/);
});

test('resolveForRun substitutes defaults and overrides into goal and start_url', () => {
  const variables = [
    { name: 'env', value: 'staging', secret: false, optional: false },
    { name: 'user', value: 'alice', secret: false, optional: false },
  ];
  const r = resolveForRun({
    variables,
    overrides: { env: 'prod' },
    goal: 'log in as {{user}} on {{env}}',
    start_url: 'https://{{env}}.example.com',
  });
  assert.deepEqual(r, {
    goal: 'log in as alice on prod',
    start_url: 'https://prod.example.com',
    variables: { env: 'prod', user: 'alice' },
    secrets: {},
  });
});

test('resolveForRun requires a referenced non-optional variable to resolve', () => {
  const variables = [{ name: 'coupon', value: '', secret: false, optional: false }];
  const r = resolveForRun({ variables, goal: 'apply {{coupon}}', start_url: 'https://x' });
  assert.match(/** @type {any} */ (r).error, /coupon is required/);
});

test('resolveForRun lets an optional variable resolve empty', () => {
  const variables = [{ name: 'coupon', value: '', secret: false, optional: true }];
  const r = resolveForRun({ variables, goal: 'apply {{coupon}}', start_url: 'https://x' });
  assert.deepEqual(r, {
    goal: 'apply ',
    start_url: 'https://x',
    variables: { coupon: '' },
    secrets: {},
  });
});

test('resolveForRun ignores overrides for names this test does not declare', () => {
  const variables = [{ name: 'env', value: 'staging', secret: false, optional: false }];
  const r = resolveForRun({
    variables,
    overrides: { env: 'prod', unknown: 'x' },
    goal: 'on {{env}}',
    start_url: 'https://x',
  });
  assert.deepEqual(/** @type {any} */ (r).variables, { env: 'prod' });
});

// --- secret path (US-035, correctness-critical) ---
// These pin the redaction boundary: a secret's real value leaves resolveForRun
// only on the `secrets` channel (→ QA_VARS → the agent's browser-use
// sensitive_data), and never enters the substituted goal/start_url or the
// `variables` map that is denormalized onto the persisted run. The goal keeps a
// `<secret>name</secret>` placeholder — the same one US-034 already teaches the
// agent — so browser-use substitutes the value at type-time, not the server.
//
// Three decisions these encode (raise/tighten before the implementation):
//   D1 resolveForRun gains a `secrets: {name: value}` return channel.
//   D2 the persisted `variables` map carries a secret as presence-only
//      (`'<secret>'`), so history shows which environment ran without the value.
//   D3 a secret referenced in start_url is rejected — a secret in a URL is the
//      exact leak US-034's scrub exists to patch.

test('resolveForRun routes a secret as a placeholder, never inline', () => {
  const variables = [
    { name: 'env', value: 'prod', secret: false, optional: false },
    { name: 'pw', value: 's3cret', secret: true, optional: false },
  ];
  const r = /** @type {any} */ (resolveForRun({
    variables,
    goal: 'log in on {{env}} with {{pw}}',
    start_url: 'https://x',
  }));
  // D1: the value never appears in the text the prompt/report is built from.
  assert.equal(r.goal, 'log in on prod with <secret>pw</secret>');
  assert.doesNotMatch(r.goal, /s3cret/);
  // D1: the real value leaves only on the secrets channel (→ QA_VARS).
  assert.deepEqual(r.secrets, { pw: 's3cret' });
  // D2: the persisted map carries presence, not value.
  assert.deepEqual(r.variables, { env: 'prod', pw: '<secret>' });
});

test('resolveForRun never persists a secret value even under override', () => {
  const variables = [{ name: 'pw', value: 'default-pw', secret: true, optional: false }];
  const r = /** @type {any} */ (resolveForRun({
    variables,
    overrides: { pw: 'ci-injected' }, // CI trigger body supplies the real one
    goal: 'type {{pw}}',
    start_url: 'https://x',
  }));
  assert.equal(r.secrets.pw, 'ci-injected');
  assert.doesNotMatch(JSON.stringify(r.variables), /ci-injected|default-pw/);
  assert.doesNotMatch(r.goal, /ci-injected|default-pw/);
});

test('resolveForRun requires a referenced non-optional secret to resolve', () => {
  const variables = [{ name: 'pw', value: '', secret: true, optional: false }];
  const r = resolveForRun({ variables, goal: 'type {{pw}}', start_url: 'https://x' });
  assert.match(/** @type {any} */ (r).error, /pw is required/);
});

test('resolveForRun lets an unreferenced secret sit unused without leaking', () => {
  const variables = [{ name: 'pw', value: 's3cret', secret: true, optional: false }];
  const r = /** @type {any} */ (resolveForRun({
    variables,
    goal: 'no secret here',
    start_url: 'https://x',
  }));
  assert.deepEqual(r.secrets, {}); // not referenced ⇒ not routed
  assert.doesNotMatch(JSON.stringify(r), /s3cret/);
});

test('resolveForRun rejects a secret referenced in start_url', () => {
  const variables = [{ name: 'tok', value: 't', secret: true, optional: false }];
  const r = resolveForRun({ variables, goal: 'go', start_url: 'https://x?t={{tok}}' });
  assert.match(/** @type {any} */ (r).error, /secret .*tok.* cannot appear in start_url/i);
});
