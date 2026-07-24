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

test('resolveForRun rejects a run that references a secret (gated until redaction assertion)', () => {
  const variables = [{ name: 'pw', value: 's3cret', secret: true, optional: false }];
  const r = resolveForRun({ variables, goal: 'type {{pw}}', start_url: 'https://x' });
  assert.match(/** @type {any} */ (r).error, /secret variable pw is not yet supported/);
});
