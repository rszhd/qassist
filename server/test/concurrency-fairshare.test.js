// @ts-check
// US-028 — assertion-first spec, part 2: FAIR-SHARE. These properties only
// appear when the GLOBAL cap is ABOVE the per-user cap (so there are spare
// global slots the per-user cap must refuse), which the admission file can't
// set — MAX_CONCURRENT_SESSIONS is import-time frozen. Global 3, per-user 2.
//
// The two properties, both about "running", not "in flight":
//
//   P-bound   A user is bounded to `cap` RUNNING at once even with free global
//             slots — the start-gate is `active < GLOBAL && runningForUser < cap`.
//             This is what stops a scheduled burst (which bypasses admission)
//             from taking the whole box. (Ties off D3 from the admission file.)
//
//   P-fair    A user's over-cap QUEUED surplus does not hog a freed global slot:
//             another user's run takes it. Enforced at submit (a second user
//             starts ahead of the surplus) AND at dequeue (startNext promotes
//             the first queued run whose owner is under cap RUNNING — a linear
//             scan, `nextEligibleIndex`, NOT a scheduler).
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — decisions specific to this file (the shared ones are in the header
// of concurrency-cap.test.js):
//
//   D7  P-fair's dequeue half (the async test at the bottom) needs to free ONE
//       specific slot while another user is still at cap. It does that with the
//       stub's `release=<name>` — a run holds its slot until the test drops the
//       named file. Originally a per-run `hold=<ms>`, which said the same thing
//       as a race the test only won on an idle box: it finished 7.8s into an 8s
//       drain budget every run, and lost the race often enough to be one of the
//       five names in BUG-007.
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

const A = 'user-a';
const B = 'user-b';

let releaseDir = '';

/** Let the named stub runs finish — see `release=` in stubs/fake_agent.js. */
const release = (...names) =>
  names.forEach((name) => fs.writeFileSync(path.join(releaseDir, name), ''));

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-fairshare-'));
  releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-fairshare-release-'));
  process.env.QA_STUB_RELEASE_DIR = releaseDir;
  process.env.MAX_CONCURRENT_SESSIONS = '3'; // ABOVE the per-user cap: spare global slots the cap must refuse
  process.env.MAX_CONCURRENT_PER_USER = '2';
  process.env.QA_STUB_HOLD_MS = '250';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
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

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

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
});

test('P-bound: a scheduled burst is held to `cap` running even with a free global slot (D3)', () => {
  const results = engine.runTests([asTest('s1'), asTest('s2'), asTest('s3'), asTest('s4')], {
    user_id: A,
    trigger: 'schedule',
  });
  assert.equal(results.filter((r) => r.rejected).length, 0, 'schedules are never rejected');

  // Global has 3 slots, but A is one user with cap 2: exactly 2 run, 2 queue.
  // active === 3 here would mean the cap was ignored on the start path.
  assert.deepEqual(engine.counts(), { active: 2, queued: 2 });
});

test('P-fair (submit): another user takes the free global slot ahead of A\'s over-cap surplus', () => {
  // A fills its cap and queues a third (via schedule, so it isn't rejected).
  engine.runTests([asTest('a1'), asTest('a2'), asTest('a3')], { user_id: A, trigger: 'schedule' });
  assert.deepEqual(engine.counts(), { active: 2, queued: 1 }); // 2 A running, a3 queued

  // B submits: the 3rd global slot is free and B is under cap → B RUNS now,
  // jumping A's queued surplus. If the free slot had gone FIFO to a3, B would
  // wait behind a user who is already at their fair share.
  const b1 = start('b1', B);
  assert.notEqual(b1.rejected, true);
  assert.equal(b1.status, 'running');
  assert.deepEqual(engine.counts(), { active: 3, queued: 1 });
});

// P-fair (dequeue): the eligibility scan itself. Requires the D7 stub extension.
test('P-fair (dequeue): a freed slot is left idle rather than promoting an at-cap user', async () => {
  // A: two runs held open (fills cap), plus one queued.
  engine.runTests(
    [asTest('release=a1 a1'), asTest('release=a2 a2'), asTest('release=a3 a3')],
    { user_id: A, trigger: 'schedule' }
  );
  assert.deepEqual(engine.counts(), { active: 2, queued: 1 });

  // B: one run in the 3rd slot, and the only one let go — so it is the only
  // slot that CAN free, whatever else the box is doing. Said in milliseconds
  // instead, this test spent 7.8s of an 8s drain budget every run (BUG-007).
  const b1 = start('release=b1 b1', B);
  assert.equal(b1.status, 'running');
  assert.deepEqual(engine.counts(), { active: 3, queued: 1 });
  release('b1');

  // When B's slot frees, the only queued run is A's — but A is still at cap
  // RUNNING (2), so it is NOT eligible. The slot is left idle: active falls to
  // 2 and a3 stays queued, rather than active staying 3 by promoting a3.
  await pollUntil(() => engine.counts().active === 2);
  assert.deepEqual(engine.counts(), { active: 2, queued: 1 }, 'a3 not promoted while A is at cap');

  // Once one of A's runs finishes, a3 becomes eligible and drains — the
  // afterEach hook waits that out.
  release('a1', 'a2', 'a3');
});
