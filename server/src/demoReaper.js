// @ts-check
// US-036 step 4 — demo tenant reaper (correctness-critical). Deletes demo users
// past their TTL along with every row and artifact dir they own. The trap it is
// built around: `runs.user_id` is `on delete set null` (001_init.sql:102), so a
// naive `delete from users` orphans the tenant's run rows (user_id → null) and
// leaks their runs/<id>/ dirs forever. So per expiring user we gather run ids,
// rm their dirs, delete the run rows, THEN delete the user (which cascades
// tests/projects/modules/suites/schedules). Completeness is pinned assertion-
// first in demo-reaper-postgres.test.js. Cadence: startDemoReaper() (server.js).
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { ARTIFACTS_DIR } from './config.js';

/** How often the reaper sweeps. TTL is an hour by default, so quarter-hourly is
 * ample and cheap — the sweep only touches already-expired rows. */
const REAP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Delete every demo tenant whose demo_expires_at has passed, and everything they
 * own — rows and on-disk artifact dirs. Idempotent and safe to run concurrently
 * with nothing else (there is a single reaper). Returns what it removed.
 *
 * Order matters: dirs are removed BEFORE the rows, so a crash mid-sweep leaves
 * the run rows in place for the next pass to retry, rather than deleting the
 * rows and stranding their dirs with nothing left to find them by.
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ users: number, runs: number, dirs: number }>}
 */
export async function reapDemoTenants({ now = Date.now() } = {}) {
  const pool = db();
  if (!pool) return { users: 0, runs: 0, dirs: 0 };

  const { rows: expired } = await pool.query(
    'select id from users where demo_expires_at is not null and demo_expires_at <= $1',
    [new Date(now)]
  );

  let users = 0;
  let runs = 0;
  let dirs = 0;
  for (const { id: userId } of expired) {
    const { rows: runRows } = await pool.query('select id from runs where user_id = $1', [userId]);
    for (const { id: runId } of runRows) {
      if (rmRunDir(runId)) dirs++;
    }
    await pool.query('delete from runs where user_id = $1', [userId]);
    runs += runRows.length;
    // Cascade takes tests, projects, modules, suites, suite_tests and schedules.
    await pool.query('delete from users where id = $1', [userId]);
    users++;
  }
  return { users, runs, dirs };
}

/** rm -rf runs/<id>/. Returns whether a dir was actually there to remove. */
function rmRunDir(runId) {
  const dir = path.join(ARTIFACTS_DIR, runId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Start the periodic reaper. Called from server.js only on a demo deployment.
 * Runs once on boot (a restart may have missed sweeps) then on an interval; the
 * timer is unref'd so it never holds the process open.
 */
export function startDemoReaper() {
  const sweep = () =>
    reapDemoTenants().then(
      ({ users, runs, dirs }) => {
        if (users) console.log(`demo reaper: removed ${users} tenant(s), ${runs} run(s), ${dirs} dir(s)`);
      },
      (err) => console.error('demo reaper failed:', err.message)
    );
  sweep();
  const timer = setInterval(sweep, REAP_INTERVAL_MS);
  timer.unref();
  return timer;
}
