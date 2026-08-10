// @ts-check
// US-081 — what one run is given, and what a finished run may write.
//
// What this file guards is invisible on the page. Memory changes the prompt, so
// every wrong answer here arrives as a *plausible verdict* — a run that passed
// or failed for reasons nobody disputes, because nothing downstream contradicts
// the advice it was given. There is no red build, no stack trace and no bar to
// notice; the only symptom is that the fleet slowly gets worse at flows it used
// to handle (backlog/correctness-critical.md).
//
// **There is no fingerprint** (revised 2026-08-10). It was eleven resolved
// inputs, then two, and now none: a notebook is supplied until somebody says
// otherwise. The rule it enforced — an edit makes the next run cold — is gone,
// so the hash had no consumer left, and gating the *write* on it instead would
// have been worse than useless: an edited test could never have learned again.
//
// What it cost is worth writing down rather than discovering. Repoint a test's
// start URL at a different app and its old notebook is still supplied. That was
// the fingerprint's whole reason for existing, and it is now the person's call —
// Clear is the answer, and it is one click in the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_FORMAT_VERSION, memoryFor } from '../src/testMemory.js';

const NOTEBOOK = {
  successful_approach: [
    { id: 'a1', text: 'Open Billing from the account menu', steps: [4], run_id: 'run-1' },
  ],
  avoid_next_time: [],
  orientation: [],
};

const storedRow = () => ({
  learned: NOTEBOOK,
  learned_at: Date.parse('2026-08-10T00:00:00.000Z'),
});

test('a test that has learned something is given it', () => {
  const got = memoryFor({ stored: storedRow() });
  assert.equal(got.used, true);
  assert.deepEqual(got.supplied, NOTEBOOK);
});

test('what crosses to the agent is the one value the panel shows', () => {
  // There is no hidden memory visible only to the model, and the way to keep
  // that true is to have one value rather than two that must agree. The agent
  // words it (`run_memory.to_prompt`); the server does not render a second copy
  // that could drift from this one.
  const got = memoryFor({ stored: storedRow() });
  assert.equal(Object.keys(got).includes('prompt'), false, 'no second rendering to drift');
  assert.deepEqual(got.supplied, storedRow().learned, 'and it is the stored notebook itself');
});

test('a test with no row yet is cold, and that is its first run', () => {
  const got = memoryFor({ stored: null });
  assert.equal(got.used, false);
  assert.equal(got.supplied, null);
});

test('an empty notebook supplies nothing', () => {
  // What Clear leaves behind if the row survives, and what removing the last
  // lesson leaves. Nothing to say is not the same as something withheld.
  const stored = {
    learned: { successful_approach: [], avoid_next_time: [], orientation: [] },
  };
  assert.equal(memoryFor({ stored }).used, false);
  assert.equal(memoryFor({ stored }).supplied, null);
});

test('nothing about the run itself can withhold a notebook', () => {
  // The whole of the revised rule, asserted as the absence it is. A notebook is
  // supplied until a person removes a lesson or clears it — not because the test
  // was edited, not because the last run failed, not because the model changed.
  // Every one of those was a reason at some point in this story's life, and each
  // one cost a fleet its notebooks for a change that left the app where it was.
  const got = memoryFor({ stored: storedRow() });
  assert.equal(got.used, true);
  assert.equal(Object.keys(got).includes('withheld'), false, 'nothing left to explain');
});

test('the format version is a deliberate lever, not a comparison', () => {
  // Stored on the row so a deployment can discard an old learned SHAPE by query,
  // on purpose. It is the only thing left that can invalidate a notebook without
  // somebody clicking, and it takes a migration to fire.
  assert.equal(typeof MEMORY_FORMAT_VERSION, 'number');
});
