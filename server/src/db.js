// @ts-check
// Postgres control plane (US-009): connection, migrations, boot seed, crash
// recovery. Schema source of truth is db/migrations/*.sql, applied in
// filename order and tracked in schema_migrations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { DATABASE_URL, MIGRATIONS_DIR, OPERATOR_EMAIL, API_TOKEN, AUTH_ENABLED } from './config.js';

/** @type {pg.Pool | null} */
let pool = null;
/** @type {string | null} */
let operatorUserId = null;

/**
 * The user a request is running as (US-021). The gate in server.js opens a
 * store per request; query helpers read currentUserId() instead of threading
 * the id through every signature, so a route can't silently forget to scope and
 * leak another tenant's rows. Outside a request (the scheduler) there is no
 * store — those callers pass the owning user_id explicitly.
 * @type {AsyncLocalStorage<{ userId: string | null }>}
 */
export const userContext = new AsyncLocalStorage();

/** The active pool, or null when no DATABASE_URL is configured. */
export function db() {
  return pool;
}

/**
 * The seeded operator user. Owns everything created before auth existed, and is
 * the sole user whenever auth is off — so it is also the fallback for a request
 * with no user context (auth-off mode, where every request is the operator).
 */
export function getOperatorUserId() {
  return operatorUserId;
}

/**
 * The user the current request is scoped to: the request's store when one is
 * open, else the operator (auth-off mode). This is what user-scoped queries
 * filter on.
 */
export function currentUserId() {
  return userContext.getStore()?.userId ?? operatorUserId;
}

/** @param {string} value */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {string} value */
export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Apply pending migrations. `skipIndexes` exists for the test harness: the
 * schema runs there under pg-mem, whose partial-index support silently
 * returns wrong query results — indexes are performance-only, so tests strip
 * them all.
 * @param {pg.Pool} p
 */
export async function runMigrations(p, { skipIndexes = false } = {}) {
  // Probe-then-create instead of `if not exists`: pg-mem rejects a no-op
  // re-create, and this runs outside any transaction on real Postgres too.
  try {
    await p.query('select 1 from schema_migrations limit 1');
  } catch {
    await p.query(
      `create table schema_migrations (
         filename   text primary key,
         applied_at timestamptz not null default now()
       )`
    );
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const seen = await p.query('select 1 from schema_migrations where filename = $1', [file]);
    if (seen.rowCount) continue;
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (skipIndexes) sql = sql.replace(/create\s+index[^;]*;/gi, '');
    const client = await p.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`db: applied migration ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}

// v1 seeds one user and one api_key hashed from WORKER_API_TOKEN so existing
// clients/CI keep working unchanged (db/README.md).
/** @param {pg.Pool} p */
async function seedOperator(p) {
  let r = await p.query('select id from users where email = $1', [OPERATOR_EMAIL]);
  if (!r.rowCount) {
    r = await p.query('insert into users (email) values ($1) returning id', [OPERATOR_EMAIL]);
  }
  const userId = r.rows[0].id;
  // The shared WORKER_API_TOKEN becomes an operator API key only in single-user
  // mode. With auth on it must stop working (US-021), so it is not seeded — the
  // operator reaches their pre-auth data by requesting a login link for
  // OPERATOR_EMAIL and creates per-user keys through the UI.
  if (API_TOKEN && !AUTH_ENABLED) {
    const hash = sha256(API_TOKEN);
    const k = await p.query('select 1 from api_keys where token_hash = $1', [hash]);
    if (!k.rowCount) {
      await p.query('insert into api_keys (user_id, token_hash, label) values ($1, $2, $3)', [
        userId,
        hash,
        'operator (seeded from WORKER_API_TOKEN)',
      ]);
    }
  }
  return userId;
}

// Any row still queued/running at boot died with the previous process — the
// worker holds no cross-restart state, so nothing can ever finish it.
/** @param {pg.Pool} p */
async function recoverStaleRuns(p) {
  const r = await p.query(
    `update runs
        set status      = 'error',
            error       = coalesce(error, 'server restarted while run was in flight'),
            finished_at = coalesce(finished_at, now())
      where status in ('queued', 'running')`
  );
  return r.rowCount ?? 0;
}

/**
 * Point this module at an existing pool and nothing else — no migrations, no
 * seed, no recovery pass. What a CLI script needs: initDb() also marks every
 * queued/running row as errored, which is the app's job at boot and would kill
 * live runs if a script did it on a box that is serving.
 * @param {pg.Pool} p
 */
export function attachDb(p) {
  pool = p;
  return pool;
}

/**
 * Connect + migrate + seed + recover. Idempotent. Tests inject a pre-migrated
 * pg-mem pool; production connects via DATABASE_URL. Returns null when
 * neither is available (legacy in-memory mode).
 * @param {pg.Pool} [injectedPool]
 */
export async function initDb(injectedPool) {
  if (pool) return pool;
  if (injectedPool) pool = injectedPool;
  else if (DATABASE_URL) pool = new pg.Pool({ connectionString: DATABASE_URL });
  else return null;
  await runMigrations(pool);
  operatorUserId = await seedOperator(pool);
  const stale = await recoverStaleRuns(pool);
  if (stale) console.log(`db: marked ${stale} stale run(s) from a previous boot as error`);
  return pool;
}
