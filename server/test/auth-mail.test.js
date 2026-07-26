// @ts-check
// The sign-in mail itself (US-057) — the one send site that had no test at
// all, because auth.test.js pins the crypto and auth-isolation.test.js pins the
// consume, and neither ever looks at what lands in the inbox.
//
// Like notify.test.js, the provider is a real HTTP server on a loopback port
// pointed at by RESEND_API_URL: what these assert is the request Resend would
// have received, not a stubbed fetch.
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
const BASE_URL = 'https://qa.example.com';

/** @type {import('express').Express} */
let app;
let artifactsDir;
let mailServer;
/** @type {any[]} */
let inbox = [];

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-auth-mail-test-'));

  mailServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      inbox.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"msg_test"}');
    });
  });
  await new Promise((resolve) => mailServer.listen(0, '127.0.0.1', resolve));

  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = 'test-session-secret-0123456789';
  process.env.PUBLIC_BASE_URL = BASE_URL;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <qa@qassist.run>';
  process.env.RESEND_API_URL = `http://127.0.0.1:${mailServer.address().port}/emails`;
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
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  ({ app } = await import('../src/server.js'));
});

after(() => {
  mailServer.close();
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

beforeEach(() => {
  inbox = [];
});

/** The link the mail was built around, read back out of the plain-text body. */
const linkIn = (/** @type {string} */ text) =>
  /** @type {string} */ (text.match(/https:\/\/\S+\/api\/auth\/verify\?token=\S+/)?.[0]);

test('requesting a link sends one, in text and in HTML', async () => {
  await request(app)
    .post('/api/auth/request-link')
    .send({ email: 'newcomer@example.com' })
    .expect(200, { ok: true });

  assert.equal(inbox.length, 1);
  const mail = inbox[0];
  assert.deepEqual(mail.to, ['newcomer@example.com']);
  assert.equal(mail.subject, 'Your QAssist sign-in link');

  // The text body is the fallback, and it is unchanged by US-057.
  assert.match(mail.text, /Click to sign in to QAssist:/);
  assert.match(mail.text, /works once and expires in 15 minutes/);
  const link = linkIn(mail.text);
  assert.ok(link, 'the text body carries a verify link');

  assert.ok(mail.html?.length, 'a branded body was sent alongside it');
  assert.match(mail.html, />QAssist</, 'the wordmark');
  assert.match(mail.html, /Sign in to QAssist/);
  assert.ok(
    mail.html.includes(`href="${link.replace(/&/g, '&amp;')}"`),
    'the button points at the same link the text body gives'
  );
  assert.match(
    mail.html,
    /works once and expires in 15 minutes/,
    'and says the same thing about it — a caveat only the text reader sees is a caveat half the recipients miss'
  );
  // A sign-in link is transactional: there is nothing to unsubscribe from.
  assert.ok(!mail.html.includes('Unsubscribe'));
  assert.equal(mail.headers, undefined);
});

test('a malformed address is refused before any mail is sent', async () => {
  await request(app).post('/api/auth/request-link').send({ email: 'not-an-email' }).expect(400);
  assert.equal(inbox.length, 0);
});
