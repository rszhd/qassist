// @ts-check
// US-021 — assertion-first spec for per-user API keys (correctness-critical:
// a minted credential, same class as the session cookie and tenant isolation).
// Runs the real migrations on pg-mem and drives the real app, like
// auth-isolation.test.js.
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
// The properties they defend:
//
//   K1 — a minted key's plaintext is shown exactly once, at creation. It is
//        never persisted and never returned by any later read (list). Only its
//        sha256 hash is stored.
//   K2 — a freshly minted key authenticates its owner as a bearer, and a
//        revoked key stops authenticating (the consume path already checks
//        `revoked_at is null`).
//   K3 — keys are tenant-scoped: a user lists and revokes only their own keys.
//        Acting on another user's key id is a 404 (existence is not revealed).
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
const SECRET = 'test-session-secret-0123456789';
const COOKIE = 'qassist_session';

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {typeof import('../src/auth.js')} */
let auth;
let artifactsDir;

const asUser = (/** @type {string} */ uid) => ({ Cookie: `${COOKIE}=${auth.signSession(uid)}` });

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-keys-test-'));
  process.env.AUTH_ENABLED = '1';
  process.env.SESSION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.MAIL_FROM = 'QAssist <test@qassist.run>';
  process.env.WORKER_API_TOKEN = 'legacy-shared-token';
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
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
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  auth = await import('../src/auth.js');
  ({ app } = await import('../src/server.js'));
});

async function makeUser(email) {
  const { rows } = await pool.query('insert into users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

// --- K1: plaintext shown once, only the hash stored ---

test('mintApiKey returns a prefixed token whose stored hash is sha256 of the whole token', async () => {
  const { sha256 } = await import('../src/db.js');
  const { token, hash } = auth.mintApiKey();
  assert.ok(token.startsWith(auth.API_KEY_PREFIX), 'token carries the recognizable prefix');
  assert.equal(hash, sha256(token), 'the hash covers the entire token, prefix included');
  const other = auth.mintApiKey();
  assert.notEqual(other.token, token, 'each mint is unique');
});

test('creating a key returns the plaintext once; the list never returns it, and only the hash is stored', async () => {
  const u = await makeUser('k1@example.com');
  const created = await request(app).post('/api/keys').set(asUser(u)).send({ label: 'ci' }).expect(201);
  const token = created.body.token;
  assert.ok(token && token.startsWith(auth.API_KEY_PREFIX), 'the raw token comes back on create');

  const listed = await request(app).get('/api/keys').set(asUser(u)).expect(200);
  const row = listed.body.keys.find((/** @type {any} */ k) => k.id === created.body.id);
  assert.ok(row, 'the key appears in the list');
  assert.equal(row.token, undefined, 'the list never carries the plaintext token');
  assert.equal(row.token_hash, undefined, 'nor the hash');
  assert.equal(row.label, 'ci');

  const { sha256 } = await import('../src/db.js');
  const stored = await pool.query('select token_hash from api_keys where id = $1', [created.body.id]);
  assert.equal(stored.rows[0].token_hash, sha256(token), 'the DB stores the hash, not the plaintext');
});

// --- K2: a minted key authenticates; a revoked one does not ---

test('a minted key authenticates its owner as a bearer', async () => {
  const u = await makeUser('k2@example.com');
  const { token } = (await request(app).post('/api/keys').set(asUser(u)).send({}).expect(201)).body;
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal(me.body.id, u);
});

test('a revoked key stops authenticating', async () => {
  const u = await makeUser('k2b@example.com');
  const created = (await request(app).post('/api/keys').set(asUser(u)).send({}).expect(201)).body;
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${created.token}`).expect(200);

  await request(app).post(`/api/keys/${created.id}/revoke`).set(asUser(u)).expect(204);
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${created.token}`).expect(401);
});

// --- K3: tenant scoping ---

test('a user lists only their own keys', async () => {
  const a = await makeUser('k3a@example.com');
  const b = await makeUser('k3b@example.com');
  const aKey = (await request(app).post('/api/keys').set(asUser(a)).send({ label: 'a' }).expect(201)).body;
  await request(app).post('/api/keys').set(asUser(b)).send({ label: 'b' }).expect(201);

  const aList = (await request(app).get('/api/keys').set(asUser(a)).expect(200)).body.keys;
  assert.ok(aList.some((/** @type {any} */ k) => k.id === aKey.id));
  assert.ok(aList.every((/** @type {any} */ k) => k.label !== 'b'), "A never sees B's key");
});

test("revoking another user's key is a 404 and leaves it working", async () => {
  const a = await makeUser('k3c@example.com');
  const b = await makeUser('k3d@example.com');
  const bKey = (await request(app).post('/api/keys').set(asUser(b)).send({}).expect(201)).body;

  await request(app).post(`/api/keys/${bKey.id}/revoke`).set(asUser(a)).expect(404);
  // B's key still authenticates — A's attempt did nothing.
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${bKey.token}`).expect(200);
});

test('revoking an already-revoked or unknown key is a 404', async () => {
  const u = await makeUser('k3e@example.com');
  const created = (await request(app).post('/api/keys').set(asUser(u)).send({}).expect(201)).body;
  await request(app).post(`/api/keys/${created.id}/revoke`).set(asUser(u)).expect(204);
  await request(app).post(`/api/keys/${created.id}/revoke`).set(asUser(u)).expect(404);
  await request(app).post(`/api/keys/${randomUUID()}/revoke`).set(asUser(u)).expect(404);
});
