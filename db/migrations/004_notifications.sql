-- 004_notifications.sql — US-012: one email per finished run.
--
-- 001_init.sql put the notification prefs on `tests`, written before projects
-- existed. Nothing ever read them, and the level turned out wrong the same way
-- 003 found the schedule's was: a recipient list belongs to the thing a person
-- owns — "mail the checkout team when checkout breaks" — not to each of that
-- project's twenty tests, which would mean editing twenty rows to add a
-- colleague. So the columns move to `projects`.
--
-- What is per *run* is the notification itself: every finished run decides on
-- its own whether to mail, and there is no rollup email for a suite or a
-- project run. The `notifications` table from 001 already models that, one row
-- per (run, recipient).

-- The check goes explicitly, and under both engines' names: Postgres calls an
-- inline column check `tests_notify_check` and drops it with the column, while
-- pg-mem (the test harness) calls it `tests_constraint_1` and leaves it behind
-- afterwards — where it then fails every insert, having nothing left to read.
-- `if exists` makes each line a no-op on the engine that uses the other name.
alter table tests drop constraint if exists tests_notify_check;
alter table tests drop constraint if exists tests_constraint_1;

alter table tests drop column notify;
alter table tests drop column notify_emails;

-- Not null with a default rather than nullable-means-inherit: two levels of
-- "unset" (no project, project says nothing) would both resolve to the same
-- env default anyway, and a mode you can read off the row is one you can
-- reason about. A test with no project takes NOTIFY_MODE from the env.
alter table projects add column notify text not null default 'failure';
alter table projects add constraint projects_notify_check
  check (notify in ('failure', 'always', 'never'));
-- Empty = fall back to NOTIFY_EMAILS, then to the owner's account email. The
-- default is cast rather than left as a bare '{}': pg-mem (test harness) hands
-- an uncast one back as the *string* "{}" instead of an empty array, so the
-- API would answer a different shape there than in production.
alter table projects add column notify_emails text[] not null default '{}'::text[];

-- Unsubscribe is instance-wide, not per project (US-012 decision 4): a
-- recipient who opts out of one project's mail has opted out, and being added
-- to a second project must not silently re-subscribe them. Address-keyed, so
-- the row survives the project that mailed them being deleted.
create table email_suppressions (
  email      text primary key,
  created_at timestamptz not null default now()
);
