// @ts-check
// US-036 — assertion-first spec for the demo reaper's COMPLETENESS guarantee
// (correctness-critical), against REAL Postgres. An expired demo tenant must
// leave zero rows in every table and zero artifact dirs on disk. The trap this
// pins: `runs.user_id` is `on delete set null` (001_init.sql:102), so a naive
// `delete from users` orphans the tenant's run rows (user_id → null) and leaks
// their runs/<id>/ dirs forever. The reaper must delete run rows + rm their dirs
// explicitly BEFORE deleting the user. pg-mem models neither the cascade nor the
// set-null correctly, so this needs a real server (skips when there isn't one,
// like scheduler-postgres.test.js — the compose `db` service is enough).
//
// Reviewer's job (assertion-first): tighten these BEFORE the implementation.
// The properties they defend:
//
//   P — completeness. After reaping an expired tenant, that user is gone and so
//       is every row it owned across users / projects / modules / tests /
//       suites / suite_tests / schedules / RUNS (queried by run id, not by
//       user_id — the set-null trap would otherwise hide surviving rows), and
//       every runs/<id>/ artifact dir it owned is removed.
//   L — a live (unexpired) demo tenant and any normal (demo_expires_at null)
//       user are untouched — every row and dir survives.
//   T — the trap is real: a plain `delete from users` leaves the run row behind
//       with user_id null and its dir on disk. (Demonstration, not the reaper;
//       proves why P's run-row/dir cleanup is load-bearing.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_reaper_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** @type {pg.Pool | null} */
let pool = null;
/** @type {boolean | string} */
let skip = false;

let artifactsDir = '';
/** @type {(opts?: { now?: number }) => Promise<{ userId: string, expiresAt: Date }>} */
let provisionTenant;
/** @type {(opts?: { now?: number }) => Promise<{ users: number, runs: number, dirs: number }>} */
let reapDemoTenants;

try {
  const admin = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 2000 });
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const url = new URL(CONNECTION);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString() });
} catch (err) {
  skip = `no Postgres at ${new URL(CONNECTION).host} (${err.code || err.message})`;
  console.log(`demo-reaper-postgres: skipped — ${skip}`);
}

before(async () => {
  if (skip || !pool) return;
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-reaper-'));
  process.env.AUTH_MODE = 'demo';
  process.env.SESSION_SECRET = 'demo-session-secret-0123456789';
  process.env.ARTIFACTS_DIR = artifactsDir;

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  ({ provisionTenant } = await import('../src/demoTenant.js'));
  ({ reapDemoTenants } = await import('../src/demoReaper.js'));
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
  if (artifactsDir) fs.rmSync(artifactsDir, { recursive: true, force: true });
});

// --- helpers ---

/** Materialise on-disk artifact dirs for every run a user owns; return the run ids. */
async function makeRunDirs(userId) {
  const { rows } = await pool.query('select id from runs where user_id = $1', [userId]);
  for (const r of rows) {
    const dir = path.join(artifactsDir, r.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'x');
  }
  return rows.map((r) => r.id);
}

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

// --- P: an expired tenant leaves nothing behind ---

test('reaps an expired tenant completely — every table and every artifact dir', { skip }, async () => {
  const { userId } = await provisionTenant({ now: 0 }); // expires 1970 + TTL → already past
  const runIds = await makeRunDirs(userId);
  assert.ok(runIds.length >= 1, 'the seed wrote runs to reap');

  const res = await reapDemoTenants({ now: Date.now() });
  assert.ok(res.users >= 1 && res.runs >= runIds.length, 'reaper reports what it removed');

  assert.equal(await count('select count(*)::int n from users where id=$1', [userId]), 0);
  assert.equal(await count('select count(*)::int n from projects where user_id=$1', [userId]), 0);
  assert.equal(await count('select count(*)::int n from tests where user_id=$1', [userId]), 0);
  assert.equal(await count('select count(*)::int n from suites where user_id=$1', [userId]), 0);
  assert.equal(await count('select count(*)::int n from schedules where user_id=$1', [userId]), 0);
  // Query runs by id, not user_id: the set-null trap would null user_id and hide
  // surviving rows from a user_id filter.
  assert.equal(await count('select count(*)::int n from runs where id = any($1)', [runIds]), 0);
  for (const id of runIds) {
    assert.equal(fs.existsSync(path.join(artifactsDir, id)), false, `dir for ${id} removed`);
  }
});

// --- L: live and normal users are untouched ---

test('leaves a live demo tenant and a normal user untouched', { skip }, async () => {
  const live = await provisionTenant({ now: Date.now() }); // expiry in the future
  const liveRuns = await makeRunDirs(live.userId);

  const { rows: nu } = await pool.query(
    "insert into users (email) values ($1) returning id",
    [`normal-${randomUUID()}@example.com`]
  );
  const normalId = nu[0].id;
  const normalRun = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status)
     values ($1, $2, 'api', 'g', 'https://x', 60, 'passed')`,
    [normalRun, normalId]
  );
  fs.mkdirSync(path.join(artifactsDir, normalRun), { recursive: true });

  await reapDemoTenants({ now: Date.now() });

  assert.equal(await count('select count(*)::int n from users where id=$1', [live.userId]), 1, 'live tenant survives');
  assert.ok(await count('select count(*)::int n from runs where user_id=$1', [live.userId]) >= 1);
  for (const id of liveRuns) assert.equal(fs.existsSync(path.join(artifactsDir, id)), true);

  assert.equal(await count('select count(*)::int n from users where id=$1', [normalId]), 1, 'normal user survives');
  assert.equal(await count('select count(*)::int n from runs where id=$1', [normalRun]), 1);
  assert.equal(fs.existsSync(path.join(artifactsDir, normalRun)), true);
});

// --- T: the set-null trap is real (demonstration, no reaper) ---

test('a naive user delete orphans run rows to null and leaks their dirs', { skip }, async () => {
  const { userId } = await provisionTenant({ now: 0 });
  const { rows } = await pool.query('select id from runs where user_id=$1 limit 1', [userId]);
  const runId = rows[0].id;
  fs.mkdirSync(path.join(artifactsDir, runId), { recursive: true });

  await pool.query('delete from users where id=$1', [userId]); // the WRONG way

  const orphan = await pool.query('select user_id from runs where id=$1', [runId]);
  assert.equal(orphan.rowCount, 1, 'the run row survives the user delete');
  assert.equal(orphan.rows[0].user_id, null, 'orphaned to null — invisible to a user_id sweep');
  assert.equal(fs.existsSync(path.join(artifactsDir, runId)), true, 'and its artifact dir leaks');
});
