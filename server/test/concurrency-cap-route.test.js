// @ts-check
// US-028 — the HTTP contract for the per-user cap (D5): a single-run POST over
// the cap answers 429 with a message that NAMES the cap, so the UI can render it
// as "wait a moment" rather than a failure. The count math and fair-share live
// in concurrency-{cap,fairshare,off}.test.js (engine-level); this only pins the
// route's status + shape. Single-token mode (no auth/DB): both runs share the
// one operator user, so the per-user cap bites without a second identity.
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

before(async () => {
  delete process.env.WORKER_API_TOKEN;
  delete process.env.DATABASE_URL;
  process.env.MAX_CONCURRENT_SESSIONS = '2'; // above the per-user cap, so the 2nd run is refused by the CAP, not queued globally
  process.env.MAX_CONCURRENT_PER_USER = '1';
  process.env.QA_STUB_HOLD_MS = '500'; // keep the first run in flight while the second POST arrives
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cap-route-'));
  ({ app } = await import('../src/server.js'));
});

// A per-request key so the agent-key gate passes (US-039) and we reach the cap.
const post = () =>
  request(app)
    .post('/api/runs')
    .send({ goal: 'g', start_url: 'https://example.test', openai_api_key: 'sk-test-route-key-0123456789012345678901234567' });

test('a single-run POST over the cap answers 429 naming the cap; the first is accepted', async () => {
  const first = await post().expect(200); // takes the user's one slot
  assert.ok(first.body.runId);

  const over = await post().expect(429);
  assert.match(over.body.error, /in flight/);
  assert.match(over.body.error, /limit 1/, 'the message names the cap');
  assert.equal(over.body.cap, 1);
  assert.equal(over.body.inFlight, 1);
});
