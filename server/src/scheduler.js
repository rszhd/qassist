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
import { demoMode } from './auth.js';
import { runTests } from './runs.js';
import { sessionsForTests } from './browserSession.js';
import { secretsForTests } from './testSecrets.js';
import { refreshUserConcurrencyCap } from './concurrency.js';
import { runGateFor } from './activation.js';
import { getUserOpenaiKey } from './openaiKey.js';
import { nextSlot } from './schedule.js';

// Fine enough for "within a few minutes of its slot" (the story's acceptance
// criterion) at one indexed query a minute.
const TICK_MS = 60 * 1000;

const COLS =
  'id, user_id, test_id, module_id, suite_id, project_id, kind, interval_hours, hour, minute, weekday, tz, next_run_at';

// The owning project's navigation allowlist rides along with every scheduled
// target too (US-042) — a schedule fires with no human watching, so it is the
// path where an unfenced run would go unnoticed longest.
// `t.name` is here for the schedules route rather than for the tick: US-064's
// save-time refusal names the member it is refusing for, and a schedule with
// eight tests in it is unactionable otherwise.
const TEST_COLS =
  't.id, t.name, t.goal, t.start_url, t.max_steps, t.model, t.variables, p.allowed_domains';
const TEST_FROM = 'tests t left join projects p on p.id = t.project_id';

/**
 * Resolve a schedule's target to the tests it runs, in the order the matching
 * HTTP route would run them. Which foreign key is set *is* the target type —
 * the table's check constraint guarantees exactly one.
 *
 * Exported for `routes/schedules.js`, which asks the same question at SAVE time
 * that this asks at fire time (US-064). Written twice they could disagree about
 * what a schedule would do, which is the drift BUG-006 already cost us once in
 * the target counts.
 * @param {any} schedule
 */
export async function testsOf(schedule) {
  if (schedule.test_id) {
    const { rows } = await db().query(`select ${TEST_COLS} from ${TEST_FROM} where t.id = $1`, [
      schedule.test_id,
    ]);
    return { label: `test ${schedule.test_id.slice(0, 8)}`, tests: rows };
  }
  if (schedule.module_id) {
    const { rows } = await db().query(
      `select ${TEST_COLS} from ${TEST_FROM} where t.module_id = $1 order by t.created_at`,
      [schedule.module_id]
    );
    return { label: `module ${schedule.module_id.slice(0, 8)}`, tests: rows };
  }
  if (schedule.project_id) {
    const { rows } = await db().query(
      `select ${TEST_COLS} from ${TEST_FROM} where t.project_id = $1 order by t.created_at`,
      [schedule.project_id]
    );
    return { label: `project ${schedule.project_id.slice(0, 8)}`, tests: rows };
  }
  const { rows } = await db().query(
    `select ${TEST_COLS}
       from suite_tests st
       join tests t on t.id = st.test_id
       left join projects p on p.id = t.project_id
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
 * It writes `next_run_at` alone. Taking the slot is knowable here; having run
 * is not, since the target is resolved afterwards and can hold nothing — so
 * `last_run_at` is `stampRun`'s to write, once something has actually started
 * (BUG-006). Only `next_run_at` guards the re-fire, so the claim stays one
 * atomic statement and the crash-skip property above is unchanged.
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
        set next_run_at = $2, updated_at = now()
      where id = $1 and enabled and next_run_at <= $3`,
    [schedule.id, next, new Date(now)]
  );
  return rowCount === 1;
}

/**
 * Record that this slot actually started something. Unguarded on purpose: the
 * claim already decided this tick owns the slot, and the only field a
 * competing tick could disagree about is `next_run_at`, which this leaves
 * alone.
 * @param {string} id
 * @param {number} now
 */
async function stampRun(id, now) {
  await db().query('update schedules set last_run_at = $2, updated_at = now() where id = $1', [
    id,
    new Date(now),
  ]);
}

/**
 * One pass: fire every schedule whose slot has arrived.
 * @param {number} [now] injectable clock, for tests
 * @returns {Promise<{ fired: number, runs: number, skipped: number, unstarted: number,
 *                     empty: number, blocked: number, pending: number, keyless: number }>}
 */
export async function tick(now = Date.now()) {
  if (!db())
    return {
      fired: 0,
      runs: 0,
      skipped: 0,
      unstarted: 0,
      empty: 0,
      blocked: 0,
      pending: 0,
      keyless: 0,
    };

  const { rows: due } = await db().query(
    `select ${COLS} from schedules
      where enabled and (next_run_at is null or next_run_at <= $1)
      order by next_run_at`,
    [new Date(now)]
  );

  let fired = 0;
  let runs = 0;
  let skipped = 0;
  // BUG-005: members of a fired schedule that started nothing. Counted apart
  // from `skipped` (a sibling still running from the last slot, which will run
  // again) and from `blocked` (a whole schedule the billing gate declined):
  // this one is a target that is misconfigured today and will not fix itself.
  let unstarted = 0;
  // BUG-006: a target that resolved to no tests at all. Its sibling `unstarted`
  // is a member that was there and would not start; this is a target with no
  // members, which is a misconfiguration rather than a failure — and the only
  // one of these counters whose case leaves no run row for anything else to
  // report.
  let empty = 0;
  let blocked = 0;
  // US-054: claimed but not fired because the owner is still in the activation
  // window. Counted apart from `blocked` — they have paid, and conflating the
  // two would hide a capacity backlog inside a billing statistic.
  let pending = 0;
  let keyless = 0;

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

    // Billing (US-022) and the activation window (US-054): a lapsed
    // subscriber's schedules stop firing, and so do a paid one's until the
    // instance has room for them — but neither is ever deleted or disabled.
    // Both checked *after* the claim, deliberately: the slot is consumed, so a
    // lapsed month or a day of waiting accumulates no backlog that all fires at
    // once the moment it resolves. It simply resumes at the next slot. The
    // whole thing is a no-op when billing is off: runGateFor() short-circuits.
    //
    // This is also the path most likely to be forgotten (a schedule saved
    // before subscribing is otherwise a way around both gates), which is why it
    // asks the same one question the HTTP gate asks.
    const gate = await runGateFor(schedule.user_id);
    if (!gate.allow) {
      const waiting = gate.reason === 'activation';
      if (waiting) pending++;
      else blocked++;
      console.log(
        `schedule ${schedule.id.slice(0, 8)}: ` +
          (waiting
            ? 'owner is waiting for capacity — slot skipped'
            : 'owner has no active subscription — slot skipped')
      );
      continue;
    }

    // BYOK-only (US-039): a scheduled run is funded by its owner's stored key,
    // so an owner without one has nothing to fire. Checked after the claim for
    // the same reason billing is: a keyless month must not accumulate slots
    // that all fire at once the moment a key is stored. Skipping here rather
    // than at boot is what lets one owner's schedules run while another's wait
    // — the old global refusal stopped the ticker for everyone. Waived in demo
    // mode exactly like requireAgentKey: every demo run is a replay, so there
    // is no LLM call for a key to fund.
    let storedKey = null;
    if (!demoMode()) {
      storedKey = await getUserOpenaiKey(schedule.user_id);
      if (!storedKey) {
        keyless++;
        console.log(
          `schedule ${schedule.id.slice(0, 8)}: owner has no OpenAI key — slot skipped`
        );
        continue;
      }
    }

    const { label, tests } = await testsOf(schedule);
    if (!tests.length) {
      empty++;
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

    // The owner's concurrency override, re-read the way the HTTP paths do
    // (US-058). A schedule bypasses admission by design, so this feeds the
    // start gate rather than a refusal: it is what holds a scheduled burst to
    // the owner's own cap instead of the instance default.
    await refreshUserConcurrencyCap(schedule.user_id);

    const started = runTests(ready, {
      trigger: 'schedule',
      user_id: schedule.user_id,
      openai_api_key: storedKey,
      // Sessions are decrypted before the (synchronous) run engine is entered,
      // the same way the HTTP paths do it in runTestsFromRequest (US-043).
      // Nightly refresh is the whole refresh story, so this is the path that
      // matters most: a schedule is what re-runs the login test.
      sessions: await sessionsForTests(ready),
      // And the credential that login test types (US-064). Until this existed
      // the tick passed no variables at all, so the one test that must type a
      // real password every night was the one test a schedule could not fire —
      // and 015's nightly session refresh was a promise nothing kept.
      storedSecrets: await secretsForTests(ready),
    });
    // A member can come back having started nothing, and more than one way:
    // the navigation fence refused it (US-042), or it could not resolve — a
    // required variable with no value (US-035), a session that would not
    // decrypt (US-043). Only a `{ runId }` member is a run, and every other one
    // is named in the log, because a schedule fires with nobody watching: a
    // member that quietly stopped starting is otherwise indistinguishable from
    // a schedule that is working. Partitioned on what a run IS rather than on
    // the marker kinds known today, so the next marker is loud by default.
    const launched = started.filter((m) => 'runId' in m);
    const missing = started.length - launched.length;
    runs += launched.length;
    unstarted += missing;
    // The one thing that makes `last_run_at` true (BUG-006). Same partition the
    // tally uses: a batch where every member was refused started nothing, and a
    // row that says otherwise is the failure nobody can see.
    if (launched.length) await stampRun(schedule.id, now);
    for (const member of started) {
      if ('runId' in member) continue;
      console.warn(
        `schedule ${schedule.id.slice(0, 8)}: test ${member.testId.slice(0, 8)} not started — ` +
          (member.error ?? 'refused with no reason given')
      );
    }
    console.log(
      `schedule ${schedule.id.slice(0, 8)}: ${label} → ${launched.length} run(s)` +
        (busy.size ? `, ${busy.size} skipped as still running` : '') +
        (missing ? `, ${missing} not started` : '')
    );
  }

  return { fired, runs, skipped, unstarted, empty, blocked, pending, keyless };
}

/** Tick every TICK_MS, starting now. Unref'd so it never holds the process open. */
export function startScheduler() {
  if (!db()) return null;
  const run = () => tick().catch((err) => console.error('scheduler tick failed:', err));
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  return timer;
}
