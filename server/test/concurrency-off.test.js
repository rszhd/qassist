// @ts-check
// US-028 — assertion-first spec, part 3: the OFF guarantee (AC #1). With
// MAX_CONCURRENT_PER_USER unset, behaviour is byte-for-byte today's — one global
// FIFO queue, no per-user accounting, self-host untouched. This is the guardrail
// that the whole feature hides behind an env flag: a solo self-hoster who never
// sets the var must see exactly the pre-US-028 engine.
//
// REVIEWER: the contract is (a) getUserConcurrencyCap returns null when unset,
// (b) a single user can pile past what any cap would allow with NO rejection,
// (c) drain order is plain FIFO (startNext keeps its `queue.shift()` fast path
// when the cap is null — no eligibility scan). [REVIEW: null as the "off"
// sentinel; that createRun never returns a `rejected` object in this mode.]
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/runs.js')} */
let engine;

const A = 'user-a';

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cap-off-'));
  process.env.MAX_CONCURRENT_SESSIONS = '1';
  delete process.env.MAX_CONCURRENT_PER_USER; // OFF
  process.env.QA_STUB_HOLD_MS = '200';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
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

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

afterEach(() =>
  pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  })
);

test('getUserConcurrencyCap is null when the env is unset', () => {
  assert.equal(engine.getUserConcurrencyCap(A), null);
});

test('one user can pile far past any cap with no rejection — plain FIFO queue', () => {
  const runs = ['1', '2', '3', '4', '5'].map((n) => start(`a${n}`, A));

  // None rejected: createRun returns a real run every time in off mode.
  for (const r of runs) assert.notEqual(r.rejected, true);

  // Byte-for-byte today's: 1 running, the other 4 queued FIFO behind it.
  assert.equal(runs[0].status, 'running');
  assert.ok(runs.slice(1).every((r) => r.status === 'queued'));
  assert.deepEqual(engine.counts(), { active: 1, queued: 4 });
});
