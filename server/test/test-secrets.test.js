// @ts-check
// US-064 — assertion-first spec: A SECRET THAT SURVIVES TO 02:00.
//
// US-035's guarantee was that a secret variable's value is never persisted, and
// it held because the value arrived per run from someone who was present: the
// override dialog, or a CI body. A schedule has neither channel. So the test
// that must type a real credential on every run — the login test that PRODUCES
// a session (US-043) and therefore cannot use one — could not be scheduled at
// all, which is the nightly refresh migration 015 already promises.
//
// The guarantee is therefore amended, not dropped: **a secret's value is never
// persisted unencrypted, never returned by any endpoint, and never denormalized
// onto a run.** Everything given up is "never persisted at all". This file is
// what holds the rest of that sentence up.
//
// variables.test.js pins the pure rules (D1-D6). Here: storage, masking, the
// read-modify-write hazard, the run paths, and the schedule's save-time refusal.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions this file encodes:
//
//   D7   THE CIPHERTEXT LIVES IN A TABLE NOTHING SELECTS INTO A RESPONSE, not
//        in a field inside the `tests.variables` jsonb. `variables` is in the
//        `COLS` constant all four test endpoints select, so ciphertext inside
//        it ships in every response body and masking becomes a discipline
//        repeated at four sites forever — which the fifth site added next year
//        does not inherit. With a separate column the property is structural.
//        The assertions are still written over the RESPONSE BODY rather than
//        over a helper, so that fifth site fails these tests instead.
//
//   D8   MASKING NEEDS NO DECRYPTION, and the assertion proves it the only way
//        that cannot be faked: a row whose ciphertext has been corrupted still
//        reads back as `value_set: true`. If a read path ever decrypts, that
//        test throws. This is what keeps "plaintext exists only between
//        `secretsForTests` and `resolveForRun`" literally true, and it is why
//        the set-state is keyed by name in SQL rather than derived from the
//        value.
//
//   D9   THE READ-MODIFY-WRITE HAZARD IS THE REAL RISK OF STORING IT ON THE
//        TEST. `TestDialog` GETs `test.variables`, holds it in editor state and
//        PUTs the whole array back — so a masked GET plus a naive PUT writes an
//        empty value over a stored secret while the user was renaming the test.
//        Silent, and it surfaces as a failed run at 02:00 two weeks later. The
//        merge is three-state (D2) and the seam is the update route's existing
//        `variables === undefined` ⇒ leave unchanged, because the decision
//        needs the stored row and `variables.js` deliberately cannot reach a DB.
//
//   D10  A DECLARATION THAT STOPS BEING A SECRET TAKES ITS VALUE WITH IT.
//        Dropping the variable, or unticking Secret, prunes the row — otherwise
//        a value nothing references sits encrypted on disk forever, and
//        re-adding the name later silently resurrects it.
//
//   D11  A SECRET THAT WILL NOT DECRYPT SKIPS ITS RUN, exactly as an
//        undecryptable session does (US-043). AES-GCM fails closed by design,
//        so a rotated KEY_ENCRYPTION_SECRET reaches here as a throw — and the
//        alternative to refusing is starting a run that types nothing into the
//        password field and reports the app as broken.
//
//   D12  THE SCHEDULE REFUSES AT SAVE WHAT IT CANNOT RESOLVE AT 02:00, naming
//        the test and the variable. Under D7 this check is better than it could
//        have been on its own: it asks "is there a stored value for this?"
//        against real state, not "does this target mention a secret at all?".
//        The tick's own refusal stays as the backstop (BUG-005 reports it), but
//        an operator finds out while they are looking at the screen.
//
//   D13  ...EXCEPT WHEN THE RESULT IS DISABLED. Refusing to let someone turn
//        OFF a schedule whose target is broken traps them: the fix and the
//        thing being refused are the same request. A disabled schedule fires
//        into nothing, so there is nothing to protect it from.
//
//   D14  A GROUP TARGET IS CHECKED THROUGH ITS MEMBERS, using the same
//        resolution the tick uses. A suite that mentions one unresolvable test
//        is refused for that test by name — `routes/schedules.js` already
//        mirrors `scheduler.js` for the target counts (BUG-006), and this is
//        the same rule: the two must not be able to disagree about what a
//        schedule would do.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, beforeEach, after } from 'node:test';
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

// The one string this file hunts for. It is only ever present because the
// stored VALUE was — nothing else in the fixtures spells it.
const CANARY = 'CANARY-PW-4f19ba';

/** @type {any} */ let app;
/** @type {any} */ let pool;
let operatorId = '';
let artifactsDir = '';
let captureDir = '';
let captureFile = '';

async function pollUntil(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-secret-runs-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-secret-capture-'));
  captureFile = path.join(captureDir, 'qa-vars.jsonl');
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'vars_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.QA_CAPTURE_FILE = captureFile;

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
  // The write path under test here passes ciphertext as a `bytea` PARAMETER,
  // which a plain pg-mem pool mangles and — depending on nothing but the random
  // AES-GCM IV — sometimes refuses to parse at all (BUG-007).
  pool = byteaPool(mem);

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
  ({ app } = await import('../src/server.js'));
});

beforeEach(async () => {
  await pool.query('delete from schedules');
  await pool.query('delete from runs');
  await pool.query('delete from suite_tests');
  await pool.query('delete from test_secrets');
  await pool.query('delete from tests');
  await pool.query('delete from suites');
  fs.writeFileSync(captureFile, '');
});

after(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(captureDir, { recursive: true, force: true });
});

/** A saved test declaring one required secret, with `value` stored on create. */
const makeTest = (overrides = {}) =>
  request(app)
    .post('/api/tests')
    .set(auth)
    .send({
      name: 'admin login',
      goal: 'log in as admin with {{pw}}',
      start_url: 'https://example.test/login',
      variables: [{ name: 'pw', value: CANARY, secret: true }],
      ...overrides,
    });

const secretRows = async (testId) =>
  (await pool.query('select name, value_ciphertext from test_secrets where test_id = $1', [testId]))
    .rows;

/** The QA_VARS every stub run recorded, newest last. */
const capturedRuns = () =>
  fs
    .readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// --- storage and masking (D7, D8) -------------------------------------------

test('a secret value is stored encrypted, out of the declaration, and never echoed', async () => {
  const created = (await makeTest().expect(201)).body;

  // D7: what came back describes the secret without carrying it.
  assert.deepEqual(created.variables, [
    { name: 'pw', value: '', secret: true, optional: false, value_set: true },
  ]);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(CANARY));

  // D1 again, at the storage layer this time: the jsonb holds no plaintext...
  const stored = (await pool.query('select variables from tests where id = $1', [created.id]))
    .rows[0].variables;
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(CANARY));

  // ...and the column that does hold it holds ciphertext, not the string.
  const rows = await secretRows(created.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'pw');
  assert.ok(Buffer.isBuffer(rows[0].value_ciphertext), 'expected a bytea payload');
  assert.doesNotMatch(rows[0].value_ciphertext.toString('utf8'), new RegExp(CANARY));

  const { decryptSecret } = await import('../src/crypto.js');
  assert.equal(decryptSecret(rows[0].value_ciphertext), CANARY);
});

test('no read endpoint returns a stored secret — asserted over the response body', async () => {
  const created = (await makeTest().expect(201)).body;

  const list = (await request(app).get('/api/tests').set(auth).expect(200)).body;
  const one = (await request(app).get(`/api/tests/${created.id}`).set(auth).expect(200)).body;
  const updated = (
    await request(app)
      .put(`/api/tests/${created.id}`)
      .set(auth)
      .send({ name: 'admin login (renamed)' })
      .expect(200)
  ).body;

  // Over the BODY, not over a helper: a fifth site that builds its own column
  // list has to fail here rather than inherit the masking by accident.
  for (const [label, body] of [['list', list], ['one', one], ['update', updated]]) {
    assert.doesNotMatch(JSON.stringify(body), new RegExp(CANARY), `${label} leaked the value`);
  }
  assert.equal(list.tests[0].variables[0].value_set, true);
  assert.equal(one.variables[0].value_set, true);
  assert.equal(one.variables[0].value, '');
});

test('the set-state is answered without decrypting anything (D8)', async () => {
  const created = (await makeTest().expect(201)).body;
  // Corrupt the stored bytes. Anything that decrypts on a read path now throws
  // — AES-GCM fails closed by design (crypto.js) — so this passing IS the proof
  // that no read path decrypts.
  await pool.query(
    `update test_secrets set value_ciphertext = decode('00112233445566778899aabbccddeeff00', 'hex')
      where test_id = $1`,
    [created.id]
  );
  const one = (await request(app).get(`/api/tests/${created.id}`).set(auth).expect(200)).body;
  assert.equal(one.variables[0].value_set, true);
});

test('a variable declared secret with no value reads as not set', async () => {
  const created = (
    await makeTest({ variables: [{ name: 'pw', secret: true, optional: true }] }).expect(201)
  ).body;
  assert.equal(created.variables[0].value_set, false);
  assert.deepEqual(await secretRows(created.id), []);
});

// --- the three-state write (D2, D9, D10) ------------------------------------

test('editing an unrelated field leaves a stored secret untouched (AC #4)', async () => {
  const created = (await makeTest().expect(201)).body;
  const before = (await secretRows(created.id))[0].value_ciphertext;

  // Exactly what TestDialog does: it holds the array it was GIVEN — masked —
  // and PUTs the whole thing back with only the name changed.
  const round = (await request(app).get(`/api/tests/${created.id}`).set(auth).expect(200)).body;
  const updated = (
    await request(app)
      .put(`/api/tests/${created.id}`)
      .set(auth)
      .send({ name: 'admin login v2', variables: round.variables })
      .expect(200)
  ).body;

  assert.equal(updated.variables[0].value_set, true);
  const after = (await secretRows(created.id))[0].value_ciphertext;
  assert.deepEqual(after, before, 'a blank secret box means keep, not clear');
});

test('a non-empty value replaces the stored secret', async () => {
  const created = (await makeTest().expect(201)).body;
  await request(app)
    .put(`/api/tests/${created.id}`)
    .set(auth)
    .send({ variables: [{ name: 'pw', value: 'rotated-9f2', secret: true }] })
    .expect(200);

  const { decryptSecret } = await import('../src/crypto.js');
  assert.equal(decryptSecret((await secretRows(created.id))[0].value_ciphertext), 'rotated-9f2');
});

test('an explicit clear removes the stored secret, and the run then refuses', async () => {
  const created = (await makeTest().expect(201)).body;
  const cleared = (
    await request(app)
      .put(`/api/tests/${created.id}`)
      .set(auth)
      .send({ variables: [{ name: 'pw', value: '', secret: true, clear: true }] })
      .expect(200)
  ).body;

  assert.equal(cleared.variables[0].value_set, false);
  assert.deepEqual(await secretRows(created.id), []);
  const refused = await request(app).post(`/api/tests/${created.id}/run`).set(auth).expect(400);
  assert.match(refused.body.error, /pw is required/);
});

test('a declaration that stops being a secret takes its stored value with it (D10)', async () => {
  const dropped = (await makeTest().expect(201)).body;
  await request(app)
    .put(`/api/tests/${dropped.id}`)
    .set(auth)
    .send({ goal: 'log in as admin', variables: [] })
    .expect(200);
  assert.deepEqual(await secretRows(dropped.id), []);

  // Unticking Secret is the same event wearing different clothes: the value
  // would otherwise sit encrypted under a name that is now a plain variable.
  const unticked = (await makeTest().expect(201)).body;
  const after = (
    await request(app)
      .put(`/api/tests/${unticked.id}`)
      .set(auth)
      .send({ variables: [{ name: 'pw', value: 'now-plain', secret: false }] })
      .expect(200)
  ).body;
  assert.deepEqual(await secretRows(unticked.id), []);
  assert.equal(after.variables[0].value, 'now-plain');
  assert.equal(after.variables[0].value_set, undefined);
});

// --- the run paths (D11) ----------------------------------------------------

test('a stored secret reaches the agent on the QA_VARS channel and nowhere else', async () => {
  const created = (await makeTest().expect(201)).body;
  const { runId } = (await request(app).post(`/api/tests/${created.id}/run`).set(auth).expect(200))
    .body;

  await pollUntil(async () => capturedRuns().length > 0);
  const [child] = capturedRuns();
  // The real value, on the sensitive_data channel (US-035) — this is the whole
  // point of storing it at all.
  assert.deepEqual(JSON.parse(child.vars), { pw: CANARY });
  // ...and not in the task text the LLM is handed.
  assert.equal(child.goal, 'log in as admin with <secret>pw</secret>');

  const run = (await request(app).get(`/api/runs/${runId}`).set(auth).expect(200)).body;
  assert.deepEqual(run.variables, { pw: '<secret>' });
  assert.doesNotMatch(JSON.stringify(run), new RegExp(CANARY));

  const row = (await pool.query('select goal, variables from runs where id = $1', [runId])).rows[0];
  assert.doesNotMatch(JSON.stringify(row), new RegExp(CANARY));
});

test('a per-run override still wins, and a blank box does not (D3, D4)', async () => {
  const created = (await makeTest().expect(201)).body;
  await request(app)
    .post(`/api/tests/${created.id}/run`)
    .set(auth)
    .send({ variables: { pw: 'typed-for-this-run' } })
    .expect(200);
  await pollUntil(async () => capturedRuns().length > 0);
  assert.deepEqual(JSON.parse(capturedRuns()[0].vars), { pw: 'typed-for-this-run' });

  // The override dialog prefills from the masked declaration, so every manual
  // run of a test with a stored secret sends `pw: ''`. Read literally that is
  // an override, and every one of those runs breaks.
  fs.writeFileSync(captureFile, '');
  await request(app)
    .post(`/api/tests/${created.id}/run`)
    .set(auth)
    .send({ variables: { pw: '' } })
    .expect(200);
  await pollUntil(async () => capturedRuns().length > 0);
  assert.deepEqual(JSON.parse(capturedRuns()[0].vars), { pw: CANARY });
});

test('a secret that will not decrypt refuses the run rather than typing nothing (D11)', async () => {
  const created = (await makeTest().expect(201)).body;
  await pool.query(
    `update test_secrets set value_ciphertext = decode('00112233445566778899aabbccddeeff00', 'hex')
      where test_id = $1`,
    [created.id]
  );
  const refused = await request(app).post(`/api/tests/${created.id}/run`).set(auth).expect(400);
  assert.match(refused.body.error, /could not be decrypted/i);
  assert.equal((await pool.query('select 1 from runs')).rowCount, 0);
  assert.equal(capturedRuns().length, 0);
});

// --- the schedule's save-time refusal (D12, D13, D14) -----------------------

const daily = (body) =>
  request(app)
    .post('/api/schedules')
    .set(auth)
    .send({ kind: 'daily', hour: 2, minute: 0, tz: 'Europe/Berlin', ...body });

test('a schedule over a test with a stored secret saves (AC #1)', async () => {
  const created = (await makeTest().expect(201)).body;
  await daily({ test_id: created.id }).expect(201);
});

test('a schedule whose target cannot resolve its secret is refused, with the reason (AC #5)', async () => {
  const created = (
    await makeTest({ variables: [{ name: 'pw', secret: true }] }).expect(201)
  ).body;
  const refused = await daily({ test_id: created.id }).expect(400);
  assert.match(refused.body.error, /admin login/); // the test, by name
  assert.match(refused.body.error, /\bpw\b/); // and the variable
  assert.equal((await pool.query('select 1 from schedules')).rowCount, 0);
});

test('an optional secret is not a reason to refuse a schedule', async () => {
  const created = (
    await makeTest({
      goal: 'log in as admin with {{pw}}',
      variables: [{ name: 'pw', secret: true, optional: true }],
    }).expect(201)
  ).body;
  await daily({ test_id: created.id }).expect(201);
});

test('a suite is checked through its members, by name (D14)', async () => {
  const project = (
    await request(app).post('/api/projects').set(auth).send({ name: 'nightly shop' }).expect(201)
  ).body;
  const ok = (await makeTest({ project_id: project.id }).expect(201)).body;
  const broken = (
    await makeTest({
      name: 'billing login',
      project_id: project.id,
      variables: [{ name: 'pw', secret: true }],
    }).expect(201)
  ).body;
  const suite = (
    await request(app)
      .post('/api/suites')
      .set(auth)
      .send({ name: 'nightly', project_id: project.id, test_ids: [ok.id, broken.id] })
      .expect(201)
  ).body;

  const refused = await daily({ suite_id: suite.id }).expect(400);
  assert.match(refused.body.error, /billing login/);
  assert.doesNotMatch(refused.body.error, /admin login/);
});

test('a schedule whose target broke afterwards can still be disabled (D13)', async () => {
  const created = (await makeTest().expect(201)).body;
  const schedule = (await daily({ test_id: created.id }).expect(201)).body;

  await request(app)
    .put(`/api/tests/${created.id}`)
    .set(auth)
    .send({ variables: [{ name: 'pw', value: '', secret: true, clear: true }] })
    .expect(200);

  // The enabled edit is refused — it would fire into a dropped member tonight...
  const refused = await request(app)
    .put(`/api/schedules/${schedule.id}`)
    .set(auth)
    .send({ hour: 3 })
    .expect(400);
  assert.match(refused.body.error, /\bpw\b/);

  // ...but turning it off must not be, or the fix and the refusal are the same
  // request and the operator is trapped.
  const off = await request(app)
    .put(`/api/schedules/${schedule.id}`)
    .set(auth)
    .send({ enabled: false })
    .expect(200);
  assert.equal(off.body.enabled, false);
});
