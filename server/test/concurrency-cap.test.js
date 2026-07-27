// @ts-check
// US-028 — assertion-first spec for the per-user concurrent-run cap
// (correctness-critical: per-user count math + reject-vs-queue). This file
// covers ADMISSION and BATCH; the fair-share dequeue and the schedule
// running-bound live in concurrency-fairshare.test.js (they need a global cap
// ABOVE the per-user one, which is import-time frozen — hence the split), and
// the unset=no-op guarantee lives in concurrency-off.test.js.
//
// Driven directly against the run engine (like queue.test.js): every trigger
// path funnels through createRun, and passing an explicit user_id (the field
// the scheduler already uses) gives us distinct "users" with no auth/DB. All
// PLACEMENT is decided synchronously inside createRun, so these assertions read
// the outcome immediately — no polling for the interesting bit; afterEach only
// drains the slot so the next test starts clean.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these tests encode that I could NOT derive from the
// story, and that you're signing off before I implement. Edit the assertions
// directly; they are the spec.
//
//   D1  createRun's RETURN SHAPE changes: `run | { rejected:true, cap, inFlight }`.
//       Every caller (routes/runs.js, tests.js, runTests) must branch on it.
//       [REVIEW: field names `rejected`/`cap`/`inFlight`, and that a rejected
//       run leaves NO row and NO map entry — nothing to clean up.]
//
//   D2  TWO different counts, deliberately:
//         • admission (submit)  → inFlightForUser = running + queued
//         • start-gate/dequeue  → runningForUser  = running only
//       The queued-counts-toward-cap test below is the one that would pass if
//       someone wrongly counted running-only, so it's the load-bearing case.
//
//   D3  Trigger 'schedule' BYPASSES admission (never rejected — a burst of
//       schedules must not silently drop). It still obeys the running start-gate,
//       so it QUEUES past the cap rather than jumping it. Tested here (never
//       rejected) and in the fairshare file (bounded to cap running).
//
//   D4  BATCH = partial accept: admission is applied per-test AS the batch
//       enqueues, so the first H (= headroom) start/queue and the rest are
//       rejected, in order. runTests returns a mixed array; a rejected entry is
//       `{ testId, rejected:true, cap, inFlight }` — distinct from the existing
//       unresolved-variable `{ testId, error }`. [REVIEW: the rejected entry
//       shape, and that order is preserved (first H admitted, not an arbitrary H).]
//
//   D5  NOT tested here — flagged for a separate route-level assertion:
//         • the HTTP status: single POST → 429; batch → 200 with the mixed array
//           (200 even if all rejected). [REVIEW: confirm, esp. all-rejected batch.]
//         • the 429 MESSAGE wording ("you already have 2 runs in flight — wait
//           for one to finish"). It names the cap and is a UI contract, so it
//           wants its own assertion in a route test. Tell me the exact string.
//
//   D6  getUserConcurrencyCap(userId) ignores userId for v1 (returns the one env
//       number); it's the seam US-022 turns into a per-plan lookup.
//       SUPERSEDED by US-058, which fills the seam with a per-user override.
//       The assertion below survives — no override is set in this file, so the
//       env number is still every answer — but it now pins "the default when
//       nobody is overridden" rather than "the id is thrown away". The override
//       cases are concurrency-override*.test.js; everything else here is
//       unchanged and is US-058's regression proof for the un-overridden path.
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

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cap-'));
  // Config is read at import time, so env must be set before importing.
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // one global slot: forces a per-user run to QUEUE, so "queued counts toward the cap" is observable
  process.env.MAX_CONCURRENT_PER_USER = '2'; // the cap under test
  process.env.QA_STUB_HOLD_MS = '200'; // keep a run in its slot across the synchronous asserts, then let it finish so afterEach can drain
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
});

/** One ad-hoc run for `uid`; `trigger` defaults to an interactive one. */
const start = (goal, uid, trigger = 'api') =>
  engine.createRun({ goal, start_url: 'https://example.test', max_steps: 1, user_id: uid, trigger });

/** A saved-test row shaped as runTests expects. */
const asTest = (name) => ({
  id: randomUUID(),
  goal: name,
  start_url: 'https://example.test',
  max_steps: 1,
  model: null,
  variables: [],
});

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// Every test leaves the engine empty for the next one: let running + queued
// runs finish (the stub exits after QA_STUB_HOLD_MS, freeing the slot, which
// drains the queue behind it).
afterEach(() =>
  pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  })
);

test('getUserConcurrencyCap returns the env number for a user with no override (D6)', () => {
  assert.equal(engine.getUserConcurrencyCap(A), 2);
  assert.equal(engine.getUserConcurrencyCap(B), 2);
});

test('a user over the cap is rejected, not queued — running AND queued both count (D2)', () => {
  const r1 = start('a1', A); // takes the single global slot
  const r2 = start('a2', A); // global full → queues; A now has 1 running + 1 queued = cap
  assert.equal(r1.status, 'running');
  assert.equal(r2.status, 'queued');
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });

  // The load-bearing case: A is at cap via 1 running + 1 QUEUED. Counting
  // running-only (1 < 2) would wrongly admit this; counting in-flight rejects it.
  const r3 = start('a3', A);
  assert.equal(r3.rejected, true);
  assert.equal(r3.cap, 2);
  assert.equal(r3.inFlight, 2);
  assert.equal(r3.status, undefined, 'a rejected run is not a run — no status');

  // Rejection left no trace: no third run in flight, nothing queued behind.
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });
});

test('the cap is PER USER: B is admitted while A is capped', () => {
  const a1 = start('a1', A);
  const a2 = start('a2', A); // A now at cap (1 running + 1 queued)
  assert.equal(start('a3', A).rejected, true);

  // B has nothing in flight → admitted, even though the global slot is A's and
  // B's run therefore queues. Admission is per-user; queueing is global.
  const b1 = start('b1', B);
  assert.notEqual(b1.rejected, true);
  assert.equal(b1.status, 'queued');
  assert.deepEqual(engine.counts(), { active: 1, queued: 2 });
  void a1;
  void a2;
});

test('a module over the cap is PARTIALLY accepted — first H start/queue, rest rejected, in order (D4)', () => {
  const tests = [asTest('m1'), asTest('m2'), asTest('m3'), asTest('m4')];
  const results = engine.runTests(tests, { user_id: A, trigger: 'api' });

  assert.equal(results.length, 4, 'one result per test, started or not');
  const started = results.filter((r) => r.runId);
  const rejected = results.filter((r) => r.rejected);
  assert.equal(started.length, 2, 'headroom is the cap (2) since A had nothing in flight');
  assert.equal(rejected.length, 2);

  // Order preserved: the FIRST two are the ones that ran, not an arbitrary two.
  assert.deepEqual(
    started.map((r) => r.testId),
    [tests[0].id, tests[1].id]
  );
  assert.deepEqual(
    rejected.map((r) => r.testId),
    [tests[2].id, tests[3].id]
  );
  // A rejected batch entry is distinct from the unresolved-variable {error} entry.
  assert.equal(rejected[0].cap, 2);

  // One running, one queued — exactly the two admitted.
  assert.deepEqual(engine.counts(), { active: 1, queued: 1 });
});

test("scheduled runs are NEVER rejected — they queue past the cap rather than drop (D3)", () => {
  const tests = [asTest('s1'), asTest('s2'), asTest('s3'), asTest('s4'), asTest('s5')];
  const results = engine.runTests(tests, { user_id: A, trigger: 'schedule' });

  assert.equal(results.length, 5);
  assert.equal(
    results.filter((r) => r.rejected).length,
    0,
    'a schedule fires without a human — a 429 here would silently drop tests'
  );
  assert.ok(results.every((r) => r.runId), 'every scheduled test got a run');
  // Global cap is 1 here, so 1 runs and 4 queue — the point is that all 5 were
  // admitted. The cap-running bound on schedules is proven in the fairshare file.
  assert.deepEqual(engine.counts(), { active: 1, queued: 4 });
});
