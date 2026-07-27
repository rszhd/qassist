// @ts-check
// US-048 — assertion-first spec, part 2: WHOSE FILES REACH THE AGENT.
//
// Part 1 (fixture-path.test.js) pins what a name may become on disk. This file
// pins the other half of the same boundary: that the list handed to browser-use
// as `available_file_paths` contains this project's fixtures and nothing else,
// that it survives a run, and that it survives retention.
//
// Why the whitelist is the boundary and not a convenience: browser-use gates
// `upload_file` on exact membership of that list (tools/service.py:865) and
// gates `read_file`'s external reads on the same list (:1785). An entry we did
// not mean to put there is a file the agent can be talked into reading back
// into its own context — `.env` included. An entry we forgot to put there is
// merely a flow that does not work, which is the failure mode we can afford.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions, continuing part 1's numbering:
//
//   D8   THE WHITELIST IS READ OFF DISK AT SPAWN, from the project's fixture
//        directory, not assembled from the `fixtures` table. The DB rows are
//        metadata for the UI (size, uploaded-at, quota accounting); the thing
//        that decides what the agent may open has to be the thing that actually
//        exists. Where the two disagree — a half-finished delete, a restored
//        volume — disk is the honest answer, and a row promising a file that is
//        gone costs the agent an error rather than costing us a boundary.
//        Cheap, too: one readdir per spawn, no query, and `startRun` stays sync.
//        [REVIEW: disk vs table. The table would let a soft-deleted fixture stop
//        being attachable without the bytes going, which we do not need yet.]
//
//   D9   A RUN'S PROJECT COMES OFF THE TEST'S ROW, never off the request. It
//        joins in exactly where US-042's `allowed_domains` does
//        (RUNNABLE_TEST_COLS in routes/helpers.js), for the same reason and by
//        the same LEFT JOIN. There is deliberately no `project_id` in any run
//        request body: a caller who could name the project could name someone
//        else's, and the whole boundary would be one forgotten `and user_id =`
//        away from open.
//
//   D10  AN AD-HOC RUN GETS `[]`, NOT "everything". `POST /api/runs` has no
//        test and so no project. That is the path a stranger with their own key
//        actually reaches, which makes it the one this assertion is about —
//        exactly as US-042's D15 argued for the fence.
//
//   D11  `QA_FIXTURES` IS ALWAYS SENT, even when empty, and is JSON. Absent and
//        `[]` must be distinguishable in the child, and the agent's fail-closed
//        parse resolves both to "no files" — but only one of them is a
//        deliberate statement. Same shape as US-042's `QA_ALLOWED_DOMAINS`.
//
//   D12  A DUPLICATE FILENAME IS A 409, not a silent replace. Replacing means a
//        run that passed last week attaches different bytes today with nothing
//        in the history to say so. The user deletes and re-uploads, and the two
//        acts are visible.
//        [REVIEW: 409 vs replace-with-a-new-row. Replace is friendlier; I chose
//        the one that cannot silently change what a saved test does.]
//
//   D13  OVER QUOTA IS 413 AND WRITES NOTHING. Checked against the bytes
//        already stored *before* the body is committed to disk — a quota
//        enforced afterwards has already filled the disk it exists to protect
//        (part 1, D7).
//
//   D14  FIXTURES_DIR IS OUTSIDE ARTIFACTS_DIR and boot refuses otherwise
//        (part 1, G6). Asserted here end-to-end as well, by running the real
//        sweep with a clock far in the future: AC #4 is a promise about what
//        survives a week, and the only convincing proof is the sweep itself
//        declining to take them.
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
import { registerDecode, seedStoredKey } from './helpers/stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

// Distinctive bytes, so AC #5 can be asserted by searching for them rather than
// by trusting that nothing copies a file it was never handed.
const CV_BYTES = Buffer.from('%PDF-1.4 QASSIST-FIXTURE-CANARY-a1b2c3 trailer\n');

/** @type {import('express').Express} */
let app;
/** @type {any} */
let pool;
/** @type {() => { active: number, queued: number }} */
let counts;
/** @type {(now?: number) => Promise<{ pruned: number, skipped: number }>} */
let sweepArtifacts;
let operatorId = '';
let artifactsDir = '';
let fixturesDir = '';
/** The operator's project and a test inside it. */
let projectId = '';
let projectSlug = '';
let testId = '';
/** A second project owned by the SAME user — the cross-project case. */
let otherProjectId = '';
let otherProjectSlug = '';
/** A project owned by a DIFFERENT user — the cross-tenant case. */
let strangerProjectId = '';

before(async () => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-fx-runs-'));
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-fx-store-'));
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
  process.env.FIXTURES_DIR = fixturesDir;
  // Small enough to exercise both caps without writing megabytes in a test.
  process.env.FIXTURE_MAX_BYTES = String(4096);
  process.env.FIXTURE_PROJECT_QUOTA_BYTES = String(8192);
  // Retention on, so the sweep in W9 is the real one on its real schedule.
  process.env.ARTIFACT_RETENTION_DAYS = '7';

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
  ({ sweepArtifacts } = await import('../src/retention.js'));
  ({ app } = await import('../src/server.js'));

  ({ id: projectId, slug: projectSlug } = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug',
      [operatorId, 'careers', 'careers']
    )
  ).rows[0]);
  ({ id: otherProjectId, slug: otherProjectSlug } = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug',
      [operatorId, 'billing', 'billing']
    )
  ).rows[0]);
  ({ id: testId } = (
    await pool.query(
      `insert into tests (user_id, name, goal, start_url, max_steps, project_id)
       values ($1, $2, $3, $4, 1, $5) returning id`,
      [operatorId, 'apply', 'upload cv.pdf and submit', 'https://example.test/', projectId]
    )
  ).rows[0]);

  const stranger = (
    await pool.query('insert into users (email) values ($1) returning id', ['stranger@example.test'])
  ).rows[0];
  ({ id: strangerProjectId } = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id',
      [stranger.id, 'theirs', 'theirs']
    )
  ).rows[0]);
});

after(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(fixturesDir, { recursive: true, force: true });
});

// --- harness -----------------------------------------------------------------

/** Upload raw bytes the way the frontend and a CI caller both do. */
function upload(project, filename, bytes, contentType = 'application/pdf') {
  return request(app)
    .post(`/api/projects/${project}/fixtures`)
    .query({ filename })
    .set(auth)
    .set('Content-Type', contentType)
    .send(bytes);
}

async function drain(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { active, queued } = counts();
    if (!active && !queued) return;
    if (Date.now() > deadline) throw new Error('drain: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Every path under a root, relative — so "nothing escaped" is one comparison. */
function treeOf(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Start a run and return the QA_FIXTURES the child was actually spawned with. */
async function capturedFixtures(send) {
  const envFile = path.join(os.tmpdir(), `qassist-fx-env-${randomUUID()}.json`);
  process.env.QA_ENV_CAPTURE_FILE = envFile;
  try {
    await send();
    await drain();
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    return env.QA_FIXTURES;
  } finally {
    delete process.env.QA_ENV_CAPTURE_FILE;
    fs.rmSync(envFile, { force: true });
  }
}

beforeEach(() => drain());

// --- W1: the fixture exists at all -------------------------------------------

test('a fixture uploads, lists, and lands under its own project', async () => {
  const res = await upload(projectSlug, 'cv.pdf', CV_BYTES).expect(201);
  assert.equal(res.body.filename, 'cv.pdf');
  assert.equal(res.body.size_bytes, CV_BYTES.length);
  assert.ok(res.body.id, 'the fixture is addressable for delete');
  assert.equal(res.body.path, undefined, 'the on-disk path is never handed to a client');

  const onDisk = path.join(fixturesDir, projectId, 'cv.pdf');
  assert.ok(fs.existsSync(onDisk), 'bytes landed in the project directory');
  assert.deepEqual(fs.readFileSync(onDisk), CV_BYTES, 'bytes landed unmodified');

  const list = await request(app).get(`/api/projects/${projectSlug}/fixtures`).set(auth).expect(200);
  assert.deepEqual(
    list.body.fixtures.map((f) => f.filename),
    ['cv.pdf']
  );
});

test('a duplicate filename is refused and the stored bytes are untouched (D12)', async () => {
  const res = await upload(projectSlug, 'cv.pdf', Buffer.from('DIFFERENT BYTES')).expect(409);
  assert.match(res.body.error, /cv\.pdf/, 'the refusal names the file');
  assert.deepEqual(
    fs.readFileSync(path.join(fixturesDir, projectId, 'cv.pdf')),
    CV_BYTES,
    'the original is still the original'
  );
});

// --- W2: the traversal, over HTTP, end to end (AC #3) ------------------------

// Part 1 asserts the gate refuses these names. This asserts the ROUTE asks the
// gate — the two are different claims, and it is the second one that a
// refactor quietly breaks.
const HTTP_REJECTS = [
  ['../../.env', 'path traversal, the acceptance criterion by name'],
  ['../.env', 'one level up'],
  ['/etc/passwd', 'an absolute path to a real file in the container'],
  ['/app/.env', 'an absolute path to OUR file in the container'],
  ['..%2F..%2F.env', 'still traversal after the query parser decodes it'],
  ['.env', 'no traversal needed if a dotfile can simply be named'],
];

for (const [filename, why] of HTTP_REJECTS) {
  test(`POST ?filename=${JSON.stringify(filename)} is refused — ${why}`, async () => {
    const before_ = treeOf(fixturesDir);
    const rows = (await pool.query('select count(*)::int as n from fixtures')).rows[0].n;

    const res = await upload(projectSlug, filename, CV_BYTES);
    assert.equal(res.status, 400, `${filename} was not refused`);

    assert.deepEqual(treeOf(fixturesDir), before_, 'not one byte was written anywhere');
    assert.equal(
      (await pool.query('select count(*)::int as n from fixtures')).rows[0].n,
      rows,
      'and no row claims otherwise'
    );
  });
}

test('a traversal never reaches outside the fixtures root at all', async () => {
  // The belt-and-braces framing of the same claim: assert on the parent of the
  // fixtures root, so an escape that lands in a sibling temp dir is visible
  // even if the fixtures tree itself looks unchanged.
  const parent = path.dirname(fixturesDir);
  const before_ = fs.readdirSync(parent).sort();
  await upload(projectSlug, '../../.env', CV_BYTES).expect(400);
  await upload(projectSlug, `../${path.basename(fixturesDir)}-escaped`, CV_BYTES).expect(400);
  assert.deepEqual(fs.readdirSync(parent).sort(), before_);
});

// --- W3: the quota (D13) ------------------------------------------------------

test('a file over the per-file cap is refused and writes nothing', async () => {
  const before_ = treeOf(fixturesDir);
  const res = await upload(projectSlug, 'huge.pdf', Buffer.alloc(5000, 0x41));
  assert.equal(res.status, 413);
  assert.deepEqual(treeOf(fixturesDir), before_, 'refused before the body was committed');
});

test('a file that fits alone but breaks the project quota is refused', async () => {
  await upload(projectSlug, 'a.pdf', Buffer.alloc(4000, 0x41)).expect(201);
  await upload(projectSlug, 'b.pdf', Buffer.alloc(4000, 0x42)).expect(201);
  const before_ = treeOf(fixturesDir);
  const res = await upload(projectSlug, 'c.pdf', Buffer.alloc(4000, 0x43));
  assert.equal(res.status, 413, 'the project total is its own cap, not just per-file');
  assert.match(res.body.error, /\d/, 'the refusal names the quota');
  assert.deepEqual(treeOf(fixturesDir), before_, 'and the files already there are untouched');

  await request(app).delete(`/api/projects/${projectSlug}/fixtures/a.pdf`).set(auth).expect(204);
  await request(app).delete(`/api/projects/${projectSlug}/fixtures/b.pdf`).set(auth).expect(204);
});

test('the list reports usage against the quota, so the UI can show it', async () => {
  const res = await request(app).get(`/api/projects/${projectSlug}/fixtures`).set(auth).expect(200);
  assert.equal(typeof res.body.used_bytes, 'number');
  assert.equal(typeof res.body.quota_bytes, 'number');
  assert.equal(res.body.used_bytes, CV_BYTES.length, 'only cv.pdf is left');
});

// --- W4: what the agent is handed (AC #2's precondition) ---------------------

test("a project's test carries exactly that project's fixtures into the child", async () => {
  const raw = await capturedFixtures(() =>
    request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200)
  );
  assert.equal(typeof raw, 'string', 'QA_FIXTURES is always sent (D11)');
  const paths = JSON.parse(raw);
  assert.deepEqual(paths, [path.join(fixturesDir, projectId, 'cv.pdf')]);
  assert.ok(path.isAbsolute(paths[0]), 'absolute — browser-use compares exact strings');
  assert.ok(fs.existsSync(paths[0]), 'and the whitelist never advertises a file that is not there');
});

test("another project's fixtures are not in the list (D8, D9)", async () => {
  await upload(otherProjectSlug, 'invoice.pdf', Buffer.from('other project bytes')).expect(201);
  const paths = JSON.parse(
    await capturedFixtures(() =>
      request(app).post(`/api/tests/${testId}/run`).set(auth).send({}).expect(200)
    )
  );
  assert.deepEqual(paths, [path.join(fixturesDir, projectId, 'cv.pdf')]);
  assert.ok(
    !paths.some((p) => p.includes(otherProjectId)),
    'a second project on the same account is still a separate boundary'
  );
});

test('an ad-hoc run gets an empty list, not every fixture on the box (D10)', async () => {
  const raw = await capturedFixtures(() =>
    request(app)
      .post('/api/runs')
      .set(auth)
      .send({ goal: 'log in', start_url: 'https://example.test/' })
      .expect(200)
  );
  assert.equal(raw, '[]', 'present and empty — the two are different statements (D11)');
});

test('a test that belongs to no project gets an empty list', async () => {
  const { id } = (
    await pool.query(
      `insert into tests (user_id, name, goal, start_url, max_steps)
       values ($1, $2, $3, $4, 1) returning id`,
      [operatorId, 'ungrouped', 'log in', 'https://example.test/']
    )
  ).rows[0];
  const raw = await capturedFixtures(() =>
    request(app).post(`/api/tests/${id}/run`).set(auth).send({}).expect(200)
  );
  assert.equal(raw, '[]');
});

test('a run request cannot name its own project (D9)', async () => {
  // The inverse of D9 stated as an assertion: even if a caller sends one, the
  // whitelist is still the owning project's — the body is not consulted.
  const raw = await capturedFixtures(() =>
    request(app)
      .post('/api/runs')
      .set(auth)
      .send({
        goal: 'log in',
        start_url: 'https://example.test/',
        project_id: projectId,
        project: projectSlug,
      })
      .expect(200)
  );
  assert.equal(raw, '[]', 'a body-named project buys no fixtures');
});

// --- W5: tenant isolation ------------------------------------------------------

test("a stranger's project is not readable, writable or deletable", async () => {
  await request(app).get(`/api/projects/${strangerProjectId}/fixtures`).set(auth).expect(404);
  await upload(strangerProjectId, 'cv.pdf', CV_BYTES).expect(404);
  await request(app)
    .delete(`/api/projects/${strangerProjectId}/fixtures/cv.pdf`)
    .set(auth)
    .expect(404);
  assert.ok(
    !fs.existsSync(path.join(fixturesDir, strangerProjectId)),
    'a 404 that still created the directory would be a foothold'
  );
});

// --- W6: fixtures survive retention (AC #4) ------------------------------------

test('the retention sweep does not take fixtures, however old they are', async () => {
  // Backdate everything and run the sweep a year out: whatever the sweep would
  // ever delete, it deletes now.
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  for (const rel of treeOf(fixturesDir)) fs.utimesSync(path.join(fixturesDir, rel), old, old);
  const before_ = treeOf(fixturesDir);
  assert.ok(before_.length, 'the test is meaningless with an empty store');

  await sweepArtifacts(Date.now() + 365 * 24 * 60 * 60 * 1000);

  assert.deepEqual(treeOf(fixturesDir), before_, 'ARTIFACT_RETENTION_DAYS is not about fixtures');
  assert.deepEqual(
    fs.readFileSync(path.join(fixturesDir, projectId, 'cv.pdf')),
    CV_BYTES,
    'and the bytes are intact, not merely the filename'
  );
});

// --- W7: fixtures are deleted with their project (AC #4) -----------------------

test('deleting a project takes its fixtures, rows and directory with it', async () => {
  const doomed = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug',
      [operatorId, 'doomed', 'doomed']
    )
  ).rows[0];
  await upload(doomed.slug, 'bye.pdf', Buffer.from('bye')).expect(201);
  const dir = path.join(fixturesDir, doomed.id);
  assert.ok(fs.existsSync(dir));

  await request(app).delete(`/api/projects/${doomed.slug}`).set(auth).expect(204);

  assert.ok(!fs.existsSync(dir), 'the directory goes — orphaned bytes are the leak (AC #4)');
  assert.equal(
    (await pool.query('select count(*)::int as n from fixtures where project_id = $1', [doomed.id]))
      .rows[0].n,
    0
  );
  // The other projects' fixtures are emphatically not collateral.
  assert.ok(fs.existsSync(path.join(fixturesDir, projectId, 'cv.pdf')));
});

test('deleting one fixture leaves the others and frees its quota', async () => {
  await upload(projectSlug, 'temp.pdf', Buffer.from('temp bytes')).expect(201);
  await request(app).delete(`/api/projects/${projectSlug}/fixtures/temp.pdf`).set(auth).expect(204);
  assert.ok(!fs.existsSync(path.join(fixturesDir, projectId, 'temp.pdf')));
  assert.ok(fs.existsSync(path.join(fixturesDir, projectId, 'cv.pdf')));
  const list = await request(app).get(`/api/projects/${projectSlug}/fixtures`).set(auth).expect(200);
  assert.equal(list.body.used_bytes, CV_BYTES.length);
});

// --- W8: no fixture bytes in the artifacts (AC #5) -----------------------------

test('fixture bytes reach no event, no report data and no run row', async () => {
  // What this proves and what it does not: the pipeline is handed PATHS, never
  // contents, so there is no code that could copy the bytes — this asserts that
  // property holds end to end rather than by inspection. The filename is
  // deliberately allowed through (it is in the goal, and the story says so).
  const canary = 'QASSIST-FIXTURE-CANARY-a1b2c3';
  const res = await request(app)
    .post(`/api/tests/${testId}/run`)
    .set(auth)
    .send({})
    .expect(200);
  const runId = res.body.runId;
  await drain();
  await new Promise((r) => setTimeout(r, 200)); // let the report renderer land

  const runDir = path.join(artifactsDir, runId);
  for (const rel of treeOf(runDir)) {
    const file = path.join(runDir, rel);
    if (!fs.statSync(file).isFile()) continue;
    assert.ok(
      !fs.readFileSync(file).includes(canary),
      `${rel} contains fixture bytes — AC #5 is about exactly this`
    );
  }

  const steps = await request(app).get(`/api/runs/${runId}/steps`).set(auth).expect(200);
  assert.ok(!JSON.stringify(steps.body).includes(canary));

  const row = (await pool.query('select * from runs where id = $1', [runId])).rows[0];
  assert.ok(!JSON.stringify(row).includes(canary));
  assert.match(row.goal, /cv\.pdf/, 'the NAME travels, which is the whole point of naming it');
});
