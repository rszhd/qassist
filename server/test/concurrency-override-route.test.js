// @ts-check
// US-058 — assertion-first spec, part 4: the HTTP contract, and D12's wiring.
//
// Two claims live here and nowhere else.
//
//   1. The 429 names the EFFECTIVE cap. `respondOverCap` already renders
//      `limit ${cap}` out of the engine's rejection marker, so this is really a
//      claim about what the marker carries — but it is the one line of this
//      story a user ever reads, and asserting it engine-side would leave the
//      rendering unproven against an override that differs from the env.
//
//   2. A row written by another process reaches the gate on the caller's NEXT
//      SUBMIT, with no restart. This is D12, and it is the whole reason the
//      cache is acceptable: the operator's `npm run concurrency` runs in its
//      own container process and can never touch the server's Map. The test
//      writes the column with a raw UPDATE precisely because that is what the
//      script's process looks like from in here.
//
// pg-mem rather than the engine's no-DB mode, so the operator user has a real
// uuid and the refresh has a real row to read. Single-token mode: both POSTs
// are the same user, so the per-user cap bites without a second identity.
//
// REVIEWER — the wiring decision, which is the last one the story left open:
//
//   D15 The refresh is its OWN middleware (`withUserCap`, helpers.js), placed
//       on the run-start routes next to `requireEntitled`/`requireAgentKey` —
//       NOT folded into either, and NOT put in the request gate. Not
//       `requireEntitled`: it returns before its DB read when billing is off,
//       and a self-hoster needs the override just as much. Not
//       `requireAgentKey`: it is waived in demo mode and skipped when the
//       request carries its own key. Not the gate: that runs on every media
//       byte and history page too, and this is one query the run paths owe.
//
//       US-054 folded activation INTO the billing middleware to kill the
//       "one of the seven start paths missed it" hazard, and I am deliberately
//       NOT copying that here — because of D11, a path that misses this
//       degrades to the instance default rather than opening a hole. A missed
//       billing gate is free service; a missed refresh is a stale number that
//       is still a cap. Different failure, different price, different rule.
//       [REVIEW: this is the one I would most expect you to push back on. If
//       you want the fold anyway, it goes into `requireEntitled` with the
//       billing-off early return moved below the cap read.]
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
let operatorId;

before(async () => {
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.MAX_CONCURRENT_SESSIONS = '3'; // above the per-user numbers, so a refusal is the CAP's, not the queue's
  process.env.MAX_CONCURRENT_PER_USER = '2'; // the instance default the override must beat
  process.env.QA_STUB_HOLD_MS = '800'; // hold the first run across the later POSTs
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-override-route-'));

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  operatorId = getOperatorUserId();
  ({ app } = await import('../src/server.js'));
  ({ counts } = await import('../src/runs.js')); // same module instance server.js drives
});

/** @type {() => { active: number, queued: number }} */
let counts;

/** Wait for the engine to go idle, so each test starts from an empty box. */
async function drain(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = counts();
    if (active === 0 && queued === 0) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A per-request key so US-039's agent-key gate passes and we reach the cap.
const post = () =>
  request(app)
    .post('/api/runs')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      goal: 'g',
      start_url: 'https://example.test',
      openai_api_key: 'sk-test-route-key-0123456789012345678901234567',
    });

test('an override written straight to the row takes effect on the next submit, and the 429 names IT', async () => {
  // The operator's write, from a process this server knows nothing about.
  await pool.query('update users set max_concurrent_runs = 1 where id = $1', [operatorId]);

  // First submit: the route's refresh pulls the row in, and this run is
  // admitted — 1 is a cap, not a lockout.
  const first = await post().expect(200);
  assert.ok(first.body.runId);

  // Second submit: refused at 1, not at the instance default of 2. A 200 here
  // is the exact bug — the env number surviving because nothing reloaded.
  const over = await post().expect(429);
  assert.equal(over.body.cap, 1, 'the effective cap, not MAX_CONCURRENT_PER_USER');
  assert.equal(over.body.inFlight, 1);
  assert.match(over.body.error, /limit 1/, 'the message a user reads names their own cap');
  assert.doesNotMatch(over.body.error, /limit 2/);
});

test('clearing the override returns the account to the instance default, also without a restart', async () => {
  await pool.query('update users set max_concurrent_runs = null where id = $1', [operatorId]);
  await drain(); // the previous test's run must be out of the box first

  // Two admitted at the instance default of 2, the third refused naming 2.
  await post().expect(200);
  await post().expect(200);
  const over = await post().expect(429);
  assert.equal(over.body.cap, 2, 'a lifted throttle is actually lifted');
  assert.match(over.body.error, /limit 2/);
});
