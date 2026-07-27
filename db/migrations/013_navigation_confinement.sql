-- 013_navigation_confinement.sql — US-042: fence where a run's browser may go.
--
-- Two columns, both inert on the day they land. Nobody acquires a fence they
-- did not configure: every project that exists reads as "no allowlist", and
-- every run that exists has no failure_reason. There is deliberately no
-- backfill, because the correct value for existing rows is the default — the
-- opposite of 010, where an absent backfill would have re-walled paying
-- customers on upgrade day.

-- The per-project allowlist. Named for browser-use's BrowserProfile field
-- because that is exactly what it becomes: the value stored here is the value
-- handed to the profile, so the pre-flight check and the in-browser check can
-- never disagree about what a pattern means.
--
-- Not null with a cast empty-array default, for 004_notifications.sql's two
-- reasons. Cast, because pg-mem (the test harness) hands an uncast '{}' back as
-- the *string* "{}" and the API would then answer a different shape there than
-- on a real server — and an allowlist that arrives as a string is an allowlist
-- that matches nothing, which is a fence that is believed and absent. Not null,
-- because two spellings of "no allowlist" (NULL and empty) both resolve to the
-- same behaviour, and one readable state beats two.
alter table projects
  add column if not exists allowed_domains text[] not null default '{}'::text[];

-- Why a run that was fenced needs its own column rather than a sentence in
-- `error`: US-042's acceptance is that a block surfaces "as a failure_reason,
-- not as a crash", and that distinction only exists if something
-- machine-readable survives to the row — CI (US-008) and the report both read
-- the row, not the prose.
--
-- Deliberately NOT part of the status check constraint: a blocked run is
-- `failed`, like any other run that did not meet its goal. An eighth status
-- would ripple through the CI exit codes, History's filters and the US-012
-- mailer for no gain. Null on every ordinary run, which is what keeps a
-- non-null value meaning "the fence fired".
alter table runs
  add column if not exists failure_reason text;
