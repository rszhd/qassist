// @ts-check
// Queue visibility (US-027): a run past the concurrency cap has to say so, and
// say how far back it is. Drives the run engine directly rather than through
// HTTP — the position travels over the WebSocket, and `attachViewer` takes any
// object that looks like one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/runs.js')} */
let engine;
let artifactsDir;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-queue-'));
  // Config is read at import time, so env must be set before importing.
  process.env.MAX_CONCURRENT_SESSIONS = '1'; // one slot: run 2 and 3 must wait
  process.env.QA_STUB_HOLD_MS = '400'; // long enough to inspect the queue
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  engine = await import('../src/runs.js');
});

/** A WebSocket as far as the relay is concerned: it records what it is sent. */
function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: /** @type {any[]} */ ([]),
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    on() {},
    statuses() {
      return this.sent.filter((e) => e.type === 'status');
    },
  };
}

const start = (goal) =>
  engine.createRun({ goal, start_url: 'https://example.test', max_steps: 1 });

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a run past the cap is queued with its position, and counts down as slots free', async () => {
  const first = start('first');
  const second = start('second');
  const third = start('third');

  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'queued');
  assert.deepEqual(engine.counts(), { active: 1, queued: 2 });

  // Attaching mid-wait replays the position the run is actually at — one
  // event, not the countdown so far.
  const ws = fakeSocket();
  engine.attachViewer(third, ws);
  assert.deepEqual(ws.statuses(), [{ type: 'status', status: 'queued', position: 1, concurrency: 1 }]);

  // First finishes → second starts, third moves up to next-in-line.
  await pollUntil(() => third.queueEvent?.position === 0);
  assert.deepEqual(ws.statuses().at(-1), {
    type: 'status',
    status: 'queued',
    position: 0,
    concurrency: 1,
  });
  assert.equal(second.status, 'running');

  // ...and once it starts, the queued state is gone rather than left to replay.
  await pollUntil(() => third.status === 'running');
  assert.equal(third.queueEvent, null);

  const late = fakeSocket();
  engine.attachViewer(third, late);
  assert.deepEqual(late.statuses(), [{ type: 'status', status: 'running' }]);

  await pollUntil(() => engine.TERMINAL.has(third.status));
});
