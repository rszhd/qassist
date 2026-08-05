// @ts-check
// US-058 — assertion-first spec for the PER-USER concurrency override: one
// account given more (or less) of the box than the instance default, without
// moving anyone else. Correctness-critical, and it re-opens three of the four
// surfaces US-028's row already names (`createRun` admission, `canStart`,
// `startNext`'s fair-share), so these assertions are written and reviewed
// before the implementation exists.
//
// This file is the OVERRIDE-ON-TOP-OF-THE-ENV case. Global 5, env per-user 2,
// so there is room above and below the default for an override to move a user
// in either direction. The env-UNSET case (an override with no instance
// default, where the FIFO fast path is the thing that would swallow it) is
// concurrency-override-off.test.js; the column and the loader are
// concurrency-override-postgres.test.js; the 429 wording is
// concurrency-override-route.test.js.
//
// Driven straight against the engine like US-028's files: explicit `user_id`
// gives us distinct users with no auth and no DB, and the override is planted
// through the in-memory setter rather than a row, because the setter IS the
// seam the DB writes through (see D9).
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these tests encode. The story left four open and I
// am proposing answers; each is pinned by an assertion below so rejecting one
// means editing a specific line, not re-reading the file. Edit the assertions
// directly; they are the spec.
//
//   D8  RESOLUTION ORDER, one place: override → MAX_CONCURRENT_PER_USER → null
//       (uncapped). `getUserConcurrencyCap` stays the sole reader of the
//       constant and keeps its `(userId) => number|null` signature — that is
//       what US-028 built the seam for, and it is why no `createRun` call site
//       grows an argument.
//
//   D9  THE CACHE, and the story's fork settled: in-memory Map, NOT a cap
//       stamped on the run. New home `server/src/concurrency.js` (runs.js is at
//       825 lines and this is a self-contained resolution order); runs.js
//       re-exports `getUserConcurrencyCap` so US-028's files keep importing it
//       from where they do. Surface:
//
//         getUserConcurrencyCap(userId) -> number|null     sync, the resolver
//         anyCapInForce()               -> boolean         sync, see D10
//         setUserConcurrencyCap(uid, n) -> void            sync write-through
//         loadUserConcurrencyCaps()     -> Promise<number> boot, all overrides
//         refreshUserConcurrencyCap(uid)-> Promise<n|null> one row, writes through
//         writeUserConcurrencyCap(uid,n)-> Promise<...>    the operator's write
//
//       Rejected the stamp-on-the-run alternative for a reason the story does
//       not name: it gets the ABUSE direction backwards. A queued run keeping
//       the cap it was admitted under is defensible when the operator is being
//       generous, but the case this story exists for is throttling one account
//       DOWN — and there the stamp means the burst that provoked the throttle
//       is exactly the burst the throttle does not reach.
//       [REVIEW: the fork itself, and the new file.]
//
//   D10 `startNext` stops asking `MAX_CONCURRENT_PER_USER == null` and asks
//       `anyCapInForce()` — env set OR any override present. With nothing
//       capped anywhere it must still take the plain `queue.shift()` drain, so
//       the off guarantee is a branch, not an emergent property.
//       [REVIEW: that "any override anywhere" flips the whole box onto the
//       eligibility scan. It is FIFO-equivalent for uncapped users — the scan
//       returns index 0 whenever the head is eligible — and
//       concurrency-override-off.test.js asserts exactly that.]
//
//   D11 A MISS IS THE ENV NUMBER, never a block and never uncapped. A cache
//       that has not heard of a user is indistinguishable from a user with no
//       override, which is the safe direction and the reason the sync
//       constraint costs nothing. Unlike the billing gate, forgetting to
//       refresh on one start path degrades to the instance default rather than
//       opening a hole — worth saying out loud, because it is what makes the
//       "seven start paths" hazard on the US-028 register weaker here.
//
//   D12 WHEN THE OPERATOR'S WRITE TAKES EFFECT. The script runs in its own
//       process (`npm run activate`'s precedent), so it cannot reach the
//       server's Map. Answer: boot loads every override, and the run-start
//       paths refresh the caller's own before admission — so a write lands on
//       that user's NEXT SUBMIT, with no restart. A restart is what the story
//       offered as the honest fallback and I think it is the wrong price: it
//       kills every in-flight run on a box that is serving.
//       [REVIEW: not asserted here — it is route wiring, and it belongs in
//       concurrency-override-route.test.js. Flagging so the omission is a
//       decision rather than a gap.]
//
//   D13 AN OVERRIDE ABOVE `MAX_CONCURRENT_SESSIONS` IS ACCEPTED, and is a
//       no-op — the global gate wins in `canStart` either way. Rejecting it at
//       write time reads friendlier but cannot actually work: the check would
//       have to live in a DB constraint, and a constraint cannot see an env
//       var. So the script warns and the gate stays the one truth. Pinned in
//       the postgres file.
//
//   D14 ZERO IS REFUSED: `check (max_concurrent_runs > 0)`. "May not run" is a
//       suspension, and the 429 copy ("wait for one to finish") would be a lie.
//       Pinned in the postgres file.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {typeof import('../src/concurrency.js')} */
let caps;

const A = 'user-a'; // override 3 — raised above the env default
const B = 'user-b'; // no override — the control, must stay on the env number
const C = 'user-c'; // override 1 — lowered below the env default
const D = 'user-d'; // no override, used to prove an at-cap user blocks nobody

let releaseDir = '';

/** Let the named stub runs finish — see `release=` in stubs/fake_agent.js. */
const release = (...names) =>
  names.forEach((name) => fs.writeFileSync(path.join(releaseDir, name), ''));

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-override-'));
  releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-override-release-'));
  process.env.QA_STUB_RELEASE_DIR = releaseDir;
  // Config is read at import time, so env must be set before importing.
  process.env.MAX_CONCURRENT_SESSIONS = '5'; // room for A's raised 3 + B's default 2
  process.env.MAX_CONCURRENT_PER_USER = '2'; // the instance default an override moves off
  process.env.QA_STUB_HOLD_MS = '200';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
  caps = await import('../src/concurrency.js');
});

/**
 * One ad-hoc run for `uid`. `trigger` defaults to an interactive one.
 *
 * Deliberately un-narrowed: these tests assert WHICH member of createRun's
 * union came back — including that a rejected one carries no `status` at all —
 * and the narrowed type is what would refuse to let them ask.
 */
const start = (goal, uid, trigger = 'api') =>
  /** @type {any} */ (
    engine.createRun({ goal, start_url: 'https://example.test', max_steps: 1, user_id: uid, trigger })
  );

const asTest = (name) => ({
  id: randomUUID(),
  goal: name,
  start_url: 'https://example.test',
  max_steps: 1,
  model: null,
  variables: [],
});

async function pollUntil(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// Overrides are process-global state, so they are planted per test and cleared
// here — a leaked override would silently change the next test's arithmetic
// (and, via D10, which branch of startNext it even takes).
const plant = () => {
  caps.setUserConcurrencyCap(A, 3);
  caps.setUserConcurrencyCap(C, 1);
};

afterEach(async () => {
  // Held runs are process-global state too: a test that failed before its own
  // release calls would otherwise leave one holding a slot forever, and the
  // names are reused, so a leftover flag frees the NEXT test's run on spawn.
  release('all');
  await pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  });
  for (const name of fs.readdirSync(releaseDir)) fs.rmSync(path.join(releaseDir, name));
  for (const uid of [A, B, C, D]) caps.setUserConcurrencyCap(uid, null);
});

// --- D8: the resolution order itself -----------------------------------------

test('an override wins over the env number; everyone else still gets the env number (D8)', () => {
  plant();
  assert.equal(caps.getUserConcurrencyCap(A), 3, 'raised');
  assert.equal(caps.getUserConcurrencyCap(C), 1, 'lowered');
  assert.equal(caps.getUserConcurrencyCap(B), 2, 'no override → the instance default');
  assert.equal(
    caps.getUserConcurrencyCap('never-seen-by-the-cache'),
    2,
    'D11: a miss is the env number — not uncapped, and not a block'
  );
  assert.equal(caps.getUserConcurrencyCap(null), 2, 'the no-DB/legacy caller resolves too');

  // Same answer through the engine's re-export: US-028's files import it from
  // there, and one resolution order means one implementation behind both names.
  assert.equal(engine.getUserConcurrencyCap(A), 3);
});

test('clearing an override returns that user to the env number (D9)', () => {
  caps.setUserConcurrencyCap(A, 3);
  assert.equal(caps.getUserConcurrencyCap(A), 3);
  caps.setUserConcurrencyCap(A, null);
  assert.equal(caps.getUserConcurrencyCap(A), 2, 'cleared, not remembered as 0 or as uncapped');
});

// --- the two directions, at admission ----------------------------------------

test('an override RAISES one user past the env cap while everyone else stays on it', () => {
  plant();
  // A's three all start: 3 > the env 2, and the global has room for them.
  const a = ['a1', 'a2', 'a3'].map((g) => start(g, A));
  assert.ok(a.every((r) => r.status === 'running'), 'the raised cap actually admits a third');

  // B is the control and is untouched by A's override: 2 admitted, the third
  // refused at the ENV number. This is the "without changing what everyone else
  // gets" half of the story, and it fails loudly if the override is global.
  const b = ['b1', 'b2'].map((g) => start(g, B));
  assert.ok(b.every((r) => r.status === 'running'));
  const b3 = start('b3', B);
  assert.equal(b3.rejected, true);
  assert.equal(b3.cap, 2, "B's refusal names the instance default, not A's 3");

  // And A is not uncapped — 3 is a cap, it just is not 2.
  const a4 = start('a4', A);
  assert.equal(a4.rejected, true);
  assert.equal(a4.cap, 3);
  assert.equal(a4.inFlight, 3);

  assert.deepEqual(engine.counts(), { active: 5, queued: 0 });
});

test('an override LOWERS one user below the env cap, and the second run is refused', () => {
  plant();
  const c1 = start('c1', C);
  assert.equal(c1.status, 'running');

  // The env would allow a second. The override is what refuses it, and the
  // marker has to carry the EFFECTIVE cap — the route renders `limit ${cap}`
  // straight out of it (AC: the 429 names the effective cap).
  const c2 = start('c2', C);
  assert.equal(c2.rejected, true);
  assert.equal(c2.cap, 1);
  assert.equal(c2.inFlight, 1);
  assert.equal(c2.status, undefined, 'a rejected run is not a run');
  assert.deepEqual(engine.counts(), { active: 1, queued: 0 }, 'nothing queued behind the refusal');
});

test('the override reaches ADMISSION\'s running+queued count, not only the running one', () => {
  plant();
  // Saturate the global with other users so C's run can only QUEUE.
  ['a1', 'a2', 'a3'].forEach((g) => start(g, A));
  ['b1', 'b2'].forEach((g) => start(g, B));
  assert.deepEqual(engine.counts(), { active: 5, queued: 0 });

  const c1 = start('c1', C);
  assert.equal(c1.status, 'queued', 'global is full, so C waits');

  // The load-bearing case for US-028's D2 asymmetry, now with an override in
  // play: C has ZERO running. An admission path that counted running-only —
  // or that counted in-flight but resolved the cap from the env — admits this.
  const c2 = start('c2', C);
  assert.equal(c2.rejected, true);
  assert.equal(c2.cap, 1);
  assert.equal(c2.inFlight, 1, 'the queued run is the one in flight');
  assert.deepEqual(engine.counts(), { active: 5, queued: 1 });
});

// --- the start gate ----------------------------------------------------------

test('the START GATE holds an overridden user to their own cap with global slots free', () => {
  plant();
  // Schedules bypass admission by design (US-028 D3), so this is the only way
  // to get past-cap runs into the queue and prove the gate independently.
  const results = engine.runTests([asTest('c1'), asTest('c2'), asTest('c3')], {
    user_id: C,
    trigger: 'schedule',
  });
  assert.equal(results.filter((r) => r.rejected).length, 0, 'a schedule is never rejected');

  // Four global slots are free. `active: 2` here would mean the gate resolved
  // the env number instead of C's override.
  assert.deepEqual(engine.counts(), { active: 1, queued: 2 });
});

// --- the fair-share dequeue --------------------------------------------------

test('the FAIR-SHARE DEQUEUE reads the override: a freed slot is left idle for an at-cap user', async () => {
  plant();
  // C: one run held open (at their override cap of 1) plus two queued behind it.
  engine.runTests([asTest('release=c1 c1'), asTest('release=c2 c2'), asTest('release=c3 c3')], {
    user_id: C,
    trigger: 'schedule',
  });
  assert.deepEqual(engine.counts(), { active: 1, queued: 2 });

  // A fills the rest of the box, so the only slot that CAN free is B's — which
  // is the one this test lets go. Held open by name rather than by a duration,
  // for BUG-007's reason: a wait in milliseconds is a race with the box.
  ['release=a1 a1', 'release=a2 a2', 'release=a3 a3'].forEach((g) => start(g, A));
  const b1 = start('release=b1 b1', B);
  assert.equal(b1.status, 'running');
  assert.deepEqual(engine.counts(), { active: 5, queued: 2 });
  release('b1');

  // B's slot frees. The queue head is C's, and C is at their OVERRIDDEN cap of
  // 1 running — so nobody is eligible and the slot is left idle. Resolving the
  // env 2 here promotes c2 and `active` stays 5: that is the failure this test
  // exists for, and it is invisible on a box that is not full.
  await pollUntil(() => engine.counts().active === 4);
  await new Promise((r) => setTimeout(r, 150)); // give a wrong promotion time to happen
  assert.deepEqual(
    engine.counts(),
    { active: 4, queued: 2 },
    'c2 must not be promoted while C is at their override'
  );
  release('a1', 'a2', 'a3', 'c1', 'c2', 'c3');
});

test('a user at their OVERRIDDEN cap does not block another user\'s queued run', async () => {
  plant();
  // Same shape, with one difference: D is queued BEHIND C's surplus.
  engine.runTests([asTest('release=c1 c1'), asTest('release=c2 c2'), asTest('release=c3 c3')], {
    user_id: C,
    trigger: 'schedule',
  });
  ['release=a1 a1', 'release=a2 a2', 'release=a3 a3'].forEach((g) => start(g, A));
  const b1 = start('release=b1 b1', B);
  assert.equal(b1.status, 'running');

  const d1 = start('release=d1 d1', D);
  assert.equal(d1.status, 'queued', 'global is full; D queues behind c2 and c3');
  assert.deepEqual(engine.counts(), { active: 5, queued: 3 });
  release('b1');

  // When B's slot frees, the scan skips C's two (at cap) and promotes D's —
  // the slot is NOT left idle merely because the head is ineligible, and D is
  // not made to wait out a user who is already over their fair share.
  await pollUntil(() => d1.status === 'running');
  assert.deepEqual(engine.counts(), { active: 5, queued: 2 }, 'D took the slot, C still waits');
  release('a1', 'a2', 'a3', 'c1', 'c2', 'c3', 'd1');
});
