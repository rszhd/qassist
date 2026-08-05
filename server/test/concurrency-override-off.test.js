// @ts-check
// US-058 — assertion-first spec, part 2: an override with `MAX_CONCURRENT_PER_USER`
// UNSET, and the off guarantee that has to survive it.
//
// This is the case the story singles out and the one a reader is most likely to
// get wrong, because the bug is an ABSENCE: `startNext` currently branches on
// the module-level constant (`runs.js:735`), so on a box with no instance
// default the plain FIFO drain is taken and an override is silently ignored,
// cap and all. Nothing throws; the operator just watches the account they
// throttled keep running.
//
// The other half is the guarantee US-028 hid the whole feature behind: with
// nothing capped ANYWHERE, a self-hoster still gets byte-for-byte the
// pre-US-028 engine. concurrency-off.test.js pins that for the env; this file
// re-pins it now that "capped anywhere" is a bigger set, and adds the case that
// only exists once overrides do — one user's override must not drag everyone
// else onto per-user accounting they never asked for.
//
// REVIEWER: shared decisions are in concurrency-override.test.js's header. The
// one this file is really asking you to sign off is D10 — `anyCapInForce()`
// replacing `MAX_CONCURRENT_PER_USER == null` as startNext's branch, and the
// claim that the eligibility scan is FIFO-EQUIVALENT for uncapped users rather
// than merely close enough. The last test is that claim, asserted on drain
// ORDER rather than on counts, because counts cannot see it.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {typeof import('../src/concurrency.js')} */
let caps;

const A = 'user-a'; // the one throttled account
const B = 'user-b'; // everyone else on an uncapped instance

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-override-off-'));
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // one slot: everything past the first must queue, which is what makes drain order observable
  delete process.env.MAX_CONCURRENT_PER_USER; // no instance default — the whole point of this file
  process.env.QA_STUB_HOLD_MS = '200';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
  caps = await import('../src/concurrency.js');
});

/**
 * One ad-hoc run for `uid`.
 *
 * Deliberately un-narrowed: these tests assert WHICH member of createRun's
 * union came back — including that a rejected one carries no `status` at all —
 * and the narrowed type is what would refuse to let them ask.
 */
const start = (goal, uid) =>
  /** @type {any} */ (
    engine.createRun({ goal, start_url: 'https://example.test', max_steps: 1, user_id: uid, trigger: 'api' })
  );

async function pollUntil(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

afterEach(async () => {
  await pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  });
  for (const uid of [A, B]) caps.setUserConcurrencyCap(uid, null);
});

test('with the env unset and no overrides, nothing is capped and no scan is entered', () => {
  assert.equal(caps.getUserConcurrencyCap(A), null, 'null is the off sentinel, still');
  assert.equal(
    caps.anyCapInForce(),
    false,
    'D10: no env, no override → startNext must take the plain queue.shift() drain'
  );

  const runs = ['1', '2', '3', '4', '5'].map((n) => start(`a${n}`, A));
  for (const r of runs) assert.notEqual(r.rejected, true, 'admission is not even consulted');
  assert.equal(runs[0].status, 'running');
  assert.ok(runs.slice(1).every((r) => r.status === 'queued'));
  assert.deepEqual(engine.counts(), { active: 1, queued: 4 });
});

test('an override with the env UNSET is enforced — the FIFO fast path does not swallow it', () => {
  caps.setUserConcurrencyCap(A, 1);
  assert.equal(caps.getUserConcurrencyCap(A), 1, 'the override IS the cap when there is no default');
  assert.equal(caps.anyCapInForce(), true, 'D10: one override arms the eligibility scan');

  const a1 = start('a1', A);
  assert.equal(a1.status, 'running');

  // Nothing in the env says "cap"; the row does. An implementation that reads
  // the constant to decide whether capping happens at all admits this run.
  const a2 = start('a2', A);
  assert.equal(a2.rejected, true);
  assert.equal(a2.cap, 1);
  assert.equal(a2.inFlight, 1);
  assert.deepEqual(engine.counts(), { active: 1, queued: 0 });
});

test('one user\'s override does not cap anyone else on an otherwise uncapped instance', () => {
  caps.setUserConcurrencyCap(A, 1);
  assert.equal(caps.getUserConcurrencyCap(B), null, 'B has no override and there is no default');

  // The inverse of the previous test, and the one a "turn accounting on
  // globally" implementation fails: B must still be able to pile up freely.
  const runs = ['1', '2', '3', '4'].map((n) => start(`b${n}`, B));
  for (const r of runs) assert.notEqual(r.rejected, true);
  assert.deepEqual(engine.counts(), { active: 1, queued: 3 });
});

test('the eligibility scan drains uncapped users in byte-for-byte FIFO order (D10)', async () => {
  // A's override is what arms the scan; A submits nothing. Everything below
  // drains through the scan branch rather than through queue.shift().
  caps.setUserConcurrencyCap(A, 1);
  assert.equal(caps.anyCapInForce(), true);

  const runs = ['1', '2', '3', '4', '5'].map((n) => start(`b${n}`, B));
  assert.deepEqual(engine.counts(), { active: 1, queued: 4 });

  await pollUntil(() => engine.counts().active === 0 && engine.counts().queued === 0);

  // Counts can't tell FIFO from any other drain order, so assert on when each
  // run actually took the slot. The single global slot serialises them ~200ms
  // apart, so these timestamps are strictly ordered or the order was wrong.
  const startedAt = runs.map((r) => r.startedAt);
  assert.ok(startedAt.every((t) => typeof t === 'number'), 'every run eventually started');
  assert.deepEqual(
    startedAt,
    [...startedAt].sort((x, y) => x - y),
    'submission order === start order: the scan picks index 0 whenever the head is eligible'
  );
});
