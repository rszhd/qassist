// @ts-check
// Scheduled runs (US-010). One tick a minute asks the control plane which
// schedules are due, claims each one by advancing its next_run_at, resolves
// its target to a list of tests and hands them to the same batch enqueue the
// HTTP routes use — so a scheduled run queues behind MAX_CONCURRENT_SESSIONS
// exactly like a clicked one.
//
// The worker stays stateless: nothing here is remembered between ticks, so a
// restart loses no schedule and needs no catch-up pass. The first tick after
// boot *is* the catch-up.
import { db } from './db.js';
import { runTests } from './runs.js';
import { isEntitled } from './billing.js';
import { getUserOpenaiKey } from './openaiKey.js';
import { nextSlot } from './schedule.js';
import { OPENAI_API_KEY } from './config.js';

// Fine enough for "within a few minutes of its slot" (the story's acceptance
// criterion) at one indexed query a minute.
const TICK_MS = 60 * 1000;

const COLS =
  'id, user_id, test_id, module_id, suite_id, project_id, kind, interval_hours, hour, minute, weekday, tz, next_run_at';

const TEST_COLS = 'id, goal, start_url, max_steps, model, variables';

/**
 * Resolve a schedule's target to the tests it runs, in the order the matching
 * HTTP route would run them. Which foreign key is set *is* the target type —
 * the table's check constraint guarantees exactly one.
 * @param {any} schedule
 */
async function testsOf(schedule) {
  if (schedule.test_id) {
    const { rows } = await db().query(`select ${TEST_COLS} from tests where id = $1`, [
      schedule.test_id,
    ]);
    return { label: `test ${schedule.test_id.slice(0, 8)}`, tests: rows };
  }
  if (schedule.module_id) {
    const { rows } = await db().query(
      `select ${TEST_COLS} from tests where module_id = $1 order by created_at`,
      [schedule.module_id]
    );
    return { label: `module ${schedule.module_id.slice(0, 8)}`, tests: rows };
  }
  if (schedule.project_id) {
    const { rows } = await db().query(
      `select ${TEST_COLS} from tests where project_id = $1 order by created_at`,
      [schedule.project_id]
    );
    return { label: `project ${schedule.project_id.slice(0, 8)}`, tests: rows };
  }
  const { rows } = await db().query(
    `select t.id, t.goal, t.start_url, t.max_steps, t.model, t.variables
       from suite_tests st join tests t on t.id = st.test_id
      where st.suite_id = $1 order by st.position`,
    [schedule.suite_id]
  );
  return { label: `suite ${schedule.suite_id.slice(0, 8)}`, tests: rows };
}

/**
 * Which of these tests already have a run in flight. A test that is still
 * queued or running is dropped from this slot's batch rather than stacked —
 * but only that test, so one hung member never costs a suite the other nine
 * results (US-010 decision 5).
 * @param {string[]} testIds
 */
async function activeTestIds(testIds) {
  if (!testIds.length) return new Set();
  // Placeholders rather than `= any($1)`: pg-mem (test harness) has no array
  // parameter binding, and the list is one batch long.
  const placeholders = testIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db().query(
    `select distinct test_id from runs
      where status in ('queued', 'running') and test_id in (${placeholders})`,
    testIds
  );
  return new Set(rows.map((r) => r.test_id));
}

/**
 * Claim a due schedule by moving it to its next slot. Returns false when the
 * row moved under us, which is what makes the claim safe to repeat.
 *
 * Claim before firing, deliberately: a crash in between skips one slot, while
 * the other order would re-fire the same slot on every boot — and a run costs
 * real LLM tokens.
 *
 * The guard is "still due", not "unchanged since the select": `nextSlot` is
 * always strictly in the future, so a competing tick that already claimed the
 * row leaves it failing `next_run_at <= now` just as surely. Comparing the
 * timestamp for equality instead would tie the claim to round-trip precision —
 * a `next_run_at` written by Postgres carries microseconds a JS Date cannot
 * hold, and the row would then never be claimable again, silently and forever.
 * @param {any} schedule
 * @param {number} now
 */
async function claim(schedule, now) {
  const next = nextSlot(schedule, now);
  const { rowCount } = await db().query(
    `update schedules
        set next_run_at = $2, last_run_at = $3, updated_at = now()
      where id = $1 and enabled and next_run_at <= $3`,
    [schedule.id, next, new Date(now)]
  );
  return rowCount === 1;
}

/**
 * One pass: fire every schedule whose slot has arrived.
 * @param {number} [now] injectable clock, for tests
 * @returns {Promise<{ fired: number, runs: number, skipped: number, blocked: number }>}
 */
export async function tick(now = Date.now()) {
  if (!db()) return { fired: 0, runs: 0, skipped: 0, blocked: 0 };

  const { rows: due } = await db().query(
    `select ${COLS} from schedules
      where enabled and (next_run_at is null or next_run_at <= $1)
      order by next_run_at`,
    [new Date(now)]
  );

  let fired = 0;
  let runs = 0;
  let skipped = 0;
  let blocked = 0;

  for (const schedule of due) {
    // A row that has never been dated isn't late — it just doesn't know when
    // it fires yet. Date it and wait for that slot.
    if (!schedule.next_run_at) {
      await db().query('update schedules set next_run_at = $2 where id = $1', [
        schedule.id,
        nextSlot(schedule, now),
      ]);
      continue;
    }

    // Nothing else claims schedules today, so a failed claim means something
    // unexpected moved the row — say so rather than skipping in silence, which
    // is how a schedule that never fires stays invisible.
    if (!(await claim(schedule, now))) {
      console.warn(`schedule ${schedule.id.slice(0, 8)}: due but not claimable — slot skipped`);
      continue;
    }

    // Billing (US-022): a lapsed subscriber's schedules stop firing, but are
    // never deleted or disabled. Checked *after* the claim, deliberately — the
    // slot is consumed, so a lapsed month accumulates no backlog that all fires
    // at once on resubscribe. Resubscribing simply resumes at the next slot.
    // A no-op when billing is off: isEntitled() short-circuits to true.
    if (!(await isEntitled(schedule.user_id))) {
      blocked++;
      console.log(
        `schedule ${schedule.id.slice(0, 8)}: owner has no active subscription — slot skipped`
      );
      continue;
    }

    const { label, tests } = await testsOf(schedule);
    if (!tests.length) {
      console.log(`schedule ${schedule.id.slice(0, 8)}: ${label} has no tests — nothing to run`);
      continue;
    }

    const busy = await activeTestIds(tests.map((t) => t.id));
    const ready = tests.filter((t) => !busy.has(t.id));
    skipped += busy.size;
    fired++;
    if (!ready.length) {
      console.log(`schedule ${schedule.id.slice(0, 8)}: ${label} still running — slot skipped`);
      continue;
    }

    // BYOK (US-005): a scheduled run bills the owner's stored key, not the
    // operator's, when they have one; startRun falls back to the server key.
    const storedKey = schedule.user_id ? await getUserOpenaiKey(schedule.user_id) : null;
    const started = runTests(ready, {
      trigger: 'schedule',
      user_id: schedule.user_id,
      openai_api_key: storedKey,
    });
    runs += started.length;
    console.log(
      `schedule ${schedule.id.slice(0, 8)}: ${label} → ${started.length} run(s)` +
        (busy.size ? `, ${busy.size} skipped as still running` : '')
    );
  }

  return { fired, runs, skipped, blocked };
}

/** Tick every TICK_MS, starting now. Unref'd so it never holds the process open. */
export function startScheduler() {
  if (!db()) return null;
  if (!OPENAI_API_KEY) {
    // Every run would fail on its first LLM call; firing them on a timer would
    // just fill the history with identical errors nobody asked for.
    console.warn('scheduler: OPENAI_API_KEY is not set — schedules are stored but will not fire');
    return null;
  }
  const run = () => tick().catch((err) => console.error('scheduler tick failed:', err));
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  return timer;
}
