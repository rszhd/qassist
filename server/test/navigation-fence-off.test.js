// @ts-check
// US-042 — assertion-first spec, part 3: THE ESCAPE HATCH, in its own process.
//
// `QA_BLOCK_PRIVATE_NETWORKS=0` restores today's behaviour exactly. This is
// AC #4, and it is not a nicety: testing `http://localhost:3000` is the single
// most common thing a self-hoster does with this product, and US-042 would
// break every one of them if the floor could not be turned off. The claim shape
// is billing-off.test.js's and concurrency-off.test.js's — config.js is read at
// import time, so "the switch is off" needs its own process or it is only ever
// asserting the other file's environment.
//
// What "exactly" means here, and why the assertions are shaped as they are: a
// half-open hatch is the failure mode. An implementation that turns the IP
// block off but leaves the hostname denylist standing still refuses
// `http://localhost:3000` — and the operator, having set the documented flag,
// would have no idea why. So the flag governs BOTH halves of the floor, and
// this file asserts the denylist is empty as well as the literals allowed.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions specific to this file:
//
//   D16  ONE flag governs the whole floor: `QA_BLOCK_PRIVATE_NETWORKS=0` clears
//        the IP block AND the default hostname denylist. Two flags would mean a
//        self-hoster has to discover the second one after the first didn't work.
//        `QA_DENIED_HOSTS` remains separately settable for an operator who wants
//        a denylist and no IP block, or a longer list than ours — but the
//        DEFAULT list is part of what the floor means, so turning the floor off
//        turns it off too.
//        [REVIEW: this is the decision I am least sure of. The alternative —
//        keeping `db` denied even with the floor off — protects a self-hoster
//        from their own compose network, but it also means the documented
//        escape hatch does not fully escape.]
//
//   D17  Off is asserted as "byte-for-byte", meaning the run actually STARTS and
//        reaches the agent, not merely that no 400 came back. A fence that
//        refused later, in the agent, would pass a status-code-only assertion.
//
//   D18  The agent env still carries the variables when the floor is off — it
//        carries them turned OFF (`QA_BLOCK_PRIVATE_NETWORKS=0`, empty denylist).
//        Unsetting them instead would make the child's default the library's
//        default, and browser-use's default for `block_ip_addresses` is False,
//        which happens to be right — but "happens to be right" is how a fence
//        stops being one. The child is told, always.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';
import { RUN_PATHS, seedRunTargets } from './helpers/run-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** The self-hoster's actual use case, spelled out. */
const LOCALHOST = 'http://localhost:3000/';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {any} */
let fx;
let operatorId = '';
let artifactsDir = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-nav-off-'));
  // The whole subject of the file.
  process.env.QA_BLOCK_PRIVATE_NETWORKS = '0';
  delete process.env.QA_DENIED_HOSTS;
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_MODE;
  delete process.env.MAX_CONCURRENT_PER_USER;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
  ({ counts } = await import('../src/runs.js'));
  ({ app } = await import('../src/server.js'));

  fx = await seedRunTargets(pool, operatorId);
});

async function drain(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = counts();
    if (!active && !queued) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(() => drain());

// --- O1: the documented reason the switch exists (AC #4) ---------------------

test('http://localhost:3000 runs, which is why the switch exists', async () => {
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'log in', start_url: LOCALHOST })
    .expect(200);
  assert.ok(res.body.runId, 'the self-hoster testing their own dev server is the default use case');

  // D17: it really ran — the stub agent writes a recording into the run dir, so
  // a directory that exists is proof the child was spawned and not merely that
  // no 400 came back.
  await drain();
  const dir = path.join(artifactsDir, res.body.runId);
  assert.ok(fs.existsSync(dir), 'the run reached the agent, not just the router');
});

// --- O2: every address the floor blocks is allowed again ---------------------

for (const [label, url] of /** @type {[string,string][]} */ ([
  ['loopback literal', 'http://127.0.0.1:3000/'],
  ['private range', 'http://192.168.1.50:8080/'],
  ['IPv6 loopback', 'http://[::1]:3000/'],
  ['decimal', 'http://2852039166/'],
  ['hex', 'http://0x7f.1/'],
  ['link-local', 'http://169.254.169.254/'],
  ['a compose service by name', 'http://db:5432/'],
  ['localhost, uppercased', 'http://LOCALHOST:3000/'],
])) {
  test(`floor off — ${label} is allowed again`, async () => {
    const res = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'probe', start_url: url })
      .expect(200);
    assert.ok(res.body.runId, `${url} must behave exactly as it did before US-042`);
    await drain();
  });
}

test('one flag clears both halves of the floor (D16)', async () => {
  // The half-open hatch: IP block off, denylist still standing, and the operator
  // who set the documented flag still cannot test their own machine.
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'probe', start_url: 'http://localhost:8080/' })
    .expect(200);
  assert.ok(res.body.runId, 'QA_BLOCK_PRIVATE_NETWORKS=0 must not leave a denylist behind');
  await drain();
});

// --- O3: every start path, not just the ad-hoc one ---------------------------

for (const [name, make] of RUN_PATHS) {
  test(`${name} — starts against localhost with the floor off`, async () => {
    await pool.query('update tests set start_url = $1 where user_id = $2', [LOCALHOST, operatorId]);
    const { url, body } = make(fx);
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ ...(body || {}), start_url: LOCALHOST })
      .expect(200);
    const started = res.body.runId || (res.body.runs || []).some((m) => m.runId);
    assert.ok(started, `${name}: the escape hatch must reach every path the fence does`);
    await drain();
  });
}

// --- O4: what the child is told (D18) ----------------------------------------

test('the agent is told the floor is off, rather than told nothing', async () => {
  const envFile = path.join(os.tmpdir(), `qassist-nav-off-env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = envFile;
  try {
    await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'probe', start_url: LOCALHOST })
      .expect(200);
    await drain();
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.QA_BLOCK_PRIVATE_NETWORKS, '0', 'told, not left to the library default (D18)');
    assert.equal(env.QA_DENIED_HOSTS, '', 'and the denylist really is empty, not merely unsent');
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
  }
});

// --- O5: the allowlist is not part of the floor and survives it ---------------

test('a project allowlist still applies with the floor off — it is a guard rail', async () => {
  await pool.query(
    `update projects set allowed_domains = array['localhost']::text[] where user_id = $1`,
    [operatorId]
  );
  await pool.query('update tests set start_url = $1 where user_id = $2', [
    'https://example.test/',
    operatorId,
  ]);
  const res = await request(app).post(`/api/projects/${fx.projectSlug}/run`).set(auth).expect(200);
  const blocked = (res.body.runs || []).find((m) => m.reason);
  assert.ok(blocked, 'a team that set an allowlist keeps it whatever the instance floor is doing');
  assert.equal(blocked.reason, 'not_in_allowed_domains');

  // And `localhost` is a legal allowlist entry here, which it is not on an
  // instance with the floor up (navigation-policy.test.js's D8 half).
  await pool.query('update tests set start_url = $1 where user_id = $2', [LOCALHOST, operatorId]);
  const ok = await request(app).post(`/api/projects/${fx.projectSlug}/run`).set(auth).expect(200);
  assert.ok(ok.body.runs[0].runId);
  await drain();
});
