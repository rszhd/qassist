-- 003_schedules.sql — US-010: scheduled runs, as presets over any runnable
-- target. 001_init.sql reserved `schedule_cron` on `tests` before either the
-- UI or US-023's grouping existed; nothing ever read it, and both of its
-- assumptions turned out wrong — the schedule is a preset rather than a cron
-- string (decision 1), and what people schedule is usually a suite or a
-- module, not one test (decision 8). So the columns go and a table arrives.

alter table tests
  drop column schedule_cron,
  drop column schedule_enabled,
  drop column next_run_at;      -- takes tests_due_idx with them

-- A schedule points at exactly one of the four things the API can already run
-- in a single call (routes/helpers.js `runTests`). Four nullable FKs rather
-- than a (target_type, target_id) pair: only real references make the cascade
-- work, so deleting a suite takes its schedules with it instead of leaving
-- rows aimed at nothing. Which column is set *is* the target type — there is
-- no separate discriminator to disagree with it.
create table schedules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  test_id    uuid references tests(id)    on delete cascade,
  module_id  uuid references modules(id)  on delete cascade,
  suite_id   uuid references suites(id)   on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  -- Spelled out rather than num_nonnulls(): pg-mem (test harness) has no such
  -- function, and this form is plain SQL on both.
  constraint schedules_one_target check (
    (case when test_id    is null then 0 else 1 end) +
    (case when module_id  is null then 0 else 1 end) +
    (case when suite_id   is null then 0 else 1 end) +
    (case when project_id is null then 0 else 1 end) = 1
  ),

  -- `hourly` carries an interval so "every 6 hours" is a preset rather than a
  -- reason to reach for cron.
  kind    text not null check (kind in ('hourly', 'daily', 'weekly')),
  -- Divisors of 24 only: slots are anchored to local midnight, so the day's
  -- pattern must repeat identically rather than drift through the clock.
  -- The `is null or` is spelled out on every nullable column: Postgres passes
  -- a check whose result is null, pg-mem (test harness) fails it.
  interval_hours int
      check (interval_hours is null or interval_hours in (1, 2, 3, 4, 6, 8, 12)),
  hour    int not null default 0 check (hour between 0 and 23),
  minute  int not null default 0 check (minute between 0 and 59),
  weekday int check (weekday is null or weekday between 0 and 6),   -- 0 = Sunday
  -- IANA name. "Daily at 02:00" means 02:00 where the user is, and anchoring
  -- the hourly slots to local midnight needs the same information; null =
  -- the server's zone.
  tz      text,

  enabled     boolean not null default true,
  -- The scheduler's claim marker (decision 3): advanced in the same statement
  -- that claims the row, so a crash mid-fire skips a slot rather than
  -- double-firing.
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The tick's only query: due, enabled schedules in slot order.
create index schedules_due_idx on schedules (next_run_at) where enabled;
create index schedules_user_idx on schedules (user_id);
-- Reading a target's schedules back for the UI badge.
create index schedules_test_idx    on schedules (test_id);
create index schedules_module_idx  on schedules (module_id);
create index schedules_suite_idx   on schedules (suite_id);
create index schedules_project_idx on schedules (project_id);
