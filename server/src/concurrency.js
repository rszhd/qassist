// @ts-check
// Per-user concurrency: the one resolution order, and the cache the run engine
// reads it through (US-028's cap, US-058's per-user override).
//
// Split out of runs.js rather than grown inside it: the engine is long enough,
// and this is a self-contained question — "how many runs may this user have at
// once" — with three answers to rank and one place allowed to rank them.
// runs.js re-exports `getUserConcurrencyCap`, which is where the run engine's
// callers have always imported it from.
//
// Why a cache at all: the three gates that ask (`createRun`'s admission,
// `canStart`, `startNext`'s fair-share scan) are synchronous and run on every
// slot release, so none of them can await a query. The alternative — resolving
// once in the route and stamping the cap onto the run — was rejected because it
// gets the throttling case backwards: a queued run would keep the generous cap
// it was admitted under, so lowering an account's cap would not reach the burst
// that prompted the lowering.
import { db } from './db.js';
import { MAX_CONCURRENT_PER_USER } from './config.js';

/**
 * userId -> their override. Only overridden users are present; absence means
 * "no override", which is also what a cache miss looks like — see
 * getUserConcurrencyCap.
 * @type {Map<string|null, number>}
 */
const overrides = new Map();

/**
 * The concurrent-run cap for a user: their override, else the instance default,
 * else null (uncapped).
 *
 * A miss resolves to the instance default rather than blocking or uncapping. A
 * user this process has not heard of is indistinguishable from a user with no
 * override, which is the safe direction — unlike the billing gate, a start path
 * that forgets to refresh degrades to the instance number, not to no limit.
 * @param {string|null} userId
 * @returns {number | null}
 */
export function getUserConcurrencyCap(userId) {
  return overrides.get(userId) ?? MAX_CONCURRENT_PER_USER;
}

/**
 * Is any per-user cap in force anywhere on this instance?
 *
 * `startNext` branches on this to decide between the plain FIFO drain and the
 * eligibility scan. It must ask "is anything capped" and not "is the env set":
 * an override on an instance with no default is exactly the case the env test
 * would swallow, cap and all. With nothing capped anywhere the FIFO fast path
 * is taken, so the pre-US-028 behaviour is a branch rather than something that
 * merely happens to come out the same.
 */
export function anyCapInForce() {
  return MAX_CONCURRENT_PER_USER != null || overrides.size > 0;
}

/**
 * Write an override into the live resolution. Null removes it — clearing an
 * override returns the user to the instance default, and is not a cap of 0.
 * @param {string|null} userId
 * @param {number|null} cap
 */
export function setUserConcurrencyCap(userId, cap) {
  if (cap == null) overrides.delete(userId);
  else overrides.set(userId, cap);
}

/**
 * Load every override at boot. One query, and only overridden users — the map
 * is a cache of exceptions, not a copy of the users table. Returns how many
 * were loaded (the boot log says so).
 */
export async function loadUserConcurrencyCaps() {
  if (!db()) return 0;
  const { rows } = await db().query(
    'select id, max_concurrent_runs from users where max_concurrent_runs is not null'
  );
  for (const row of rows) setUserConcurrencyCap(row.id, row.max_concurrent_runs);
  return rows.length;
}

/**
 * Re-read one user's override and write it through. This is what makes the
 * operator's write take effect without a restart: `npm run concurrency` runs in
 * its own process and cannot touch this map, so the run-start paths refresh the
 * caller's own cap before admission and a change lands on their next submit.
 *
 * Clearing propagates too — a refresh that only ever raised would leave a
 * lifted throttle in force forever.
 * @param {string|null} userId
 * @returns {Promise<number|null>} the override now in force, or null if none
 */
export async function refreshUserConcurrencyCap(userId) {
  if (!db() || !userId) return null;
  const { rows } = await db().query('select max_concurrent_runs from users where id = $1', [userId]);
  const cap = rows[0]?.max_concurrent_runs ?? null;
  setUserConcurrencyCap(userId, cap);
  return cap;
}

/**
 * Set (or clear, with null) a user's override: the only statement in the
 * codebase that writes `users.max_concurrent_runs`. Writes through to this
 * process's map as well, so a server performing the write needs no reload.
 * @param {string} userId
 * @param {number|null} cap
 */
export async function writeUserConcurrencyCap(userId, cap) {
  const { rowCount } = await db().query(
    'update users set max_concurrent_runs = $2 where id = $1',
    [userId, cap]
  );
  if (rowCount) setUserConcurrencyCap(userId, cap);
  return { updated: !!rowCount };
}

/**
 * A user's override and the cap actually in force for them — what the operator
 * script lists. Ordered by email so the output is stable between runs.
 */
export async function listUserConcurrencyCaps() {
  const { rows } = await db().query(
    `select id, email, max_concurrent_runs
       from users
      where max_concurrent_runs is not null
      order by email`
  );
  return rows;
}
