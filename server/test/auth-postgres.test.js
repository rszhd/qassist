// @ts-check
// The login-link consume, against real Postgres (US-021) — the single-use
// claim under *concurrent* redemption.
//
// auth-isolation.test.js pins the consume logic on pg-mem, but pg-mem's query
// engine is not concurrent: it cannot distinguish an atomic compare-and-swap
// (`update … where used_at is null returning`) from a check-then-update that
// two requests both pass before either writes. A login link redeemed twice is a
// replay — the exact account-takeover the single-use rule exists to stop — so
// the race wants a real server, the same way the scheduler claim does
// (scheduler-postgres.test.js). This asks for one and skips when there isn't.
//
// Isolation: a throwaway database created and dropped here, not a schema inside
// the configured one — the migration runner finds schema_migrations through the
// search path, so a schema-scoped run would adopt the surrounding database.
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
const DB_NAME = `qassist_auth_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
  console.log(`auth-postgres: skipped — ${skip}`);
}

/** @type {typeof import('../src/auth.js')} */
let auth;

before(async () => {
  if (skip || !pool) return;
  process.env.SESSION_SECRET = 'test-session-secret-0123456789';
  const { initDb } = await import('../src/db.js');
  await initDb(pool);
  auth = await import('../src/auth.js');
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = new pg.Pool({ connectionString: CONNECTION });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.end();
});

test('a login link survives exactly one of many concurrent redemptions', { skip }, async () => {
  const { rows: where } = await pool.query('select current_database() as db');
  assert.equal(where[0].db, DB_NAME, 'these writes must land in the throwaway database');

  const token = await auth.createLoginToken('race@example.com');

  // Fire the redemptions at once. A check-then-update consume lets several read
  // used_at IS NULL before any writes it, so more than one would succeed; an
  // atomic claim lets through exactly one.
  const results = await Promise.all(Array.from({ length: 20 }, () => auth.consumeLoginToken(token)));

  const winners = results.filter((r) => r && r.email === 'race@example.com');
  assert.equal(winners.length, 1, 'exactly one redemption may succeed');
  assert.equal(results.filter((r) => r === null).length, 19, 'every other redemption is refused');

  // And it stays used afterward.
  assert.equal(await auth.consumeLoginToken(token), null);
});
