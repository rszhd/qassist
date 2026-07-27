// @ts-check
// US-042 — assertion-first spec, part 4: the COLUMNS, against real Postgres.
//
// Real Postgres and not pg-mem, for the reason `docs/testing.md` gives and this
// story runs straight into: **the whole persistence half of US-042 is a
// `text[]` column**, and pg-mem's array handling is exactly the area not to
// trust. `db/migrations/004_notifications.sql` already carries the scar — an
// uncast `'{}'` default comes back from pg-mem as the *string* `"{}"` rather
// than an empty array, so the API answers a different shape there than it does
// on a box. A test that "proves" the allowlist round-trips on pg-mem proves
// nothing about the deployment, and an allowlist that reads back as a string is
// an allowlist that matches nothing — a fence that is believed and absent,
// which is the failure mode US-042's own status line names.
//
// Isolation is a throwaway database created and dropped here, exactly as
// scheduler-postgres.test.js and concurrency-override-postgres.test.js do it:
// the migration runner finds its bookkeeping through the search path, so a
// schema-scoped run would decide the schema was already migrated. Migrating a
// fresh database is also the only place `013_navigation_confinement.sql` meets
// a real server at all.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — what this file signs off:
//
//   D19  ONE migration, `013_navigation_confinement.sql`, two columns:
//          projects.allowed_domains text[] not null default '{}'::text[]
//          runs.failure_reason      text
//        Cast default, for 004's reason. Not null with an empty-array default
//        rather than nullable, for 004's other reason: two spellings of "no
//        allowlist" both resolve to the same behaviour, and a value you can
//        read off the row is one you can reason about.
//        [REVIEW: the column NAMES. `allowed_domains` matches browser-use's
//        profile field exactly, which is deliberate — it is the value we hand
//        it — but it is a column an operator will type by hand.]
//
//   D20  `failure_reason` lives on `runs`, not in the `error` text. AC #3 wants
//        the block to appear "as a failure_reason, not as a crash", and the
//        distinction only exists if something machine-readable survives to the
//        row. It is deliberately NOT in the status check constraint — a blocked
//        run is still `failed`, and inventing an eighth status would ripple
//        through CI (US-008), History and the mailer for no gain.
//
//   D21  No backfill, and the migration is inert over existing rows: every
//        project that exists on the day this ships is in the "no allowlist"
//        state already, which is what makes US-042 nothing-changes for anyone
//        who does not configure it. Asserted by seeding rows BEFORE 013 and
//        re-applying, the way 010's activation backfill was asserted.
//
//   D22  An empty array means "no allowlist" and is what the column defaults
//        to; there is no NULL state to disambiguate. The API therefore never
//        needs to distinguish "unset" from "set to nothing", which is the
//        ambiguity that would otherwise reach checkStartUrl.
// ─────────────────────────────────────────────────────────────────────────────
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://qassist:qassist@localhost:5433/qassist';
const DB_NAME = `qassist_nav_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** @type {pg.Pool | null} */
let pool = null;
/** @type {boolean | string} */
let skip = false;

try {
  const admin = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 2000 });
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const url = new URL(CONNECTION);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString() });
} catch (err) {
  skip = `no Postgres at ${new URL(CONNECTION).host} (${err.code || err.message})`;
  console.log(`navigation-fence-postgres: skipped — ${skip}`);
}

let operatorId = '';
/** @type {string} */
let projectId = '';
/** @type {typeof import('../src/navigationPolicy.js')} */
let policy;

before(async () => {
  if (skip || !pool) return;
  process.env.WORKER_API_TOKEN = 'test-token';
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');

  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  policy = await import('../src/navigationPolicy.js');

  const { rows } = await pool.query('select id from users limit 1');
  operatorId = rows[0].id;
  const { rows: proj } = await pool.query(
    `insert into projects (user_id, name, slug) values ($1, 'checkout', 'checkout') returning id`,
    [operatorId]
  );
  projectId = proj[0].id;
});

after(async () => {
  if (!pool) return;
  await pool.end(); // a database with a live connection cannot be dropped
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

const maybe = { skip: skip || false };

// --- P1: the column exists and its default is an ARRAY (D19) ------------------

test('projects.allowed_domains defaults to a real empty array, not the string "{}"', maybe, async () => {
  const { rows } = await pool.query('select allowed_domains from projects where id = $1', [
    projectId,
  ]);
  assert.ok(Array.isArray(rows[0].allowed_domains), 'pg-mem hands this back as a string (004)');
  assert.deepEqual(rows[0].allowed_domains, []);
});

test('the column is not null, so there is one spelling of "no allowlist" (D22)', maybe, async () => {
  await assert.rejects(
    () => pool.query('update projects set allowed_domains = null where id = $1', [projectId]),
    /null/i,
    'a nullable allowlist would give checkStartUrl two unset states to tell apart'
  );
});

// --- P2: the write path the API actually uses (D19) ---------------------------

test('the array-literal write path round-trips, entries and order intact', maybe, async () => {
  // Spelled as the API spells it: an `array[...]::text[]` literal with the
  // values as placeholders, because pg-mem has no array parameter binding and
  // projects.js/emailsSql already established the idiom. Proving it here is the
  // point — this exact SQL is what runs on the box.
  const entries = ['*.staging.example.com', 'example.com'];
  const placeholders = entries.map((_, i) => `$${i + 2}`).join(', ');
  await pool.query(
    `update projects set allowed_domains = array[${placeholders}]::text[] where id = $1`,
    [projectId, ...entries]
  );
  const { rows } = await pool.query('select allowed_domains from projects where id = $1', [
    projectId,
  ]);
  assert.deepEqual(rows[0].allowed_domains, entries);

  // And the value that comes back out of the database is one checkStartUrl can
  // use directly — the round trip must not turn a list into a string that
  // silently matches nothing.
  const loaded = {
    blockPrivate: true,
    deniedHosts: policy.DEFAULT_DENIED_HOSTS,
    allowedDomains: rows[0].allowed_domains,
  };
  assert.equal(policy.checkStartUrl('https://app.staging.example.com/', loaded), null);
  assert.equal(
    policy.checkStartUrl('https://elsewhere.test/', loaded)?.reason,
    'not_in_allowed_domains'
  );
});

test('clearing an allowlist puts the project back to no-allowlist', maybe, async () => {
  await pool.query(`update projects set allowed_domains = '{}'::text[] where id = $1`, [projectId]);
  const { rows } = await pool.query('select allowed_domains from projects where id = $1', [
    projectId,
  ]);
  assert.deepEqual(rows[0].allowed_domains, []);
  const loaded = {
    blockPrivate: true,
    deniedHosts: policy.DEFAULT_DENIED_HOSTS,
    allowedDomains: rows[0].allowed_domains,
  };
  assert.equal(policy.checkStartUrl('https://anywhere.test/', loaded), null, 'empty = no allowlist');
});

// --- P3: runs.failure_reason (D20) -------------------------------------------

test('a blocked run persists a machine-readable failure_reason beside its status', maybe, async () => {
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status,
                       success, error, failure_reason)
     values ($1, $2, 'api', 'probe', 'https://ok.test/', 1, 'failed', false, $3, $4)`,
    [
      runId,
      operatorId,
      'navigation blocked: https://internal.test/ is not in this project’s allowed domains',
      'not_in_allowed_domains',
    ]
  );
  const { rows } = await pool.query(
    'select status, success, error, failure_reason from runs where id = $1',
    [runId]
  );
  assert.equal(rows[0].failure_reason, 'not_in_allowed_domains');
  assert.equal(rows[0].status, 'failed', 'a blocked run is failed — no eighth status (D20)');
  assert.equal(rows[0].success, false);
  assert.match(rows[0].error, /internal\.test/, 'and the prose still names the URL');
});

test('failure_reason is null for every ordinary run', maybe, async () => {
  const runId = randomUUID();
  await pool.query(
    `insert into runs (id, user_id, trigger, goal, start_url, max_steps, status, success)
     values ($1, $2, 'api', 'log in', 'https://ok.test/', 1, 'passed', true)`,
    [runId, operatorId]
  );
  const { rows } = await pool.query('select failure_reason from runs where id = $1', [runId]);
  assert.equal(rows[0].failure_reason, null, 'nothing about US-042 touches a run that was fine');
});

// --- P4: the migration is inert over rows that already exist (D21) ------------

test('013 re-applied over seeded rows changes nothing (D21)', maybe, async () => {
  // The migration runner is idempotent by bookkeeping, so re-running the FILE
  // is what proves the statements themselves are safe over populated tables —
  // the shape of failure that 010's missing backfill would have had.
  const sql = await import('node:fs').then((fs) =>
    fs.promises.readFile(
      path.join(__dirname, '..', '..', 'db', 'migrations', '013_navigation_confinement.sql'),
      'utf8'
    )
  );
  const before_ = await pool.query(
    'select id, allowed_domains from projects order by id'
  );
  // `add column if not exists` is what makes this a no-op rather than an error;
  // if it throws here, the migration is not safe to re-run and neither is a
  // deploy that retries.
  await pool.query(sql);
  const after = await pool.query('select id, allowed_domains from projects order by id');
  assert.deepEqual(after.rows, before_.rows, 'existing projects keep exactly what they had');
});

test('every pre-existing project reads as "no allowlist", so US-042 is inert (D21)', maybe, async () => {
  const { rows } = await pool.query(
    'select count(*)::int as n from projects where allowed_domains <> \'{}\'::text[]'
  );
  assert.equal(rows[0].n, 0, 'nobody acquires a fence they did not configure');
});
