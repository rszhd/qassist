-- 019_schedule_run_attribution.sql — US-069: which schedule started this run,
-- and which firing of it.
--
-- `runs` carries `trigger in ('ui','api','schedule','ci')` and `test_id` and
-- nothing else, so two schedules pointing at the same test produce runs that
-- are indistinguishable, and a suite schedule's ten runs have nothing tying
-- them into one firing. Both values are already in hand at the tick
-- (`scheduler.js`: `schedule.id` and its injectable `now`), so this threads a
-- value that exists rather than deriving one after the fact.
--
-- Both columns are inert on the day they land, like 013's: existing rows get
-- null, no backfill is correct for them, and the strip on the Schedules page
-- therefore shows nothing until the first tick after deploy. That is one quiet
-- night that reads as a bug if nobody wrote it down.

-- Which schedule. `set null`, not cascade — the same call `runs.test_id`
-- already makes in 001: deleting a schedule must take the strip and leave the
-- history of what that schedule found.
alter table runs
  add column if not exists schedule_id uuid references schedules(id) on delete set null;

-- Which firing. An exact slot timestamp rather than a bucket over
-- `created_at`: a suite's ten runs collapse into one mark by grouping on
-- equality, and a slow enqueue that straddles a second boundary cannot split
-- one slot into two bars. Null on every run no schedule started.
alter table runs
  add column if not exists scheduled_for timestamptz;

-- The strip's only query: newest slots first for a handful of schedule ids.
-- Partial, so it indexes the scheduled runs alone next to a table that is
-- mostly UI runs.
--
-- pg-mem (the route tests) returns wrong rows from a partial index, so the
-- test that proves this one is the real-Postgres suite
-- (`scheduler-postgres.test.js`), not the route suite.
create index if not exists runs_schedule_idx
  on runs (schedule_id, scheduled_for desc)
  where schedule_id is not null;
