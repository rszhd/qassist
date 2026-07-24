// @ts-check
// Live demo replay (US-033), gate ON. The demo is an unauthenticated,
// fixture-backed replay: it must play the recorded event log without spawning
// an agent, taking a queue slot or creating a run — that "costs nothing" is the
// whole point of the story, so it is asserted here. Gate-OFF (no route, no
// unauthenticated surface) lives in demo-off.test.js, which boots the app with
// DEMO_MODE unset.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('express').Express} */
let app;
/** @type {typeof import('../src/demo.js')} */
let demo;
/** @type {typeof import('../src/runs.js')} */
let engine;

before(async () => {
  // Config is read at import time — set the gate and point it at the checked-in
  // test fixtures before importing anything that reads config.
  process.env.DEMO_MODE = '1';
  process.env.DEMO_DIR = path.join(__dirname, 'fixtures', 'demo');
  process.env.DEMO_CTA_URL = 'https://example.test/signup';
  delete process.env.DEMO_SPEED; // default 1
  delete process.env.DATABASE_URL;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-'));
  demo = await import('../src/demo.js');
  engine = await import('../src/runs.js');
  ({ app } = await import('../src/server.js'));
});

/** A WebSocket as far as the replayer is concerned. Records what it is sent. */
function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    closed: false,
    sent: /** @type {any[]} */ ([]),
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
    on() {},
  };
}

// Run every scheduled event immediately, in order, so the replay is
// deterministic without waiting on real timers.
const now = (fn) => {
  fn();
  return null;
};

test('loadDemo parses a fixture and rejects one with no meta', () => {
  const d = demo.loadDemo('sample-pass');
  assert.ok(d);
  assert.equal(d.verdict, 'pass');
  assert.equal(d.hasRecording, true);
  assert.equal(d.events.length, 5);
  assert.equal(demo.loadDemo('no-meta'), null);
});

test('listDemos returns loadable fixtures only', () => {
  const list = demo.listDemos();
  const slugs = list.map((x) => x.slug);
  assert.deepEqual(slugs, ['sample-pass']); // no-meta is skipped
  assert.equal(list[0].name, 'Checkout completes');
  assert.equal(list[0].verdict, 'pass');
});

test('recordingPath resolves a fixture and refuses traversal', () => {
  assert.ok(demo.recordingPath('sample-pass'));
  assert.equal(demo.recordingPath('no-meta'), null); // no recording file
  assert.equal(demo.recordingPath('../server'), null);
  assert.equal(demo.recordingPath('..%2Fserver'), null);
});

test('replayDemo plays the fixture events then a synthesized end', () => {
  const ws = fakeSocket();
  demo.replayDemo(ws, 'sample-pass', now);
  const types = ws.sent.map((e) => e.type);
  assert.deepEqual(types, ['status', 'step', 'step', 'recording', 'done', 'end']);
  assert.equal(ws.sent[0].status, 'running');
  assert.equal(ws.sent[4].success, true);
  assert.equal(ws.sent.at(-1).demo, true); // the end marks itself a demo
});

test('replayDemo on an unknown slug reports and closes, sending no events', () => {
  const ws = fakeSocket();
  demo.replayDemo(ws, 'does-not-exist', now);
  assert.deepEqual(ws.sent.map((e) => e.type), ['error']);
  assert.equal(ws.closed, true);
});

test('a replay creates no run: no agent, no queue slot, no runs row', () => {
  const before = engine.counts();
  const ws = fakeSocket();
  demo.replayDemo(ws, 'sample-pass', now);
  // The replay ran to completion (the `done` proves it) yet nothing entered the
  // run engine — no spawn, no queue, nothing to persist.
  assert.ok(ws.sent.some((e) => e.type === 'done'));
  assert.deepEqual(engine.counts(), before);
  assert.deepEqual(engine.counts(), { active: 0, queued: 0 });
});

test('GET /api/demo lists the demos with replay metadata', async () => {
  const res = await request(app).get('/api/demo').expect(200);
  assert.equal(res.body.demos.length, 1);
  assert.equal(res.body.demos[0].slug, 'sample-pass');
  assert.equal(res.body.speed, 1);
  assert.equal(res.body.ctaUrl, 'https://example.test/signup');
});

test('GET /api/demo/:slug/recording serves the video, unknown slug 404s', async () => {
  const ok = await request(app).get('/api/demo/sample-pass/recording').expect(200);
  assert.match(ok.headers['content-type'], /video\/mp4/);
  await request(app).get('/api/demo/nope/recording').expect(404);
});

test('the demo endpoints are rate-limited per IP', async () => {
  // A burst well past the window budget must start being refused. Asserting
  // "eventually 429" rather than an exact index keeps it robust to requests the
  // earlier tests already spent from this process's window.
  let sawOk = false;
  let saw429 = false;
  for (let i = 0; i < 140; i++) {
    const res = await request(app).get('/api/demo');
    if (res.status === 200) sawOk = true;
    if (res.status === 429) {
      saw429 = true;
      assert.ok(res.headers['retry-after']);
      break;
    }
  }
  assert.ok(sawOk, 'some requests succeeded before the limit');
  assert.ok(saw429, 'the burst was eventually rate-limited');
});
