// @ts-check
// Failure email (US-012). The provider is a real HTTP server on a loopback
// port, pointed at by RESEND_API_URL, rather than a stubbed fetch — so what
// these tests inspect is the request that would have gone to Resend, headers,
// attachment and all.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const BASE_URL = 'https://qa.example.com';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {any} */
let notify;
let artifactsDir;
let mailServer;
/** @type {any[]} */
let inbox = [];
/** Next send fails with a 5xx, to exercise the error path. */
let failNextSend = false;

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-notify-test-'));

  // The stand-in provider has to be listening before config.js is imported:
  // its URL is env, and env is read once at import time.
  mailServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      inbox.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      if (failNextSend) {
        failNextSend = false;
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end('{"message":"domain not verified"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"msg_test"}');
    });
  });
  await new Promise((resolve) => mailServer.listen(0, '127.0.0.1', resolve));

  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.PUBLIC_BASE_URL = BASE_URL;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <qa@qassist.run>';
  process.env.RESEND_API_URL = `http://127.0.0.1:${mailServer.address().port}/emails`;
  process.env.NOTIFY_EMAILS = 'fallback@example.com';

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  mem.public.registerFunction({
    name: 'nullif',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (a, b) => (a === b ? null : a),
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  notify = await import('../src/notify.js');
  ({ app } = await import('../src/server.js'));
});

after(() => {
  mailServer.close();
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  inbox = [];
  failNextSend = false;
  await pool.query('delete from notifications');
  await pool.query('delete from email_suppressions');
  await pool.query('delete from runs');
  await pool.query('delete from tests');
  await pool.query('delete from projects');
});

/**
 * A project with notification prefs already set.
 * @param {string} name
 * @param {{ notify?: string, emails?: string[] }} [prefs]
 */
async function makeProject(name, prefs = {}) {
  const { notify: mode, emails } = prefs;
  const created = (await request(app).post('/api/projects').set(auth).send({ name }).expect(201))
    .body;
  if (mode || emails) {
    await request(app)
      .put(`/api/projects/${created.id}`)
      .set(auth)
      .send({ notify: mode, notify_emails: emails })
      .expect(200);
  }
  return created;
}

async function makeTest(name, projectId) {
  const res = await request(app)
    .post('/api/tests')
    .set(auth)
    .send({ name, goal: 'log in', start_url: 'https://example.com', project_id: projectId })
    .expect(201);
  return res.body.id;
}

/** A finished run, in the DB and in the shape the engine hands to notify(). */
async function finishedRun(testId, { status = 'failed', report = true } = {}) {
  const id = randomUUID();
  const { rows } = await pool.query('select id from users limit 1');
  await pool.query(
    `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, status,
                       success, final_result, steps_count, finished_at)
     values ($1, $2, $3, 'schedule', 'log in', 'https://example.com', 60, $4, $5, $6, 3, now())`,
    [id, testId, rows[0].id, status, status === 'passed', 'button never appeared']
  );
  const runDir = path.join(artifactsDir, id);
  fs.mkdirSync(runDir, { recursive: true });
  if (report) fs.writeFileSync(path.join(runDir, 'report.pdf'), '%PDF-1.4 fake\n');
  return {
    id,
    test_id: testId,
    goal: 'log in',
    start_url: 'https://example.com',
    status,
    result: {
      success: status === 'passed',
      final_result: 'button never appeared',
      duration_seconds: 12,
      steps: 3,
    },
    events: [],
    startedAt: Date.now() - 12000,
    finishedAt: Date.now(),
    reportStatus: report ? 'ready' : 'none',
  };
}

const statuses = () =>
  pool
    .query('select recipient, status, error from notifications order by recipient')
    .then((r) => r.rows);

// The counterpart lives in api.test.js, whose env has no provider: between
// them both branches of the flag the prefs dialog reads are covered.
test('health reports mail on, since this file configures a provider', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.mail, true);
});

test('a failed run mails the project recipients, with the report attached', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com', 'qa@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);
  const run = await finishedRun(testId);

  const result = await notify.notifyRunFinished(run);
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.equal(inbox.length, 2);

  const mail = inbox[0];
  assert.equal(mail.auth, 'Bearer test-resend-key');
  assert.equal(mail.from, 'QAssist <qa@qassist.run>');
  assert.match(mail.subject, /^\[QAssist\] FAILED — checkout smoke$/);
  assert.match(mail.text, /button never appeared/);
  assert.match(mail.text, /Duration: 12s/);
  // The run's own page (US-030), not just the app root.
  assert.ok(mail.text.includes(`Open this run: ${BASE_URL}/runs/${run.id}`));
  assert.equal(mail.attachments.length, 1);
  assert.equal(
    Buffer.from(mail.attachments[0].content, 'base64').toString(),
    '%PDF-1.4 fake\n',
    'the attachment is the run’s own PDF'
  );
  assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/qa\.example\.com\/api\/notifications\/unsubscribe\?/);

  assert.deepEqual(
    (await statuses()).map((r) => [r.recipient, r.status]),
    [
      ['dev@example.com', 'sent'],
      ['qa@example.com', 'sent'],
    ]
  );
});

test('the default mode stays quiet on a pass, and always does not', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);

  const passed = await notify.notifyRunFinished(await finishedRun(testId, { status: 'passed' }));
  assert.deepEqual(passed, { sent: 0, failed: 0, reason: 'run passed' });
  assert.equal(inbox.length, 0);

  await request(app).put(`/api/projects/${project.id}`).set(auth).send({ notify: 'always' });
  const again = await notify.notifyRunFinished(await finishedRun(testId, { status: 'passed' }));
  assert.equal(again.sent, 1);
  assert.match(inbox[0].subject, /PASSED/);
});

test('an errored or unjudged run counts as a failure worth mailing', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);

  for (const status of ['error', 'completed']) {
    inbox = [];
    await pool.query('delete from notifications');
    const result = await notify.notifyRunFinished(await finishedRun(testId, { status }));
    assert.equal(result.sent, 1, `${status} mails`);
  }
});

test('notify=never sends nothing', async () => {
  const project = await makeProject('checkout', { notify: 'never', emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);
  const result = await notify.notifyRunFinished(await finishedRun(testId));
  assert.deepEqual(result, { sent: 0, failed: 0, reason: 'notify=never' });
  assert.equal(inbox.length, 0);
});

test('an ad-hoc run is never mailed — nobody subscribed to it', async () => {
  const run = await finishedRun(null);
  run.test_id = null;
  const result = await notify.notifyRunFinished(run);
  assert.deepEqual(result, { sent: 0, failed: 0, reason: 'ad-hoc run' });
  assert.equal(inbox.length, 0);
});

test('a test with no project falls back to NOTIFY_EMAILS', async () => {
  const testId = await makeTest('ungrouped smoke', null);
  const result = await notify.notifyRunFinished(await finishedRun(testId));
  assert.equal(result.sent, 1);
  assert.deepEqual(inbox[0].to, ['fallback@example.com']);
});

test('a project with prefs but no recipients also falls back', async () => {
  const project = await makeProject('checkout', { notify: 'always' });
  const testId = await makeTest('checkout smoke', project.id);
  const result = await notify.notifyRunFinished(await finishedRun(testId, { status: 'passed' }));
  assert.equal(result.sent, 1);
  assert.deepEqual(inbox[0].to, ['fallback@example.com']);
});

test('sending twice for one run mails once', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);
  const run = await finishedRun(testId);

  assert.equal((await notify.notifyRunFinished(run)).sent, 1);
  const second = await notify.notifyRunFinished(run);
  assert.deepEqual(second, { sent: 0, failed: 0 });
  assert.equal(inbox.length, 1, 'the delivery row is the claim');
});

test('a provider error is recorded against the delivery, not thrown', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);
  failNextSend = true;

  const result = await notify.notifyRunFinished(await finishedRun(testId));
  assert.deepEqual(result, { sent: 0, failed: 1 });
  const [row] = await statuses();
  assert.equal(row.status, 'error');
  assert.match(row.error, /422/);
});

test('a run without a report mails anyway, saying so', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);
  const result = await notify.notifyRunFinished(await finishedRun(testId, { report: false }));
  assert.equal(result.sent, 1);
  assert.equal(inbox[0].attachments, undefined);
  assert.match(inbox[0].text, /No report was produced/);
});

// --- unsubscribe -----------------------------------------------------------

test('a signed unsubscribe link suppresses the address everywhere', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com', 'qa@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);

  const bad = await request(app)
    .get('/api/notifications/unsubscribe')
    .query({ email: 'dev@example.com', t: 'not-the-signature' })
    .expect(400);
  assert.match(bad.text, /not valid/i);

  await request(app)
    .get('/api/notifications/unsubscribe')
    .query({ email: 'dev@example.com', t: notify.unsubscribeToken('dev@example.com') })
    .expect(200);

  const result = await notify.notifyRunFinished(await finishedRun(testId));
  assert.equal(result.sent, 1);
  assert.deepEqual(inbox[0].to, ['qa@example.com'], 'the unsubscribed address is skipped');

  const listed = (
    await request(app).get('/api/notifications/suppressions').set(auth).expect(200)
  ).body;
  assert.deepEqual(
    listed.suppressions.map((s) => s.email),
    ['dev@example.com']
  );

  await request(app)
    .delete('/api/notifications/suppressions/dev@example.com')
    .set(auth)
    .expect(204);
  const after = await notify.notifyRunFinished(await finishedRun(testId));
  assert.equal(after.sent, 2, 'resubscribing lets mail through again');
});

test('the suppression list needs a token; the unsubscribe link does not', async () => {
  await request(app).get('/api/notifications/suppressions').expect(401);
  await request(app)
    .get('/api/notifications/unsubscribe')
    .query({ email: 'x@example.com', t: 'wrong' })
    .expect(400); // reached the handler without auth, and was refused on merit
});

// --- project prefs ---------------------------------------------------------

test('project prefs round-trip and are validated', async () => {
  const project = await makeProject('checkout');
  assert.equal(project.notify, 'failure', 'the default mode is on-failure');
  assert.deepEqual(project.notify_emails, []);

  const updated = (
    await request(app)
      .put(`/api/projects/${project.id}`)
      .set(auth)
      .send({ notify: 'always', notify_emails: [' Dev@Example.com ', 'dev@example.com'] })
      .expect(200)
  ).body;
  assert.equal(updated.notify, 'always');
  assert.deepEqual(updated.notify_emails, ['dev@example.com'], 'trimmed, lowercased, deduped');

  await request(app)
    .put(`/api/projects/${project.id}`)
    .set(auth)
    .send({ notify: 'sometimes' })
    .expect(400);
  await request(app)
    .put(`/api/projects/${project.id}`)
    .set(auth)
    .send({ notify_emails: ['not-an-email'] })
    .expect(400);

  // A write that mentions neither leaves both alone.
  const renamed = (
    await request(app).put(`/api/projects/${project.id}`).set(auth).send({ name: 'checkout v2' })
  ).body;
  assert.equal(renamed.notify, 'always');
  assert.deepEqual(renamed.notify_emails, ['dev@example.com']);

  const cleared = (
    await request(app).put(`/api/projects/${project.id}`).set(auth).send({ notify_emails: [] })
  ).body;
  assert.deepEqual(cleared.notify_emails, []);
});

// --- the engine hook -------------------------------------------------------

test('a failing run started through the API mails when it finishes', async () => {
  const project = await makeProject('checkout', { emails: ['dev@example.com'] });
  const testId = await makeTest('checkout smoke', project.id);

  process.env.QA_STUB_FAIL = '1';
  try {
    await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);
    const deadline = Date.now() + 5000;
    while (!inbox.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  } finally {
    delete process.env.QA_STUB_FAIL;
  }

  assert.equal(inbox.length, 1, 'the finished run mailed without anyone calling notify()');
  assert.match(inbox[0].subject, /FAILED — checkout smoke/);
  assert.equal(inbox[0].attachments.length, 1, 'and waited for the report to attach it');
});
