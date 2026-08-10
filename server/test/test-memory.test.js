// @ts-check
// US-081 — written before `server/src/testMemory.js` existed, and the
// implementation written against it (`CLAUDE.md` → Workflow rules).
//
// What this file guards is invisible on the page. Memory changes the prompt, so
// every wrong answer here arrives as a *plausible verdict* — a run that passed
// or failed for reasons nobody disputes, because nothing downstream contradicts
// the advice it was given. There is no red build, no stack trace and no bar to
// notice; the only symptom is that the fleet slowly gets worse at flows it used
// to handle. That is why the fingerprint is asserted per input rather than as
// "some edit invalidates", and why the write is asserted against a fingerprint
// the run carries rather than the one the row happens to hold now.
//
// The fingerprint is **two inputs**: the resolved instructions and the start URL
// (revised 2026-08-10). It was eleven, and that asked the wrong question — "did
// anything about this run change?" rather than "is this still the same flow
// through the same app?". A model swapped on the box, a session re-captured
// overnight, a fixture added to the project: every one wiped a notebook for a
// reason that had nothing to do with where Billing sits. So the assertions below
// pin the two that count AND the nine that must not, because an input added back
// by a well-meaning future reader costs notebooks silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_FORMAT_VERSION, fingerprint, mayStore, memoryFor } from '../src/testMemory.js';

/**
 * The resolved inputs of one run, in the shape `fingerprint` takes.
 * @returns {import('../src/testMemory.js').MemoryInputs}
 */
const base = () => ({
  goal: 'Confirm the March invoice reads as paid',
  start_url: 'https://app.example.com/billing',
  max_steps: 60,
  model: 'gpt-4.1',
  variables: { env: 'staging' },
  secretNames: ['account_password'],
  fixtures: ['receipt.pdf'],
  session: null,
  preamble: [],
  policy: { blockPrivate: true, deniedHosts: [], allowedDomains: ['example.com'] },
  format: MEMORY_FORMAT_VERSION,
});

/** @param {Partial<import('../src/testMemory.js').MemoryInputs>} patch */
const withInput = (patch) => fingerprint({ ...base(), ...patch });

// --- the fingerprint, one input at a time -----------------------------------

test('the same resolved inputs fingerprint the same', () => {
  assert.equal(fingerprint(base()), fingerprint(base()));
  // Whitespace is not a flow. Trailing space in the instructions is the edit
  // somebody makes without meaning to, and it must not cost the notebook.
  assert.equal(withInput({ goal: `  ${base().goal}  ` }), fingerprint(base()));
});

test('the two inputs that move the fingerprint, asserted one at a time', () => {
  const it = fingerprint(base());
  assert.notEqual(withInput({ goal: 'Confirm the April invoice reads as paid' }), it);
  assert.notEqual(withInput({ start_url: 'https://app.example.com/invoices' }), it);
});

test('nothing else moves it, asserted one at a time', () => {
  // The other half of the rule, and the half that rots. Each of these was in the
  // hash and each cost a notebook for a change that left the app exactly where
  // it was. Asserted individually rather than as "the rest is ignored", so
  // putting one back is a red test rather than a quiet regression to a fleet
  // that keeps forgetting things.
  const it = fingerprint(base());
  const unmoved = {
    max_steps: withInput({ max_steps: 40 }),
    model: withInput({ model: 'gpt-4.1-mini' }),
    defaultModel: withInput({ model: null, defaultModel: 'gpt-5' }),
    variables: withInput({ variables: { env: 'production' } }),
    secretNames: withInput({ secretNames: ['account_password', 'otp_seed'] }),
    fixtures: withInput({ fixtures: ['receipt.pdf', 'statement.csv'] }),
    session: withInput({ session: ['5f2c…', '2026-08-08T00:00:00.000Z'] }),
    preamble: withInput({ preamble: [{ go_to_url: { url: 'https://app.example.com' } }] }),
    policy: withInput({ policy: { blockPrivate: false, deniedHosts: [], allowedDomains: [] } }),
    format: withInput({ format: MEMORY_FORMAT_VERSION + 1 }),
  };
  for (const [input, hash] of Object.entries(unmoved)) {
    assert.equal(hash, it, `${input} must not cost a test its notebook`);
  }
});

test('a variable that reaches the instructions still moves it', () => {
  // Which is why dropping `variables` as an input costs almost nothing: the goal
  // is hashed POST-substitution, so `log in as {{role}}` resolving to admin and
  // to viewer are two different flows and hash differently. What is no longer
  // caught is a variable that appears nowhere a person can see, and a variable
  // like that does not change where Billing sits either.
  assert.notEqual(
    withInput({ goal: 'log in as admin and open Billing' }),
    withInput({ goal: 'log in as viewer and open Billing' })
  );
});

test('a secret never reaches the fingerprint', () => {
  // Hashing is one-way and that is not the point: a password drawn from a small
  // space is recoverable from a digest, and this hash is a column a read
  // endpoint may serve. Rotating a password also does not change which menu
  // Billing is under. `resolveForRun` substitutes a secret into the goal as the
  // literal '<secret>' marker (variables.js), so the resolved goal carries the
  // name and never the value — but it must be so by rule, not by luck.
  const spec = { ...base(), goal: 'sign in with <secret>account_password</secret>' };
  const hash = fingerprint({ ...spec, secrets: { account_password: 'hunter2' } });
  assert.equal(hash, fingerprint({ ...spec, secrets: { account_password: 'correct-horse' } }));
  assert.equal(hash, fingerprint(spec), 'a value passed alongside must be ignored entirely');
});

test('the start URL is normalized before it is hashed', () => {
  const canonical = withInput({ start_url: 'https://app.example.com/billing' });
  assert.equal(withInput({ start_url: 'HTTPS://App.Example.COM/billing' }), canonical);
  assert.equal(withInput({ start_url: 'https://app.example.com:443/billing' }), canonical);
  // Query and fragment are dropped by default — they carry tokens and unstable
  // ids, and a campaign parameter must not read as a different test.
  assert.equal(withInput({ start_url: 'https://app.example.com/billing?utm_source=x' }), canonical);
  assert.equal(withInput({ start_url: 'https://app.example.com/billing#top' }), canonical);
  // The path still counts.
  assert.notEqual(withInput({ start_url: 'https://app.example.com/billing/2026' }), canonical);
});

// --- what one run is given --------------------------------------------------

const NOTEBOOK = {
  successful_approach: [
    { id: 'a1', text: 'Open Billing from the account menu', steps: [4], run_id: 'run-1' },
  ],
  avoid_next_time: [],
  orientation: [],
};

const storedRow = () => ({
  fingerprint: fingerprint(base()),
  learned: NOTEBOOK,
  learned_at: Date.parse('2026-08-10T00:00:00.000Z'),
});

test('an unchanged test is given what it learned', () => {
  const got = memoryFor({ stored: storedRow(), inputs: base() });
  assert.equal(got.used, true);
  assert.equal(got.withheld, null);
  assert.deepEqual(got.supplied, NOTEBOOK);
});

test('what crosses to the agent is the one value the panel shows', () => {
  // There is no hidden memory visible only to the model, and the way to keep
  // that true is to have one value rather than two that must agree. The agent
  // words it (`run_memory.to_prompt`); the server does not render a second copy
  // that could drift from this one.
  const got = memoryFor({ stored: storedRow(), inputs: base() });
  assert.equal(Object.keys(got).includes('prompt'), false, 'no second rendering to drift');
  assert.deepEqual(got.supplied, storedRow().learned, 'and it is the stored notebook itself');
});

test('a changed input withholds on READ, whatever the row says', () => {
  // The row's own fingerprint records what the last writer knew; the comparison
  // is what this run knows. A row trusted over the comparison is how advice
  // about a different app reaches a prompt while every column looks correct.
  const got = memoryFor({
    stored: storedRow(),
    inputs: { ...base(), start_url: 'https://app.example.com/invoices' },
  });
  assert.equal(got.used, false);
  assert.equal(got.supplied, null, 'nothing is supplied, so the run is cold');
  assert.equal(got.withheld, 'inputs_changed');
});

test('the superseded lessons stay readable until a pass replaces them', () => {
  // "Recoverable" costs no extra column and no archived state: the row keeps
  // what it held, it simply stops applying. Someone investigating the change
  // needs to see what the test used to believe.
  const stored = storedRow();
  const got = memoryFor({ stored, inputs: { ...base(), goal: 'Cancel the subscription' } });
  assert.equal(got.supplied, null);
  assert.deepEqual(stored.learned, NOTEBOOK, 'the read does not empty the row');
});

test('a run that did not pass leaves the notebook exactly where it was', () => {
  // A failing run says nothing about the advice. The commonest reason a QA test
  // fails is that it found the bug it exists to find, and withholding there
  // would make the next pass cold — which, under "cold replaces", throws away
  // every good lesson to punish a failure none of them caused.
  const stored = storedRow();
  const got = memoryFor({ stored, inputs: base() });
  assert.equal(got.used, true, 'the next run is still helped');
  assert.deepEqual(got.supplied, NOTEBOOK);
  assert.equal(got.withheld, null);
});

test('an empty notebook is not a withheld one', () => {
  // Nothing learned yet is the ordinary state of a new test, and the run feed
  // must not report it as advice being kept back. It is also what Clear leaves.
  const stored = { ...storedRow(), learned: { successful_approach: [], avoid_next_time: [], orientation: [] } };
  const got = memoryFor({ stored, inputs: base() });
  assert.equal(got.used, false);
  assert.equal(got.supplied, null);
  assert.equal(got.withheld, null);
});

test('a test with no row yet still gets a fingerprint', () => {
  // The first run of a saved test. Nothing to read, but it must be able to
  // write — and the conditional store compares against a fingerprint, so a null
  // here would make a first pass unable to teach anything, forever.
  const got = memoryFor({ stored: null, inputs: base() });
  assert.equal(got.supplied, null);
  assert.equal(got.used, false);
  assert.ok(got.fingerprint);
});

test('a run records the fingerprint it was given advice under', () => {
  // `runs.memory_fingerprint` is what the conditional write compares later, so
  // it is set whether or not anything was supplied. The first build added the
  // column and never wrote it, and every persisted run read back as cold.
  const inputs = { ...base(), start_url: 'https://app.example.com/invoices' };
  const changed = memoryFor({ stored: storedRow(), inputs });
  assert.equal(changed.fingerprint, fingerprint(inputs));
});

// --- the conditional write --------------------------------------------------

test('a run may only teach the inputs it actually ran with', () => {
  // Two runs of one test can be in flight together, and a test can be edited
  // while one is going. A blind upsert lets a run that started before the edit
  // teach a memory keyed to the post-edit fingerprint — and the row then looks
  // freshly learned while its advice describes an app the test no longer points
  // at. Nothing about that is visible afterwards.
  const at_start = fingerprint(base());
  assert.equal(mayStore({ runFingerprint: at_start, currentFingerprint: at_start }), true);
  const edited = withInput({ goal: 'Cancel the subscription' });
  assert.equal(mayStore({ runFingerprint: at_start, currentFingerprint: edited }), false);
});
