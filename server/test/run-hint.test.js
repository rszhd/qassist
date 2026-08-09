// @ts-check
// US-079 — the ordinary half: telling a live run what to do. The timer pair is
// the correctness-critical part and lives in pause-run.test.js; this covers the
// wiring around it — that the text reaches the child, that it becomes evidence
// rather than vanishing into the pipe, and who is allowed to send one.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-session-secret-0123456789';
const COOKIE = 'qassist_session';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {typeof import('../src/auth.js')} */
let auth;
let artifactsDir;
let releaseDir;

const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-hint-test-'));
  releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-hint-release-'));
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.QA_STUB_RELEASE_DIR = releaseDir;

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

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  auth = await import('../src/auth.js');
  engine = await import('../src/runs.js');
  ({ app } = await import('../src/server.js'));
});

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

const started = [];

async function startRunning(uid, name) {
  const run = /** @type {import('../src/runState.js').Run} */ (
    engine.createRun({
      goal: `release=${name}`,
      start_url: 'https://example.test',
      max_steps: 1,
      user_id: uid,
    })
  );
  started.push(run);
  await pollUntil(() => run.events.some((e) => e.type === 'log' && e.message === READY));
  return run;
}

const release = (name) => fs.writeFileSync(path.join(releaseDir, name), '');

async function pollUntil(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// What the child actually received, which is the half the server cannot see.
// `stub ready` is excluded on purpose: it is the child announcing its own
// startup, not a control line, and counting it would let "the stranger's call
// reached the agent" be satisfied by the agent having booted.
const READY = 'stub ready';
const heardByAgent = (run) =>
  run.events
    .filter((e) => e.type === 'log' && e.message.startsWith('stub ') && e.message !== READY)
    .map((e) => e.message);

afterEach(async () => {
  release('all');
  for (const run of started) engine.stopRun(run);
  await pollUntil(() => {
    const { active, queued } = engine.counts();
    return active === 0 && queued === 0;
  });
  started.length = 0;
  fs.rmSync(path.join(releaseDir, 'all'), { force: true });
});

test('a hint reaches the agent and becomes evidence on the run', async () => {
  const uid = await makeUser('h-basic@example.com');
  const run = await startRunning(uid, 'h-basic');

  await request(app)
    .post(`/api/runs/${run.id}/hint`)
    .set(asUser(uid))
    .send({ text: 'the button is in the account menu' })
    .expect(200);

  await pollUntil(() => heardByAgent(run).includes('stub hint: the button is in the account menu'));

  // Durable on the run, so a viewer attaching later is replayed it.
  const hint = run.events.find((e) => e.type === 'hint');
  assert.equal(hint.text, 'the button is in the account menu');
  assert.equal(typeof hint.elapsed, 'number');

  // And on the read path the run page uses.
  const res = await request(app).get(`/api/runs/${run.id}/steps`).set(asUser(uid)).expect(200);
  assert.deepEqual(
    res.body.hints.map((h) => h.text),
    ['the button is in the account menu']
  );
});

test('a hint does not need a pause first', async () => {
  const uid = await makeUser('h-nopause@example.com');
  const run = await startRunning(uid, 'h-nopause');
  assert.equal(run.paused, undefined);
  assert.equal(engine.hintRun(run, 'try the search box'), true);
  await pollUntil(() => heardByAgent(run).includes('stub hint: try the search box'));
  // Still running, and still not paused — a hint is not a pause.
  assert.equal(run.status, 'running');
  assert.ok(!run.paused);
});

test('a hint sent to a paused run releases it, so the user types once', async () => {
  const uid = await makeUser('h-resume@example.com');
  const run = await startRunning(uid, 'h-resume');
  engine.pauseRun(run);
  assert.equal(run.paused, true);

  const res = await request(app)
    .post(`/api/runs/${run.id}/hint`)
    .set(asUser(uid))
    .send({ text: 'scroll down first' })
    .expect(200);

  assert.equal(res.body.paused, false);
  assert.equal(run.paused, false);
  // The text lands BEFORE the release, or the agent carries on without it.
  await pollUntil(() => heardByAgent(run).includes('stub resume'));
  const heard = heardByAgent(run);
  assert.ok(heard.indexOf('stub hint: scroll down first') < heard.indexOf('stub resume'));
});

test('the hint and the assisted claim reach the report data', async () => {
  const uid = await makeUser('h-report@example.com');
  const run = await startRunning(uid, 'h-report');
  engine.hintRun(run, 'the confirm dialog is behind the overlay');
  release('h-report');
  await pollUntil(() => engine.TERMINAL.has(run.status));
  await pollUntil(() => fs.existsSync(path.join(artifactsDir, run.id, 'report_data.json')));

  const data = JSON.parse(
    fs.readFileSync(path.join(artifactsDir, run.id, 'report_data.json'), 'utf8')
  );
  // The claim the reader needs is `assisted`; the list is the detail under it.
  assert.equal(data.assisted, true);
  assert.deepEqual(
    data.hints.map((h) => h.text),
    ['the confirm dialog is behind the overlay']
  );
});

test('an ordinary run is not marked assisted', async () => {
  const uid = await makeUser('h-clean@example.com');
  const run = await startRunning(uid, 'h-clean');
  release('h-clean');
  await pollUntil(() => engine.TERMINAL.has(run.status));
  await pollUntil(() => fs.existsSync(path.join(artifactsDir, run.id, 'report_data.json')));
  const data = JSON.parse(
    fs.readFileSync(path.join(artifactsDir, run.id, 'report_data.json'), 'utf8')
  );
  assert.equal(data.assisted, false);
  assert.deepEqual(data.hints, []);
});

test('an empty or oversized hint is refused before it reaches the agent', async () => {
  const uid = await makeUser('h-validate@example.com');
  const run = await startRunning(uid, 'h-validate');
  await request(app).post(`/api/runs/${run.id}/hint`).set(asUser(uid)).send({}).expect(400);
  await request(app)
    .post(`/api/runs/${run.id}/hint`)
    .set(asUser(uid))
    .send({ text: '   ' })
    .expect(400);
  await request(app)
    .post(`/api/runs/${run.id}/hint`)
    .set(asUser(uid))
    .send({ text: 'x'.repeat(1001) })
    .expect(400);
  assert.equal(heardByAgent(run).some((m) => m.startsWith('stub hint')), false);
});

test('one user cannot pause, resume or hint another user\'s run', async () => {
  const a = await makeUser('h-owner@example.com');
  const b = await makeUser('h-stranger@example.com');
  const run = await startRunning(a, 'h-owner');

  // 404, not 403: the refusal must not confirm the run exists.
  for (const [route, body] of [
    ['pause', {}],
    ['resume', {}],
    ['hint', { text: 'do the thing' }],
  ]) {
    await request(app).post(`/api/runs/${run.id}/${route}`).set(asUser(b)).send(body).expect(404);
  }
  // The half that matters — the run is untouched.
  assert.ok(!run.paused);
  assert.equal(heardByAgent(run).length, 0);

  // And the owner can, over the same routes.
  await request(app).post(`/api/runs/${run.id}/pause`).set(asUser(a)).expect(200);
  await request(app).post(`/api/runs/${run.id}/resume`).set(asUser(a)).expect(200);
});

test('an unauthenticated pause, resume or hint is refused', async () => {
  const uid = await makeUser('h-anon@example.com');
  const run = await startRunning(uid, 'h-anon');
  for (const route of ['pause', 'resume', 'hint']) {
    await request(app).post(`/api/runs/${run.id}/${route}`).send({ text: 'x' }).expect(401);
  }
  assert.ok(!run.paused);
});

test('resuming a run that is not paused is a 409, not a silent success', async () => {
  const uid = await makeUser('h-notpaused@example.com');
  const run = await startRunning(uid, 'h-notpaused');
  await request(app).post(`/api/runs/${run.id}/resume`).set(asUser(uid)).expect(409);
  await request(app).post(`/api/runs/${run.id}/pause`).set(asUser(uid)).expect(200);
  await request(app).post(`/api/runs/${run.id}/pause`).set(asUser(uid)).expect(409);
});

test('an unknown run id is a 404 on all three routes', async () => {
  const uid = await makeUser('h-unknown@example.com');
  for (const route of ['pause', 'resume', 'hint']) {
    await request(app)
      .post(`/api/runs/${randomUUID()}/${route}`)
      .set(asUser(uid))
      .send({ text: 'x' })
      .expect(404);
  }
});
