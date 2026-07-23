# US-010 — Scheduled runs

**As a** user, **I want** my saved tests to run automatically on a schedule, **so that** I catch site breakage without anyone pressing a button.

- **Status:** 🚧 In progress — backend done 2026-07-23 (schema, scheduler,
  API); the UI is what's left
- **Priority:** P1 (Release 1)
- **Estimate:** ~1–2 days
- **Depends on:** US-009 (saved tests + Postgres)

## Details

- A schedule (simple presets — see decision 1) on any runnable target — test,
  module, suite or project (decision 8) — stored in Postgres.
- Scheduler in the control plane enqueues runs; respects
  `MAX_CONCURRENT_SESSIONS` via the existing queue (bursts of scheduled tests
  must queue, not stampede the workers).
- Handle overlap: skip if the same test's previous scheduled run is still
  running.
- Pairs with US-012 (email reports) for notify-on-failure.

## Design decisions (2026-07-23)

1. **Presets, not cron.** `schedule_cron` in `001_init.sql` was written before
   the UI existed and is still unused by any code — migration
   `003_schedules.sql` drops it for the preset's parts. A cron string gives no
   feedback until it fires, and validating one plus rendering its next fire
   costs about as much as the whole preset UI. Three kinds, and the hourly one
   carries an interval so "every 3 hours" is a preset rather than a reason to
   reach for cron:

   | kind | fields | fires at |
   |---|---|---|
   | `hourly` | `interval_hours` ∈ {1, 2, 3, 4, 6, 8, 12}, `minute` | local midnight + k×interval + minute |
   | `daily` | `hour`, `minute` | that time, every day |
   | `weekly` | `weekday` (0=Sun), `hour`, `minute` | that time, that day |

   Hourly intervals are **divisors of 24 only**, so the pattern repeats
   identically every day instead of drifting through the clock — anchoring
   the slots to local midnight is what makes "every 6 hours" mean 00/06/12/18
   rather than "6 h after whenever you last saved the test".

2. **Timezone per schedule** (`schedule_tz`, IANA name, defaults to the
   server's). "Daily at 02:00" has to mean 02:00 where the user is, and
   anchoring the hourly slots to local midnight needs the same information.
   DST is handled by computing the next slot in wall-clock terms via `Intl`
   rather than by adding milliseconds.

3. **`next_run_at` is the claim marker** (the one idea 001 got right, moved to
   the new table): computed
   on save and re-computed the moment a run is enqueued, in the same `update
   … where next_run_at <= now() returning` that claims the row. A crash
   between claim and enqueue therefore skips a slot rather than double-firing
   — the safer direction for something that spends money on LLM tokens.

4. **No backfill.** A server that was down for a day fires each due test
   **once** on the next tick, then advances to the next future slot. Replaying
   every missed slot would stampede the queue with results nobody is waiting
   for; firing nothing would hide that the schedule is alive.

5. **Overlap skips the test, not the schedule.** A test with a run already
   `queued` or `running` is dropped from that slot's batch (index
   `runs_active_idx` already exists for exactly this) while its siblings go
   ahead — skipping a whole suite because one member hung would lose the other
   nine tests' results. The schedule advances either way, so a slow test
   settles into "every other slot" instead of building a backlog.

6. **Tick every 60 s**, `setInterval` + `unref`, started from `server.js`
   beside `startRetention()` and only when the process is actually serving.
   That satisfies "within a few minutes of its slot" with one cheap indexed
   query per minute, and it means the boot path needs no separate catch-up
   pass — the first tick is the catch-up.

7. **UI: progressive disclosure.** The schedule control defaults to `Off`; the
   interval/time/day fields appear only once a kind is chosen, and an
   unscheduled test looks exactly as it does today. A row shows its next fire
   time only when there is one.

8. **A schedule targets anything runnable**, not just one test: `tests`,
   `modules`, `suites` and `projects` are all runnable in a single call today
   (`runTests` in `routes/helpers.js`), and "run the regression suite nightly"
   is the case people actually want — a per-test schedule would make them set
   the same time on ten tests and keep the ten in sync by hand. So the
   schedule leaves `tests` and becomes its own table, with **four nullable FKs
   and a check that exactly one is set** rather than a `(target_type,
   target_id)` pair: only real references cascade, so deleting a suite takes
   its schedules with it instead of leaving rows aimed at nothing. Which
   column is set *is* the target type, so there is no discriminator to
   disagree with it. The table also drops the old one-schedule-per-test limit
   — nightly *and* hourly on the same suite is just two rows.

   The scheduler therefore resolves target → tests → `runTests(tests, {
   trigger: 'schedule' })`, which is the same path the HTTP routes take;
   `TRIGGERS` in `helpers.js` already reserved `'schedule'` for it. That batch
   enqueue moved from `routes/helpers.js` to `runs.js` when the scheduler
   arrived — it is engine work, and a non-route module importing it from the
   route layer would have inverted the split CLAUDE.md draws. What stayed
   behind is `runTestsFromRequest`, the thin wrapper that decides which
   trigger an HTTP caller is allowed to claim.

9. **The UI is a dedicated Schedules view** (decided 2026-07-23), a fourth
   top-bar entry beside Run, Library and History rather than a schedule
   control on each target's row. A schedule can point at four different kinds
   of thing, so per-row controls would scatter the same editor across
   `SavedTests`, `Suites` and `ProjectsView` and still leave "what fires
   tonight?" unanswerable without visiting all three. One list ordered by
   `next_run_at` answers it directly. Decision 7's progressive disclosure still
   holds *inside* the editor — kind defaults to `Off`, and each kind's fields
   appear only once it is chosen — and the view itself only appears when the
   control plane is up, like the rest of the nav.

   That flat list has to name its targets, which is what the two read paths
   added ahead of the UI are for: `GET /api/schedules` resolves `target_type`
   (derived from which id column is set — the same fact decision 8 relies on,
   so there is still no discriminator to disagree with) and `target_name` via
   left joins, and `GET /api/modules` lists modules flat with an optional
   `?project_id=`, mirroring `/api/suites`. Without those, rendering one row
   would mean fetching all four collections and joining them in the browser.

## Acceptance criteria

- [ ] A daily-scheduled test runs within a few minutes of its slot
- [ ] Schedules survive restarts
- [ ] A burst of simultaneous schedules queues instead of exceeding the
      concurrency cap
- [ ] "Every 3 / 6 / 12 hours" fires on midnight-anchored slots, unaffected by
      when the schedule was saved
- [ ] A suite or module can be scheduled, and fires one run per member test
- [ ] A test whose previous run is still going is skipped, not stacked, and
      its siblings in the same batch still run
- [ ] Deleting the scheduled test/suite/module/project removes its schedule
