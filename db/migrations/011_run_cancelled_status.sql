-- 011_run_cancelled_status.sql — US-047: a run can be stopped, and a stopped
-- run is not a failure.
--
-- `cancelled` is a terminal status of its own rather than a flavour of `error`
-- or `failed`. The distinction is load-bearing downstream: US-008's pipeline
-- step gates the build on `passed` and fails it on anything else, and US-012
-- mails a failure — so filing a deliberate stop under either of those turns
-- "I ended this myself" into a red build and an alert. It is not `completed`
-- either: that means the agent ran out of steps without reaching a verdict,
-- which is a fact about the run, not about the person watching it.
--
-- The check has to move before the status can be written at all — an
-- unmigrated instance fails the insert rather than storing an unknown value,
-- which is exactly what a check constraint is for and exactly why this file
-- exists.
--
-- Dropped under both engines' names, as 004 does: Postgres calls an inline
-- column check `runs_status_check`, while pg-mem (the test harness) numbers
-- them per table in declaration order and calls this one `runs_constraint_2`
-- (1 is `trigger`, 3 is `report_status`). `if exists` makes each line a no-op
-- on the engine that uses the other name. The ordinal was confirmed against
-- pg-mem rather than assumed — get it wrong and the old check survives there,
-- silently rejecting every cancelled run in the test suite only.
alter table runs drop constraint if exists runs_status_check;
alter table runs drop constraint if exists runs_constraint_2;

alter table runs add constraint runs_status_check
  check (status in ('queued', 'running', 'passed', 'failed', 'completed',
                    'error', 'cancelled'));

-- `runs_active_idx` (001) covers status in ('queued', 'running') and is
-- deliberately untouched: a cancelled run is finished, so it belongs in
-- neither the scheduler's overlap check nor boot's stale-run recovery.
