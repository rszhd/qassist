// @ts-check
// US-035: pure-logic tests for variable declaration, reference validation and
// per-run resolution. No DB or spawn — the substitution boundary and the 400s
// it produces are decided here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGENT_PROVIDED_SECRETS,
  normalizeDeclarations,
  referencedNames,
  validateReferences,
  validateSecretTags,
  resolveForRun,
  secretWrites,
  unresolvableSecrets,
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

// --- BUG-004: the internal placeholder written by hand ---------------------
// `<secret>name</secret>` is resolveForRun's output. Written into a saved goal
// it declares nothing, routes nothing, and is typed into the page verbatim —
// a silent false-red no layer can raise at run time, so it is refused at save.
// The exception is the three the agent adds to `sensitive` itself mid-run.

test('validateSecretTags rejects a hand-written <secret> in a goal', () => {
  const err = validateSecretTags({ goal: 'log in with <secret>shop_pw</secret>' });
  assert.match(/** @type {string} */ (err), /shop_pw/);
  assert.match(/** @type {string} */ (err), /\{\{shop_pw\}\}/); // names the right spelling
});

test('validateSecretTags rejects malformed and unclosed secret tags', () => {
  for (const goal of [
    'enter <secret>a-b</secret>',
    'enter <secret>shop_pw',
    'enter shop_pw</secret>',
    'enter <secret></secret>',
    'enter <SECRET>shop_pw</SECRET>',
  ]) {
    assert.ok(validateSecretTags({ goal }), `should reject: ${goal}`);
  }
});

test('validateSecretTags accepts the secrets the agent provides at run time', () => {
  assert.equal(validateSecretTags({ goal: 'sign up with <secret>qa_password</secret>' }), null);
  assert.equal(
    validateSecretTags({
      goal: 'type <secret>email_code</secret>, or open <secret>email_link</secret>',
    }),
    null
  );
});

test('validateSecretTags refuses every <secret> in start_url, agent-provided included', () => {
  assert.ok(validateSecretTags({ start_url: 'https://x/<secret>email_link</secret>' }));
  assert.ok(validateSecretTags({ start_url: 'https://x?t=<secret>tok</secret>' }));
});

test('validateSecretTags accepts an ordinary goal and {{name}} references', () => {
  assert.equal(validateSecretTags({ goal: 'log in as {{user}}', start_url: 'https://{{env}}.x' }), null);
  assert.equal(validateSecretTags({}), null);
});

// The exemption list is only correct while it matches what the agent actually
// puts in `sensitive`. Adding a fourth there without adding it here would have
// the server reject a goal that works — so read the agent and compare.
test('AGENT_PROVIDED_SECRETS matches the secrets run_agent.py adds to `sensitive`', () => {
  const agent = readFileSync(
    new URL('../../agent/run_agent.py', import.meta.url),
    'utf8'
  );
  const found = [...agent.matchAll(/\bsensitive\[["'](\w+)["']\]\s*=/g)].map((m) => m[1]);
  assert.ok(found.length, 'found no `sensitive[...] =` assignments — has run_agent.py moved?');
  assert.deepEqual(new Set(found), new Set(AGENT_PROVIDED_SECRETS));
});

// --- US-064: a secret that survives to 02:00 --------------------------------
// The half of the story that is pure logic. Storage, masking and the schedule's
// save-time refusal are test-secrets.test.js; what is decided here is the rule
// every one of those then obeys.
//
// Decisions (raised before the implementation):
//   D1 A SECRET'S PLAINTEXT NEVER ENTERS `tests.variables`. It arrives on the
//      same array as the declaration — one editor, one PUT — so the split
//      happens here: `normalizeDeclarations` blanks it out of what is stored as
//      jsonb, and `secretWrites` is what carries it to the encrypted column.
//      A caller that only knows the old API therefore cannot write plaintext.
//   D2 THE WRITE IS THREE-STATE, because the field is never readable: blank
//      means keep, non-empty means replace, and `clear: true` means clear.
//      Without the third state a value could be set and never removed; without
//      the first, a masked GET plus a naive PUT wipes the stored secret while
//      the user was renaming the test.
//   D3 PRECEDENCE IS override > stored > declaration, and it lives in
//      `resolveForRun` — the one place the manual, CI and scheduled paths
//      already share. The declaration's own value stays last rather than being
//      deleted, so US-035's existing behaviour is unchanged for anyone who was
//      relying on it.
//   D4 AN EMPTY OVERRIDE NEVER BEATS A STORED SECRET. `RunVarsDialog` prefills
//      from `v.value`, which for a secret is now the masked empty string, and
//      PUTs every declared name — so `''` arrives as a *present* key on every
//      manual run. Read literally that override wins and every manual run of a
//      test with a stored secret breaks. `''` from a secret's box means "I did
//      not type one", and there is nothing it could usefully mean instead.
//   D5 AN OPTIONAL SECRET WITH NOTHING TO RESOLVE BEHAVES LIKE AN EMPTY
//      OPTIONAL PLAIN VARIABLE: the reference substitutes empty, nothing is
//      routed on the `secrets` channel, and the run row records `''` rather
//      than the `'<secret>'` presence marker. Today it emits
//      `<secret>name</secret>` and hands the agent `''`, so the browser types
//      nothing into the password field and the report blames the app.
//      Presence-marking a secret that was never supplied is the same lie one
//      layer up.
//   D6 "CAN THIS TEST RESOLVE?" IS ONE RULE, asked at save time by the
//      schedule route and at fire time by `resolveForRun`. They are separate
//      functions, so the pairing is asserted rather than assumed: whatever
//      `unresolvableSecrets` names is exactly what would have failed at 02:00.

test('normalizeDeclarations keeps a secret plaintext out of what is stored (D1)', () => {
  const r = /** @type {any} */ (normalizeDeclarations([
    { name: 'pw', value: 'hunter2', secret: true },
    { name: 'env', value: 'staging' },
  ]));
  assert.deepEqual(r.variables, [
    { name: 'pw', value: '', secret: true, optional: false },
    { name: 'env', value: 'staging', secret: false, optional: false },
  ]);
  assert.doesNotMatch(JSON.stringify(r.variables), /hunter2/);
});

test('secretWrites splits an incoming array into sets, clears and keeps (D2)', () => {
  const r = secretWrites([
    { name: 'pw', value: 'hunter2', secret: true },   // non-empty ⇒ replace
    { name: 'tok', value: '', secret: true },         // blank ⇒ keep
    { name: 'old', value: '', secret: true, clear: true }, // explicit ⇒ clear
    { name: 'env', value: 'staging' },                // not a secret ⇒ neither
  ]);
  assert.deepEqual(r, { set: { pw: 'hunter2' }, clear: ['old'] });
});

test('secretWrites treats an absent value as keep, and clear as final (D2)', () => {
  assert.deepEqual(secretWrites([{ name: 'pw', secret: true }]), { set: {}, clear: [] });
  // Both spellings at once is a client bug, and "clear" is the destructive
  // reading — obey it rather than storing a value the user asked to remove.
  assert.deepEqual(secretWrites([{ name: 'pw', value: 'x', secret: true, clear: true }]), {
    set: {},
    clear: ['pw'],
  });
  assert.deepEqual(secretWrites(undefined), { set: {}, clear: [] });
});

test('resolveForRun prefers an override, then a stored secret, then the declaration (D3)', () => {
  const variables = [{ name: 'pw', value: 'declared', secret: true, optional: false }];
  const goal = 'type {{pw}}';
  const start_url = 'https://x';
  const of = (input) => /** @type {any} */ (resolveForRun({ variables, goal, start_url, ...input }));

  assert.equal(of({ overrides: { pw: 'from-ci' }, stored: { pw: 'from-db' } }).secrets.pw, 'from-ci');
  assert.equal(of({ stored: { pw: 'from-db' } }).secrets.pw, 'from-db');
  assert.equal(of({}).secrets.pw, 'declared');
  // Whichever won, the run row and the goal carry the placeholder and nothing else.
  const r = of({ stored: { pw: 'from-db' } });
  assert.equal(r.goal, 'type <secret>pw</secret>');
  assert.deepEqual(r.variables, { pw: '<secret>' });
  assert.doesNotMatch(JSON.stringify(r.variables), /from-db/);
});

test('resolveForRun does not let a blank override defeat a stored secret (D4)', () => {
  const variables = [
    { name: 'pw', value: '', secret: true, optional: false },
    { name: 'env', value: 'staging', secret: false, optional: true },
  ];
  const r = /** @type {any} */ (resolveForRun({
    variables,
    // Exactly what the override dialog sends for a test it prefilled from a
    // masked declaration: every declared name, the secret's box empty.
    overrides: { pw: '', env: '' },
    stored: { pw: 'from-db' },
    goal: 'type {{pw}} on {{env}}',
    start_url: 'https://x',
  }));
  assert.equal(r.secrets.pw, 'from-db');
  // ...and the same blank on a NON-secret still means empty, as it always has:
  // "a blank field runs empty" is what that dialog promises for those.
  assert.equal(r.variables.env, '');
});

test('resolveForRun still requires a secret with neither stored value nor override', () => {
  const variables = [{ name: 'pw', value: '', secret: true, optional: false }];
  const r = resolveForRun({ variables, stored: {}, goal: 'type {{pw}}', start_url: 'https://x' });
  assert.match(/** @type {any} */ (r).error, /pw is required/);
});

test('an optional secret with nothing to resolve substitutes empty and routes nothing (D5)', () => {
  const variables = [{ name: 'pw', value: '', secret: true, optional: true }];
  const r = /** @type {any} */ (resolveForRun({
    variables,
    goal: 'type {{pw}} into the box',
    start_url: 'https://x',
  }));
  // No placeholder, so the agent is never told a secret is coming that isn't.
  assert.equal(r.goal, 'type  into the box');
  assert.deepEqual(r.secrets, {});
  // Not '<secret>': marking presence for a value nobody supplied is the same
  // lie, one layer up, and history is where it would be believed longest.
  assert.deepEqual(r.variables, { pw: '' });
});

test('unresolvableSecrets names what a schedule would fire into (D6)', () => {
  const goal = 'log in as {{user}} with {{pw}}, coupon {{coupon}}';
  const start_url = 'https://x';
  const variables = [
    { name: 'user', value: 'alice', secret: false, optional: false },
    { name: 'pw', value: '', secret: true, optional: false },
    { name: 'coupon', value: '', secret: true, optional: true },
  ];
  assert.deepEqual(unresolvableSecrets({ variables, storedNames: [], goal, start_url }), ['pw']);
  // Stored ⇒ resolvable, with no decryption anywhere in the question.
  assert.deepEqual(unresolvableSecrets({ variables, storedNames: ['pw'], goal, start_url }), []);
  // A secret nothing references is not a reason to refuse a schedule.
  assert.deepEqual(
    unresolvableSecrets({ variables, storedNames: [], goal: 'just look', start_url }),
    []
  );
});

test('unresolvableSecrets and resolveForRun agree about the same test (D6)', () => {
  const goal = 'type {{pw}}';
  const start_url = 'https://x';
  const variables = [{ name: 'pw', value: '', secret: true, optional: false }];
  const refused = unresolvableSecrets({ variables, storedNames: [], goal, start_url });
  const fired = /** @type {any} */ (resolveForRun({ variables, stored: {}, goal, start_url }));
  assert.deepEqual(refused, ['pw']);
  assert.match(fired.error, /pw is required/);
  // And the inverse, which is the half that drifts: a save the route ALLOWS
  // must be one the tick can actually run.
  const allowed = unresolvableSecrets({ variables, storedNames: ['pw'], goal, start_url });
  const ran = /** @type {any} */ (resolveForRun({ variables, stored: { pw: 'x' }, goal, start_url }));
  assert.deepEqual(allowed, []);
  assert.equal(ran.error, undefined);
});
