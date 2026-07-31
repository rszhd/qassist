// @ts-check
// US-063 — assertion-first spec for the capture token: extends the "Saved
// browser sessions" correctness-critical row (backlog/correctness-critical.md)
// rather than adding a new one, per the story's own Correctness-critical
// section.
//
// session-blob.test.js / session-containment.test.js pin what a blob may be
// and where its plaintext may go once it is in Postgres. This file pins the
// new door in front of that: the capture token a browser extension trades for
// permission to fill exactly one session, exactly once, and nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions:
//
//   E1  A CAPTURE TOKEN IS NOT AN API KEY. `api_keys` is full-privilege for the
//       user who holds it — every endpoint that user can reach. A capture
//       token must open exactly one door: `POST /api/capture`, once. It is
//       checked nowhere `checkToken` is mounted and `userFromRequest` never
//       recognizes it, so it must 401 against every other authenticated route.
//
//   E2  SINGLE-USE, CLAIMED ATOMICALLY, same shape as auth.js's login tokens: a
//       second POST with the same token must fail exactly as the first success
//       would if replayed.
//
//   E3  A MALFORMED POST DOES NOT BURN THE TOKEN. The shape check
//       (normalizeStorageState) runs before the token is consumed, so a bug in
//       the extension or a bad paste is retryable with the same setup code
//       rather than forcing a fresh one to be minted.
//
//   E4  A CAPTURE THAT FAILS AFTER THE TOKEN IS SPENT LEAVES THE SESSION'S
//       STORED BYTES BYTE-IDENTICAL — mirrors refreshCapturedSession's
//       already-tested rule for a failing login run. There is currently no way
//       to reach "token valid, blob invalid" (the shape check runs first), but
//       the property is asserted directly against captureFromExtension so it
//       stays true if that ordering ever changes.
//
//   E5  THE RESPONSE NEVER ECHOES THE BODY. Success is 204 with nothing in it;
//       failure is a plain error string. Canary-over-the-whole-body, as
//       session-containment.test.js's D9 tests already do for the read routes.
//
//   E6  THE ROUTE ANSWERS CORS, because its only caller never has a choice
//       about being cross-origin. The extension's popup is `chrome-extension://
//       <id>`, an origin this server can never enumerate in advance, and it
//       calls this route with a plain `fetch()` — not a content script, so it
//       gets no CSP exemption, and it deliberately holds no host permission for
//       the QAssist origin (see extension/popup.js), so it gets no CORS
//       exemption either. Missing this shipped once as a live "Failed to
//       fetch" against a real dev server before this test existed; `*` is the
//       right answer because the capture token is the actual security
//       boundary, not the origin header.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { byteaPool, registerDecode, seedStoredKey } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

const CANARY = 'CANARY-CAPTURE-VALUE-9f2c71';
const BLOB = {
  cookies: [
    { name: 'session', value: CANARY, domain: '.example.test', path: '/', expires: -1 },
  ],
  origins: [{ origin: 'https://example.test', localStorage: [{ name: 'jwt', value: CANARY }] }],
};

/** @type {any} */ let app;
/** @type {any} */ let pool;
let sessionsDir = '';
let projectId = '';

before(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-capture-token-test-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-capture-runs-'));
  process.env.SESSIONS_DIR = sessionsDir;

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
  registerDecode(mem);
  // captureFromExtension (browserSession.js) writes ciphertext as a `bytea`
  // parameter, which plain pg-mem mangles (BUG-007) — same reason
  // session-containment.test.js needs this pool.
  pool = byteaPool(mem);

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  const operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
  ({ app } = await import('../src/server.js'));

  projectId = (await request(app).post('/api/projects').set(auth).send({ name: 'shop' }).expect(201))
    .body.id;
});

after(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

/** A session created via the extension-capture creation path, empty. */
async function seedEmptySession(name = 'sso') {
  const { body } = await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name, capture_method: 'extension' })
    .expect(201);
  return body;
}

async function mintToken(sessionId) {
  const { body } = await request(app)
    .post(`/api/projects/${projectId}/sessions/${sessionId}/capture-token`)
    .set(auth)
    .expect(201);
  return body;
}

// ── the third fill path (createSession's dead-end guard) ───────────────────

test('a session with no paste and no login test is refused, unless it declares extension capture', async () => {
  await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name: 'dead end' })
    .expect(400);

  const { body } = await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name: 'via extension', capture_method: 'extension' })
    .expect(201);
  assert.equal(body.captured_at, null);
});

// ── E1: not a full-privilege key ────────────────────────────────────────────

test('a capture token authenticates nothing but POST /api/capture', async () => {
  const session = await seedEmptySession('scope probe');
  const { token } = await mintToken(session.id);
  const bearer = { Authorization: `Bearer ${token}` };

  await request(app).get(`/api/projects/${projectId}/sessions`).set(bearer).expect(401);
  await request(app).get('/api/projects').set(bearer).expect(401);
  await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(bearer)
    .send({ name: 'nope', capture_method: 'extension' })
    .expect(401);
});

// ── E2: single-use ───────────────────────────────────────────────────────────

test('a capture token is consumed by its first use and refused on a second', async () => {
  const session = await seedEmptySession('single use');
  const { token } = await mintToken(session.id);
  const bearer = { Authorization: `Bearer ${token}` };

  await request(app).post('/api/capture').set(bearer).send({ storage_state: BLOB }).expect(204);
  const replay = await request(app)
    .post('/api/capture')
    .set(bearer)
    .send({ storage_state: BLOB })
    .expect(401);
  assert.equal(JSON.stringify(replay.body).includes(CANARY), false);
});

test('a capture token is refused once expired', async () => {
  const session = await seedEmptySession('expired');
  const { mintCaptureToken } = await import('../src/sessionCapture.js');
  const { token } = await mintCaptureToken(session.id, null, { now: Date.now() - 20 * 60 * 1000 });
  await request(app)
    .post('/api/capture')
    .set({ Authorization: `Bearer ${token}` })
    .send({ storage_state: BLOB })
    .expect(401);
});

test('an unknown or missing token is refused, not treated as anonymous', async () => {
  await request(app)
    .post('/api/capture')
    .send({ storage_state: BLOB })
    .expect(401);
  await request(app)
    .post('/api/capture')
    .set({ Authorization: 'Bearer qsc_not-a-real-token' })
    .send({ storage_state: BLOB })
    .expect(401);
});

// ── E3: a bad blob does not burn the token ──────────────────────────────────

test('a malformed post is refused without spending the token — retry with the same one works', async () => {
  const session = await seedEmptySession('retryable');
  const { token } = await mintToken(session.id);
  const bearer = { Authorization: `Bearer ${token}` };

  await request(app)
    .post('/api/capture')
    .set(bearer)
    .send({ storage_state: { cookies: 'not an array' } })
    .expect(400);
  // Same token, now with a real blob — still good, because the 400 above never
  // consumed it.
  await request(app).post('/api/capture').set(bearer).send({ storage_state: BLOB }).expect(204);
});

// ── E4: a failure after the token is spent leaves stored bytes alone ───────

test('captureFromExtension never writes on an invalid blob', async () => {
  const { encryptSecret } = await import('../src/crypto.js');
  const { captureFromExtension } = await import('../src/browserSession.js');
  const original = encryptSecret(JSON.stringify(BLOB));
  const hex = original.toString('hex');
  const { rows } = await pool.query(
    `insert into browser_sessions
       (project_id, name, name_key, storage_state_ciphertext, cookie_count, origin_count, source, captured_at)
     values ($1, $2, $3, decode('${hex}', 'hex'), 1, 1, 'pasted', now())
     returning id`,
    [projectId, 'must not be clobbered', 'must not be clobbered']
  );
  const sessionId = rows[0].id;

  const result = await captureFromExtension(sessionId, { cookies: 'not an array' });
  assert.ok('error' in result);

  const after = (
    await pool.query('select storage_state_ciphertext, source from browser_sessions where id = $1', [
      sessionId,
    ])
  ).rows[0];
  assert.equal(Buffer.compare(Buffer.from(after.storage_state_ciphertext), original), 0);
  assert.equal(after.source, 'pasted');
});

// ── E5: nothing echoes the blob ─────────────────────────────────────────────

test('a successful capture answers 204 with an empty body, and the session becomes describable', async () => {
  const session = await seedEmptySession('describable after capture');
  const { token } = await mintToken(session.id);

  const res = await request(app)
    .post('/api/capture')
    .set({ Authorization: `Bearer ${token}` })
    .send({ storage_state: BLOB })
    .expect(204);
  assert.equal(res.text, '');

  const { body } = await request(app)
    .get(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .expect(200);
  const row = body.sessions.find((s) => s.id === session.id);
  assert.equal(row.source, 'extension');
  assert.equal(row.cookie_count, 1);
  assert.equal(row.origin_count, 1);
  assert.ok(row.captured_at);
  assert.equal(JSON.stringify(body).includes(CANARY), false);
});

// ── E6: the extension's fetch() is cross-origin and needs CORS answered ────

test('a preflight for /api/capture is answered with CORS headers, not Express\'s bare default', async () => {
  const res = await request(app)
    .options('/api/capture')
    .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type')
    .expect(204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.match(res.headers['access-control-allow-headers'], /Authorization/i);
});

test('the real POST also carries Access-Control-Allow-Origin, not just the preflight', async () => {
  const session = await seedEmptySession('cors on the real response');
  const { token } = await mintToken(session.id);
  const res = await request(app)
    .post('/api/capture')
    .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
    .set('Authorization', `Bearer ${token}`)
    .send({ storage_state: BLOB })
    .expect(204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('the capture-token mint route never touches storage_state_ciphertext, and 404s on someone else\'s project', async () => {
  const session = await seedEmptySession('mint scope');
  const otherProject = (
    await request(app).post('/api/projects').set(auth).send({ name: 'other' }).expect(201)
  ).body.id;
  await request(app)
    .post(`/api/projects/${otherProject}/sessions/${session.id}/capture-token`)
    .set(auth)
    .expect(404);
  await request(app)
    .post(`/api/projects/${projectId}/sessions/${randomUUID()}/capture-token`)
    .set(auth)
    .expect(404);
});
