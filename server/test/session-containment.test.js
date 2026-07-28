// @ts-check
// US-043 — assertion-first spec, part 2: WHERE THE BLOB IS ALLOWED TO GO.
//
// Part 1 (session-blob.test.js) pins what a blob may be and what removes its
// plaintext. This file pins the containment: that the ciphertext is the only
// thing at rest, that no read path ever hands the blob back, that it reaches
// the browser and NOTHING else — not an event, not report_data.json, not the
// run row, not the PDF — and that its plaintext is gone from disk after every
// way a run can end.
//
// `scrub` is not the guard here and cannot be. US-034/US-035's redaction works
// because a secret variable's value passes through the LLM's context, where a
// string replacement can catch it. A session blob never enters that context at
// all: it goes from Postgres to a file to Chromium. There is nothing for scrub
// to match on, and adding it would be theatre. Containment is the whole
// mechanism, so containment is what this file asserts — by canary, on the full
// serialized bytes of everything a run produces, rather than field by field.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions, continuing part 1's numbering:
//
//   D9   NO READ ENDPOINT RETURNS THE BLOB, and the assertion is a canary over
//        the whole response body rather than a check that `storage_state` is
//        absent. A field-by-field assertion passes the day someone adds
//        `SELECT *` to a list query, or returns the row from the PUT that
//        updated it. The list gives counts and timestamps instead: a session
//        must be describable without being readable, or nobody can tell which
//        of their three sessions is the stale one.
//
//   D10  A SESSION IS ATTACHED OFF THE TEST'S OWN ROW, never off a request
//        body — the same rule and the same LEFT JOIN as US-042's
//        `allowed_domains` and US-048's `project_id`, and for the third time
//        the same reason: a caller who could name the session could name
//        someone else's. `RUNNABLE_TEST_COLS` is the one place it joins, and
//        US-048 already caught `POST /api/tests/:id/run` building its own
//        column list instead of sharing it. Assert on every start path, or the
//        next route to drift does so silently.
//
//   D11  A SESSION BELONGS TO ONE PROJECT and a test may only reference one
//        from its own. Cross-project is refused at write time, not filtered at
//        spawn: a test that silently runs unauthenticated is a false green.
//
//   D12  THE DECRYPT HAPPENS BEFORE `createRun`, not inside `startRun`.
//        `createRun`/`startRun` are synchronous and every trigger path funnels
//        through them; decryption is a DB read. So sessions are pre-resolved
//        into a map by the async caller, exactly as `requireAgentKey`
//        pre-resolves the BYOK key onto `req.runOpenaiKey`. The plaintext then
//        lives in the in-memory run object and in the spawn's file, and in no
//        third place — `persistInsert`, `broadcast` and `generateReport` never
//        read the field, which is the same containment `openai_api_key` has.
//
//   D13  TEARDOWN RUNS ON EVERY END, and the enumeration IS the assertion.
//        A run ends five ways: the agent exits, the memory watchdog kills the
//        tree, the wall-clock watchdog kills the tree, the user stops it, and
//        the spawn fails outright. Four of them do not go through the fifth.
//        This is the shape of US-047's slot accounting and US-036's
//        interceptor: one forgotten path is the entire defect, and it is
//        invisible because the credential left behind costs no disk anyone
//        notices.
//
//   D14  A LOGIN RUN WRITES THE SESSION ONLY ON A PASS, and a failure NEVER
//        clears what is stored. The refresh story is "run the login test
//        again, nightly" (the scheduler already can), so the failure case is
//        not hypothetical — it is Tuesday. Overwriting on failure means one
//        flaky login run replaces a working session with an anonymous browser's
//        empty cookie jar, and every test in the project starts failing at 3am
//        for a reason that points at the wrong thing.
//
//   D14b THE DAY-ONE FLOW NEEDS NO PLAYWRIGHT, and this is the one the story
//        calls the product: a session may be created EMPTY, pointed at the test
//        that logs in, and filled by that test's first passing run. Requiring a
//        pasted blob at creation — which is what the first cut of this did —
//        makes the escape hatch a PREREQUISITE for the product, so the only way
//        to reach the login-run path is to first produce by hand the file it
//        exists to make unnecessary.
//
//        Null ciphertext is therefore a real state, and it must be a LOUD one.
//        An uncaptured session refuses the run rather than starting it signed
//        out: a test that quietly runs signed out passes nothing and fails
//        everything, which is the false green the whole story removes. The
//        create route also refuses a session with neither a blob nor a login
//        test — a row nothing can ever fill.
//
//   D15  AN EXPIRED SESSION IS A `failure_reason`, NOT A GOAL FAILURE. It
//        reuses `runs.failure_reason` (013), which already carries
//        `navigation_blocked`, rather than adding an eighth status — a blocked
//        run is `failed`, and so is this one. What matters is that something
//        machine-readable survives to the row, because CI (US-008), the mail
//        (US-012) and the PDF all read the row and not the prose. And the
//        inverse must hold: an ordinary run must never carry the reason, or it
//        stops meaning anything.
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

// The one string this whole file hunts for. It sits inside a cookie value, so
// it is only ever present because the BLOB itself was.
const CANARY = 'CANARY-SESSION-VALUE-b7f3d9';

const BLOB = {
  cookies: [
    {
      name: 'session',
      value: CANARY,
      domain: '.example.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [{ origin: 'https://example.test', localStorage: [{ name: 'jwt', value: CANARY }] }],
};

/** @type {any} */ let app;
/** @type {any} */ let pool;
/** @type {any} */ let runsModule;
let artifactsDir = '';
let sessionsDir = '';
let captureDir = '';
let operatorId = '';
let projectId = '';

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
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess-runs-'));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess-blobs-'));
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-sess-capture-'));
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'session_capture_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;
  process.env.SESSIONS_DIR = sessionsDir;
  // The stub agent's instrument, deliberately outside every product directory.
  process.env.QA_CAPTURE_DIR = captureDir;

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
  // Every route under test here writes ciphertext as a `bytea` PARAMETER, which
  // a plain pg-mem pool mangles and — depending on nothing but the random IV —
  // sometimes refuses to parse at all (BUG-007).
  pool = byteaPool(mem);

  const { runMigrations, initDb, getOperatorUserId } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  operatorId = /** @type {string} */ (getOperatorUserId());
  await seedStoredKey(pool, operatorId);
  ({ app } = await import('../src/server.js'));
  runsModule = await import('../src/runs.js');

  projectId = (await request(app).post('/api/projects').set(auth).send({ name: 'shop' }).expect(201))
    .body.id;
});

after(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(captureDir, { recursive: true, force: true });
});

/**
 * A session whose ciphertext must later DECRYPT is seeded through the
 * registered `decode` builtin with the hex inline — the same trick `byteaPool`
 * plays on the parameters the product passes (helpers/stored-key.js explains
 * both). The HTTP write path's own storage is proven on a real server in
 * session-postgres.test.js.
 */
async function seedSession(name = 'staging login', blob = BLOB, extra = {}) {
  const { encryptSecret } = await import('../src/crypto.js');
  const hex = encryptSecret(JSON.stringify(blob)).toString('hex');
  const { rows } = await pool.query(
    `insert into browser_sessions
       (project_id, name, name_key, storage_state_ciphertext, cookie_count, origin_count, source,
        verify_url_contains, verify_text, captured_at)
     values ($1, $2, $3, decode('${hex}', 'hex'), $4, $5, $6, $7, $8, now())
     returning id, name`,
    [
      projectId,
      name,
      name.toLowerCase(),
      blob.cookies?.length || 0,
      blob.origins?.length || 0,
      extra.source || 'pasted',
      extra.verify_url_contains || null,
      extra.verify_text || null,
    ]
  );
  return rows[0];
}

async function seedTest(sessionId, overrides = {}) {
  const { rows } = await pool.query(
    `insert into tests (user_id, name, goal, start_url, max_steps, project_id, browser_session_id)
     values ($1, $2, $3, $4, 3, $5, $6) returning id`,
    [
      operatorId,
      overrides.name || 'checkout smoke',
      'buy a widget',
      'https://example.test/shop',
      projectId,
      sessionId,
    ]
  );
  return rows[0].id;
}

/** Everything the run left behind, as one string to hunt the canary in. */
function runFootprint(runId, row) {
  const dir = path.join(artifactsDir, runId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const onDisk = files.map((f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  });
  const live = runsModule.getRun(runId);
  return [
    JSON.stringify(row || {}),
    JSON.stringify(live?.events || []),
    ...onDisk,
    files.join('\n'),
  ].join('\n');
}

// ── D9: nothing reads it back ───────────────────────────────────────────────

test('no read path returns the blob — asserted on the whole body, not a field', async () => {
  const session = await seedSession('read-back probe');

  const bodies = [
    (await request(app).get(`/api/projects/${projectId}/sessions`).set(auth).expect(200)).body,
    (await request(app).get(`/api/projects/${projectId}`).set(auth).expect(200)).body,
    (
      await request(app)
        .put(`/api/projects/${projectId}/sessions/${session.id}`)
        .set(auth)
        .send({ name: 'renamed' })
        .expect(200)
    ).body,
  ];
  for (const body of bodies) {
    assert.equal(
      JSON.stringify(body).includes(CANARY),
      false,
      'a read handed the session blob back'
    );
  }
});

test('a session is describable without being readable', async () => {
  await seedSession('describable');
  const { body } = await request(app)
    .get(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .expect(200);
  const row = body.sessions.find((s) => s.name === 'describable');
  assert.ok(row, 'the session must be listed');
  // Enough to tell a live session from a stale one at a glance.
  assert.equal(row.cookie_count, 1);
  assert.equal(row.origin_count, 1);
  assert.ok(row.captured_at, 'when it was captured is how a user judges it');
  assert.equal('storage_state' in row, false);
  assert.equal('storage_state_ciphertext' in row, false);
});

test('the paste endpoint stores ciphertext and answers with metadata only', async () => {
  const { body } = await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name: 'pasted in', storage_state: BLOB })
    .expect(201);
  assert.equal(JSON.stringify(body).includes(CANARY), false);
  assert.equal(body.source, 'pasted');

  const { rows } = await pool.query(
    'select storage_state_ciphertext from browser_sessions where id = $1',
    [body.id]
  );
  const stored = rows[0].storage_state_ciphertext;
  assert.ok(Buffer.isBuffer(stored) || stored instanceof Uint8Array, 'must be bytea, not text');
  assert.equal(
    Buffer.from(stored).toString('utf8').includes(CANARY),
    false,
    'the blob is at rest in the clear'
  );
});

test('a blob that is not a storageState is refused with nothing written', async () => {
  const before = (await pool.query('select count(*)::int as n from browser_sessions')).rows[0].n;
  await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name: 'junk', storage_state: 'not a storage state' })
    .expect(400);
  const after = (await pool.query('select count(*)::int as n from browser_sessions')).rows[0].n;
  assert.equal(after, before);
});

// ── D10/D11: whose session ──────────────────────────────────────────────────

test('a test cannot reference a session from another project', async () => {
  const other = (
    await request(app).post('/api/projects').set(auth).send({ name: 'other shop' }).expect(201)
  ).body;
  const mine = await seedSession('mine only');

  await request(app)
    .post('/api/tests')
    .set(auth)
    .send({
      name: 'wrong project',
      goal: 'g',
      start_url: 'https://example.test',
      project_id: other.id,
      browser_session_id: mine.id,
    })
    .expect(400);

  const { rows } = await pool.query('select 1 from tests where name = $1', ['wrong project']);
  assert.equal(rows.length, 0, 'the refused test must not exist');
});

test("a stranger's project 404s before any session is touched", async () => {
  const { rows } = await pool.query(
    "insert into users (email) values ('stranger@example.test') returning id"
  );
  const strangerProject = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id',
      [rows[0].id, 'theirs', 'theirs']
    )
  ).rows[0];

  await request(app).get(`/api/projects/${strangerProject.id}/sessions`).set(auth).expect(404);
  await request(app)
    .post(`/api/projects/${strangerProject.id}/sessions`)
    .set(auth)
    .send({ name: 'x', storage_state: BLOB })
    .expect(404);
});

test('a request body cannot name the session a run uses', async () => {
  const session = await seedSession('body probe');
  const testId = await seedTest(null); // this test opts into NO session

  const { body } = await request(app)
    .post(`/api/tests/${testId}/run`)
    .set(auth)
    .send({ browser_session_id: session.id, session_id: session.id })
    .expect(200);

  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['passed', 'failed', 'completed', 'error'].includes(rows[0].status);
  });
  const captured = capturedEnv(body.runId);
  assert.equal(
    captured.QA_STORAGE_STATE || '',
    '',
    'a body-named session reached the spawn — the session must come off the test row'
  );
});

// ── D12/D13: the plaintext's whole life ─────────────────────────────────────

/** What the stub agent recorded about the environment it was spawned with. */
function capturedEnv(runId) {
  const file = path.join(captureDir, `${runId}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('every run-start path resolves the session off the test row', async () => {
  const session = await seedSession('every path');
  const testId = await seedTest(session.id);
  await pool.query('insert into suites (user_id, project_id, name) values ($1, $2, $3)', [
    operatorId,
    projectId,
    'smoke',
  ]);
  const suiteId = (await pool.query('select id from suites where name = $1', ['smoke'])).rows[0].id;
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 0)', [
    suiteId,
    testId,
  ]);

  const paths = [
    ['POST /api/tests/:id/run', `/api/tests/${testId}/run`],
    ['POST /api/suites/:id/run', `/api/suites/${suiteId}/run`],
    ['POST /api/projects/:project/run', `/api/projects/${projectId}/run`],
  ];
  for (const [label, url] of paths) {
    const { body } = await request(app).post(url).set(auth).send({}).expect(200);
    const runId = body.runId || body.runs.find((r) => r.testId === testId)?.runId;
    assert.ok(runId, `${label}: expected a run`);
    await pollUntil(() => fs.existsSync(path.join(captureDir, `${runId}.json`)));
    const captured = capturedEnv(runId);
    assert.ok(
      captured.QA_STORAGE_STATE,
      `${label}: the session did not reach the spawn — a query that forgot the join`
    );
    // D1 again, from the far side: the child was handed a PATH.
    assert.equal(
      captured.storage_state_is_file,
      true,
      `${label}: QA_STORAGE_STATE must name a file that exists at spawn`
    );
    assert.ok(
      captured.storage_state_contents.includes(CANARY),
      `${label}: the file must hold the decrypted blob`
    );
  }
});

test('the blob reaches the browser and nothing else', async () => {
  const session = await seedSession('containment');
  const testId = await seedTest(session.id);
  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);
  const runId = body.runId;

  await pollUntil(async () => {
    const { rows } = await pool.query('select report_status from runs where id = $1', [runId]);
    return rows[0]?.report_status === 'ready' || rows[0]?.report_status === 'error';
  });
  const { rows } = await pool.query('select * from runs where id = $1', [runId]);

  assert.equal(
    runFootprint(runId, rows[0]).includes(CANARY),
    false,
    'the session blob reached an event, the run row, or an artifact'
  );
  // And specifically the file the PDF is rendered from, since that is the one
  // that gets emailed (US-012).
  const dataPath = path.join(artifactsDir, runId, 'report_data.json');
  assert.ok(fs.existsSync(dataPath), 'the report data should exist for this assertion to mean anything');
  assert.equal(fs.readFileSync(dataPath, 'utf8').includes(CANARY), false);
});

test('the plaintext is gone after the agent exits normally', async () => {
  const session = await seedSession('teardown normal');
  const testId = await seedTest(session.id);
  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);

  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['passed', 'failed', 'completed', 'error'].includes(rows[0].status);
  });
  const mod = await import('../src/browserSession.js');
  await pollUntil(() => !fs.existsSync(mod.sessionDir(body.runId)));
  assert.equal(fs.existsSync(mod.sessionDir(body.runId)), false);
});

test('the plaintext is gone after a stop, and after a killed tree', async () => {
  const mod = await import('../src/browserSession.js');
  const session = await seedSession('teardown stop');
  // A test whose stub agent hangs, so there is a live process to stop/kill.
  const testId = await seedTest(session.id, { name: 'hanging' });
  await pool.query('update tests set goal = $1 where id = $2', ['HANG', testId]);

  // (a) the user stops it (US-047)
  const stopped = (await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(mod.sessionDir(stopped)));
  await request(app).post(`/api/runs/${stopped}/stop`).set(auth).expect(200);
  await pollUntil(() => !fs.existsSync(mod.sessionDir(stopped)), 8000);
  assert.equal(fs.existsSync(mod.sessionDir(stopped)), false, 'a stopped run left its blob on disk');

  // (b) a watchdog kills the tree — the path that does NOT go through a clean
  // agent exit, and the one an implementation that tears down in the stdout
  // `done` handler would miss entirely.
  const killed = (await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(mod.sessionDir(killed)));
  const run = runsModule.getRun(killed);
  process.kill(-run.child.pid, 'SIGKILL');
  await pollUntil(() => !fs.existsSync(mod.sessionDir(killed)), 8000);
  assert.equal(fs.existsSync(mod.sessionDir(killed)), false, 'a killed run left its blob on disk');
});

// ── D14: the login run ──────────────────────────────────────────────────────

test('a passing login run refreshes the session it belongs to', async () => {
  const session = await seedSession('refreshable');
  const loginTestId = await seedTest(null, { name: 'log in' });
  await pool.query('update browser_sessions set login_test_id = $1 where id = $2', [
    loginTestId,
    session.id,
  ]);
  const before = (
    await pool.query('select storage_state_ciphertext, captured_at from browser_sessions where id = $1', [
      session.id,
    ])
  ).rows[0];

  const { body } = await request(app)
    .post(`/api/tests/${loginTestId}/run`)
    .set(auth)
    .send({})
    .expect(200);

  await pollUntil(async () => {
    const { rows } = await pool.query(
      'select storage_state_ciphertext from browser_sessions where id = $1',
      [session.id]
    );
    return Buffer.compare(
      Buffer.from(rows[0].storage_state_ciphertext),
      Buffer.from(before.storage_state_ciphertext)
    ) !== 0;
  }, 8000);

  const after = (
    await pool.query('select cookie_count, source, captured_at from browser_sessions where id = $1', [
      session.id,
    ])
  ).rows[0];
  assert.equal(after.source, 'login_run');
  assert.ok(after.captured_at > before.captured_at, 'captured_at must move');

  // And the export file the agent wrote is gone with the rest of the run dir.
  const mod = await import('../src/browserSession.js');
  await pollUntil(() => !fs.existsSync(mod.sessionDir(body.runId)));
});

test('a FAILING login run leaves the stored session exactly as it was', async () => {
  const session = await seedSession('must not be clobbered');
  const loginTestId = await seedTest(null, { name: 'log in badly' });
  await pool.query('update tests set goal = $1 where id = $2', ['FAIL', loginTestId]);
  await pool.query('update browser_sessions set login_test_id = $1 where id = $2', [
    loginTestId,
    session.id,
  ]);
  const before = (
    await pool.query(
      'select storage_state_ciphertext, cookie_count, captured_at from browser_sessions where id = $1',
      [session.id]
    )
  ).rows[0];

  const { body } = await request(app)
    .post(`/api/tests/${loginTestId}/run`)
    .set(auth)
    .send({})
    .expect(200);
  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['failed', 'error', 'completed'].includes(rows[0].status);
  });

  const after = (
    await pool.query(
      'select storage_state_ciphertext, cookie_count, captured_at from browser_sessions where id = $1',
      [session.id]
    )
  ).rows[0];
  assert.equal(
    Buffer.compare(
      Buffer.from(after.storage_state_ciphertext),
      Buffer.from(before.storage_state_ciphertext)
    ),
    0,
    'a failed login run overwrote a working session — every test in the project now fails at 3am'
  );
  assert.equal(after.cookie_count, before.cookie_count);
  assert.deepEqual(after.captured_at, before.captured_at);
});

// ── D14b: the flow for someone who has never used Playwright ────────────────

test('a session can be created empty and filled by its login test', async () => {
  // The whole day-one path, end to end, with no storageState.json anywhere.
  const loginTestId = await seedTest(null, { name: 'log in for real' });

  const created = (
    await request(app)
      .post(`/api/projects/${projectId}/sessions`)
      .set(auth)
      .send({ name: 'captured not pasted', login_test_id: loginTestId })
      .expect(201)
  ).body;
  assert.equal(created.captured_at, null, 'an uncaptured session must say so');
  assert.equal(created.cookie_count, 0);

  // A test opting into it is REFUSED — not run signed out.
  const memberId = await seedTest(created.id, { name: 'needs the session' });
  const refused = await request(app).post(`/api/tests/${memberId}/run`).set(auth).send({}).expect(400);
  assert.match(refused.body.error, /not been captured/);
  assert.equal(
    (await pool.query('select count(*)::int as n from runs where test_id = $1', [memberId])).rows[0].n,
    0,
    'a refused run must cost no row'
  );

  // The login test runs and passes; the session fills.
  const { body } = await request(app)
    .post(`/api/tests/${loginTestId}/run`)
    .set(auth)
    .send({})
    .expect(200);
  await pollUntil(async () => {
    const { rows } = await pool.query(
      'select storage_state_ciphertext from browser_sessions where id = $1',
      [created.id]
    );
    return !!rows[0].storage_state_ciphertext;
  }, 8000);
  const filled = (
    await pool.query('select source, cookie_count, captured_at from browser_sessions where id = $1', [
      created.id,
    ])
  ).rows[0];
  assert.equal(filled.source, 'login_run');
  assert.ok(filled.cookie_count > 0);
  assert.ok(filled.captured_at, 'captured_at must now be set');

  // The last leg — the member test now running WITH the captured blob — is
  // deliberately not claimed here. `byteaPool` gets the ciphertext back intact,
  // but what makes that leg worth asserting is the browser starting signed in
  // off bytes a real server stored, and a pg-mem row proves neither half. It is
  // on a real server in session-postgres.test.js, the split US-039 made.
  void body;
});

test('a session with neither a blob nor a login test is refused', async () => {
  // A row nothing could ever fill. The useful moment to say so is now, not when
  // a run refuses three days later.
  const res = await request(app)
    .post(`/api/projects/${projectId}/sessions`)
    .set(auth)
    .send({ name: 'dead end' })
    .expect(400);
  assert.match(res.body.error, /login test/);
  const { rows } = await pool.query('select 1 from browser_sessions where name = $1', ['dead end']);
  assert.equal(rows.length, 0);
});

test('the login test cannot be cleared off a session that has never been captured', async () => {
  const loginTestId = await seedTest(null, { name: 'the only filler' });
  const created = (
    await request(app)
      .post(`/api/projects/${projectId}/sessions`)
      .set(auth)
      .send({ name: 'still empty', login_test_id: loginTestId })
      .expect(201)
  ).body;
  await request(app)
    .put(`/api/projects/${projectId}/sessions/${created.id}`)
    .set(auth)
    .send({ login_test_id: null })
    .expect(400);
  const { rows } = await pool.query('select login_test_id from browser_sessions where id = $1', [
    created.id,
  ]);
  assert.equal(rows[0].login_test_id, loginTestId, 'the write must not have landed');
});

// ── D15: expiry is a verdict, not a mystery ─────────────────────────────────

test('an expired session fails with a reason that says so', async () => {
  const session = await seedSession('expired', BLOB, { verify_url_contains: '/dashboard' });
  const testId = await seedTest(session.id, { name: 'behind the login' });
  // The stub agent reports the expiry the real agent detects in its
  // pre-LLM on_step_start hook.
  await pool.query('update tests set goal = $1 where id = $2', ['SESSION_EXPIRED', testId]);

  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);
  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['failed', 'error'].includes(rows[0].status);
  });

  const { rows } = await pool.query('select status, failure_reason from runs where id = $1', [
    body.runId,
  ]);
  assert.equal(rows[0].failure_reason, 'session_expired');
  assert.equal(rows[0].status, 'failed', 'an expired session is a failure, not a crash');

  // It reaches the report too — the PDF is what a human reads at 9am about the
  // suite that went red at 3am.
  await pollUntil(() => fs.existsSync(path.join(artifactsDir, body.runId, 'report_data.json')));
  const data = JSON.parse(
    fs.readFileSync(path.join(artifactsDir, body.runId, 'report_data.json'), 'utf8')
  );
  assert.equal(data.failure_reason, 'session_expired');
});

test('an ordinary run never carries the reason', async () => {
  const testId = await seedTest(null, { name: 'no session at all' });
  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);
  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['passed', 'failed', 'completed', 'error'].includes(rows[0].status);
  });
  const { rows } = await pool.query('select failure_reason from runs where id = $1', [body.runId]);
  assert.equal(rows[0].failure_reason, null);
});

// ── the preamble reaches the child, and says it was not a step ──────────────

test('a project preamble reaches the spawn, and an absent one is still sent', async () => {
  await request(app)
    .put(`/api/projects/${projectId}`)
    .set(auth)
    .send({
      initial_actions: [{ send_keys: { keys: 'Escape' } }, { wait: { seconds: 1 } }],
    })
    .expect(200);
  const testId = await seedTest(null, { name: 'preamble probe' });

  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);
  await pollUntil(() => fs.existsSync(path.join(captureDir, `${body.runId}.json`)));
  const captured = capturedEnv(body.runId);
  // Always sent, even empty — absent and `[]` must be distinguishable in the
  // child, and only one of them is a statement (US-042's QA_ALLOWED_DOMAINS,
  // US-048's QA_FIXTURES, and now this).
  assert.equal(typeof captured.QA_INITIAL_ACTIONS, 'string');
  assert.deepEqual(JSON.parse(captured.QA_INITIAL_ACTIONS), [
    { send_keys: { keys: 'Escape' } },
    { wait: { seconds: 1 } },
  ]);

  await request(app).put(`/api/projects/${projectId}`).set(auth).send({ initial_actions: [] }).expect(200);
  const second = (await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200))
    .body.runId;
  await pollUntil(() => fs.existsSync(path.join(captureDir, `${second}.json`)));
  assert.deepEqual(JSON.parse(capturedEnv(second).QA_INITIAL_ACTIONS), []);
});

test('a preamble is not charged as steps', async () => {
  // AC #5. browser-use records initial actions as step 0 (agent/service.py:3300)
  // and the LLM loop starts at 1, so the guarantee is that the step list a run
  // reports begins at 1 regardless of how long the preamble was.
  await request(app)
    .put(`/api/projects/${projectId}`)
    .set(auth)
    .send({ initial_actions: [{ wait: { seconds: 1 } }, { send_keys: { keys: 'Escape' } }] })
    .expect(200);
  const testId = await seedTest(null, { name: 'step numbering' });
  const { body } = await request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200);

  await pollUntil(async () => {
    const { rows } = await pool.query('select status from runs where id = $1', [body.runId]);
    return rows[0] && ['passed', 'failed', 'completed', 'error'].includes(rows[0].status);
  });
  const { body: steps } = await request(app)
    .get(`/api/runs/${body.runId}/steps`)
    .set(auth)
    .expect(200);
  const numbers = steps.steps.map((s) => s.step);
  assert.ok(numbers.length > 0, 'the stub must report at least one step');
  assert.equal(Math.min(...numbers), 1, 'the preamble must not occupy step 1');
});
