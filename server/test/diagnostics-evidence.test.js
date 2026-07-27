// @ts-check
// US-044: the browser's own account of why a run failed — failed requests,
// console errors, uncaught exceptions — reaching the two places a person looks.
//
// The agent owns capture, capping, deduplication and redaction (proven in
// `agent/tests/test_diagnostics.py`, assertion-first). What this file owns is
// everything after stdout: that the relay carries the events, that both read
// paths return them in the same shape, that the report file is what the PDF
// renderer will find them in, and that the opt-in HAR is genuinely opt-in.
//
// The one non-obvious assertion is `dropped`. Each event carries the agent's
// run total *so far*, not a delta, so the server must take the maximum. Summing
// them multiplies the number by the step count and the report then claims a
// clean page dropped 40 findings, which is the same failure as losing them.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** @type {import('express').Express} */
let app;
let artifactsDir;
/** @type {any} */
let pool;
let operatorId = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-diag-test-'));
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
  ({ app } = await import('../src/server.js'));
});

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start a run whose stub emits diagnostics, and wait for its report file. */
async function runWithEvidence(body = {}) {
  process.env.QA_STUB_DIAGNOSTICS = '1';
  try {
    const res = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'buy a thing', start_url: 'https://shop.example.test/', ...body })
      .expect(200);
    const runId = res.body.runId;
    const dataPath = path.join(artifactsDir, runId, 'report_data.json');
    await pollUntil(() => fs.existsSync(dataPath));
    return { runId, data: JSON.parse(fs.readFileSync(dataPath, 'utf8')) };
  } finally {
    delete process.env.QA_STUB_DIAGNOSTICS;
  }
}

test('the report file carries the evidence, flat and step-stamped', async () => {
  const { data } = await runWithEvidence();

  // Flat rather than nested inside `steps`: a page's own load errors arrive
  // before the first step and would have no step object to hang off.
  assert.equal(data.diagnostics.length, 3);
  const failed = data.diagnostics.find((d) => d.kind === 'request');
  assert.equal(failed.status, 500);
  assert.equal(failed.url, 'https://api.example.com/cart');
  assert.equal(failed.step, 1, 'attributed to the step it happened during');
  assert.equal(failed.count, 2, 'and deduplicated with a count, by the agent');

  // Every finding names its step, which is what both renderers group on.
  assert.deepEqual(
    data.diagnostics.map((d) => d.step),
    [1, 1, 2]
  );
  // The exception landed on the later step and kept it — attribution is not
  // collapsed to "sometime during this run".
  assert.equal(data.diagnostics.find((d) => d.kind === 'exception').step, 2);
});

test('dropped is the agent run total, not the sum of the events', async () => {
  // The stub emits dropped: 3 then dropped: 5 — a running total, so 5 is the
  // answer. Summing gives 8 and the report then overstates what it lost.
  const { data } = await runWithEvidence();
  assert.equal(data.diagnostics_dropped, 5);
});

test('a run with nothing to report says so with an empty list, not a missing key', async () => {
  // The normal case. The renderers branch on length, so the key has to exist —
  // and its absence would make "no diagnostics" indistinguishable from an old
  // report file written before this story.
  const res = await request(app)
    .post('/api/runs')
    .set(auth)
    .send({ goal: 'quiet run', start_url: 'https://shop.example.test/' })
    .expect(200);
  const dataPath = path.join(artifactsDir, res.body.runId, 'report_data.json');
  await pollUntil(() => fs.existsSync(dataPath));
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  assert.deepEqual(data.diagnostics, []);
  assert.equal(data.diagnostics_dropped, 0);
});

test('both read paths return the same evidence', async () => {
  const { runId, data } = await runWithEvidence();

  // Live: the run is still in the relay (RUN_TTL keeps it an hour), so this is
  // the in-memory buffer.
  const live = await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200);
  assert.deepEqual(live.body.diagnostics, data.diagnostics);
  assert.equal(live.body.diagnostics_dropped, data.diagnostics_dropped);

  // Off disk: the same shape from report_data.json, which is how a restarted
  // server and a run that has aged out of the relay answer. Proven on a row of
  // its own rather than by evicting, the way api.test.js reaches this branch.
  const oldRunId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status)
     values ($1, $2, 'g', 'u', 1, 'failed')`,
    [oldRunId, operatorId]
  );
  fs.mkdirSync(path.join(artifactsDir, oldRunId), { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, oldRunId, 'report_data.json'),
    JSON.stringify({ runId: oldRunId, steps: data.steps, ...pick(data) })
  );
  const stored = await request(app).get(`/api/runs/${oldRunId}/steps`).set(auth).expect(200);
  assert.deepEqual(stored.body.diagnostics, data.diagnostics);
  assert.equal(stored.body.diagnostics_dropped, data.diagnostics_dropped);
});

test('a report file written before this story reads as no evidence, not a crash', async () => {
  // Every run in an existing installation's runs/ predates the two keys. The
  // read path has to answer for those without throwing.
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status)
     values ($1, $2, 'g', 'u', 1, 'passed')`,
    [runId, operatorId]
  );
  fs.mkdirSync(path.join(artifactsDir, runId), { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, runId, 'report_data.json'),
    JSON.stringify({ runId, steps: [] })
  );
  const res = await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200);
  assert.deepEqual(res.body.diagnostics, []);
  assert.equal(res.body.diagnostics_dropped, 0);
});

function pick(data) {
  return { diagnostics: data.diagnostics, diagnostics_dropped: data.diagnostics_dropped };
}

// --- the opt-in archive ----------------------------------------------------

test('HAR capture is off unless the run asks for it', async () => {
  // The flag only exists in the child's environment, and the child is what
  // writes the file — so which flag it was handed is the whole assertion. An
  // agent spawned without it archives nothing while a server-side check on
  // `run.har` would stay green either way.
  const envFile = path.join(os.tmpdir(), `qassist-har-env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = envFile;
  try {
    const off = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'no archive', start_url: 'https://shop.example.test/' })
      .expect(200);
    await pollUntil(() => fs.existsSync(envFile));
    assert.equal(
      JSON.parse(fs.readFileSync(envFile, 'utf8')).QA_HAR,
      '0',
      'sent as 0, never unset — an absent variable would inherit the server process'
    );
    // Nothing on disk, and the download route says so.
    await pollUntil(async () => {
      const res = await request(app).get(`/api/runs/${off.body.runId}/network.har`).set(auth);
      return res.status === 404;
    });

    fs.rmSync(envFile, { force: true });
    const on = await request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'archive it', start_url: 'https://shop.example.test/', har: true })
      .expect(200);
    await pollUntil(() => fs.existsSync(envFile));
    assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8')).QA_HAR, '1');

    const har = await pollUntil(async () => {
      const res = await request(app).get(`/api/runs/${on.body.runId}/network.har`).set(auth);
      return res.status === 200 ? res : null;
    });
    assert.match(har.headers['content-disposition'], /attachment; filename=".*\.har"/);
    // Served as application/json, so supertest has already parsed it.
    assert.equal(har.body.log.version, '1.2');
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
  }
});

test('the HAR is scoped to its owner like every other artifact', async () => {
  // Served by runId, which is unguessable but is not a permission (US-021).
  const strangersRun = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status)
     values ($1, null, 'g', 'u', 1, 'passed')`,
    [strangersRun]
  );
  fs.mkdirSync(path.join(artifactsDir, strangersRun), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, strangersRun, 'network.har'), '{"log":{}}');

  await request(app).get(`/api/runs/${strangersRun}/network.har`).expect(401);
  await request(app).get(`/api/runs/${strangersRun}/network.har`).set(auth).expect(404);
  // Not a uuid => never reaches the filesystem.
  await request(app).get('/api/runs/..%2F..%2Fetc/network.har').set(auth).expect(404);
});

test('retention takes the HAR with the rest of the run directory', async () => {
  // The archive is large and is the one artifact `scrub` never saw, so it must
  // not outlive the run's other artifacts. It is inside runs/<id>/, which is
  // what makes this true — asserted rather than assumed, because "it happens to
  // be in the swept directory" is exactly the kind of thing a later layout
  // change breaks silently.
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, goal, start_url, max_steps, status)
     values ($1, $2, 'g', 'u', 1, 'passed')`,
    [runId, operatorId]
  );
  const dir = path.join(artifactsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'network.har'), '{"log":{}}');

  const { sweepArtifacts } = await import('../src/retention.js');
  // A year out, so the directory is comfortably past ARTIFACT_RETENTION_DAYS.
  await sweepArtifacts(Date.now() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(path.join(dir, 'network.har')), false);
  await request(app).get(`/api/runs/${runId}/network.har`).set(auth).expect(404);
});
