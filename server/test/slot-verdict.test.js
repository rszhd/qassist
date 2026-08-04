// @ts-check
// US-069: the rule that turns a slot's runs into one bar.
//
// Asserted directly rather than through a rendered strip, because the failure
// this guards is invisible on the page: every wrong answer here is *green*, and
// a green bar is not a symptom anyone chases. Nothing downstream contradicts
// it, no other test fails, and the reader's conclusion is "fine".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotVerdict, SLOT_PRECEDENCE } from '../src/slotVerdict.js';

test('a slot every member passed is the only green one', () => {
  assert.equal(slotVerdict(['passed']), 'passed');
  assert.equal(slotVerdict(['passed', 'passed', 'passed']), 'passed');
});

test('one bad member colours the whole slot', () => {
  // The suite case: nine passes and one error is not a good night, and the
  // strip has one bar to say so.
  assert.equal(slotVerdict([...Array(9).fill('passed'), 'error']), 'error');
  assert.equal(slotVerdict([...Array(9).fill('passed'), 'failed']), 'failed');
  assert.equal(slotVerdict(['failed', 'error']), 'error', 'error outranks failed');
});

test('an outcome outranks a member still in flight', () => {
  // A slot with a failure has already failed; the members still going cannot
  // take it back. Reading this as "running" would leave the bar to settle into
  // something later, and the alarm arrives whenever that happens to be.
  assert.equal(slotVerdict(['failed', 'running']), 'failed');
  assert.equal(slotVerdict(['error', 'queued', 'passed']), 'error');
});

test('a slot still in flight reads as running, not as passed', () => {
  assert.equal(slotVerdict(['passed', 'running']), 'running');
  assert.equal(slotVerdict(['passed', 'queued']), 'queued');
  assert.equal(slotVerdict(['running', 'queued']), 'running', 'something has started');
});

test('an unfinished slot is not given a settled answer', () => {
  // `cancelled` and `completed` both read as over. A slot holding one of them
  // and one member still going is not over.
  assert.equal(slotVerdict(['cancelled', 'running']), 'running');
  assert.equal(slotVerdict(['completed', 'queued']), 'queued');
});

test('ending without a verdict is not passing', () => {
  // US-047's stop, and a run that used up its steps. Neither met the goal, and
  // neither is a failure — but a slot holding one is not green.
  assert.equal(slotVerdict(['passed', 'cancelled']), 'cancelled');
  assert.equal(slotVerdict(['passed', 'completed']), 'completed');
  assert.equal(slotVerdict(['cancelled', 'completed']), 'cancelled');
});

test('a status the rule has never seen is loud, not green', () => {
  // The guard against the next status added to the check constraint. A new
  // value falling through to green is exactly the silent failure this module
  // exists to prevent, so it sorts worst until someone places it deliberately.
  assert.equal(slotVerdict(['passed', 'transmogrified']), 'error');
  assert.equal(slotVerdict([]), 'error');
});

test('every status the runs table allows has a place in the order', () => {
  // 001_init.sql's check constraint plus 011's `cancelled`. If a migration
  // adds one, this fails here rather than showing up as an unexplained bar.
  const stored = ['queued', 'running', 'passed', 'failed', 'completed', 'error', 'cancelled'];
  assert.deepEqual([...SLOT_PRECEDENCE].sort(), [...stored].sort());
});

test('the verdict does not depend on the order the runs came back in', () => {
  const members = ['passed', 'running', 'failed', 'completed'];
  const shuffled = [...members].reverse();
  assert.equal(slotVerdict(members), slotVerdict(shuffled));
  assert.equal(slotVerdict(members), 'failed');
});
