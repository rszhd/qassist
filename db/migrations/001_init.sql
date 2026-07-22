-- 001_init.sql — QAssist control plane, initial schema
-- Covers: US-009 (saved tests), US-010 (scheduling), US-011 (run history),
--         US-012 (email reports), US-005 (BYOK stored keys).
-- Principle (README): the worker stays stateless; the control plane owns all
-- durable state. Artifacts stay on disk under runs/<id>/ — the DB stores
-- metadata and verdicts, not blobs.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- users & auth — minimal multi-user foundation. v1 seeds a single user; the
-- api_keys table replaces the single shared WORKER_API_TOKEN over time.
-- ---------------------------------------------------------------------------

create table users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null unique,
  created_at            timestamptz not null default now(),
  -- BYOK (US-005/US-009): OpenAI key encrypted app-side (AES-256-GCM with a
  -- server secret); never stored or logged in plaintext. Null = use per-request
  -- key or server default.
  openai_key_ciphertext bytea,
  openai_key_updated_at timestamptz
);

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,          -- sha256 hex of the bearer token
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- tests — a saved test is the reusable unit: goal + start_url + settings.
-- Schedule and notification prefs are per-test (one schedule per test), so
-- they live here rather than in separate tables.
-- ---------------------------------------------------------------------------

create table tests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  name             text not null,
  goal             text not null,
  start_url        text not null,
  max_steps        int  not null default 60,
  model            text,                      -- null = server default
  -- US-010: null cron = not scheduled; next_run_at is the scheduler's claim
  -- marker (set on enqueue, so restarts don't double-fire).
  schedule_cron    text,
  schedule_enabled boolean not null default false,
  next_run_at      timestamptz,
  -- US-012
  notify           text not null default 'failure'
                   check (notify in ('failure', 'always', 'never')),
  notify_emails    text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index tests_user_idx on tests (user_id);
create index tests_due_idx on tests (next_run_at)
  where schedule_enabled and schedule_cron is not null;

-- ---------------------------------------------------------------------------
-- runs — replaces the in-memory Map as the source of truth for finished runs
-- (the live relay stays in memory). goal/start_url/max_steps are denormalized
-- from the test at enqueue time so history stays accurate after a test is
-- edited or deleted. id is the server-generated runId (also the runs/<id>/
-- directory name).
-- ---------------------------------------------------------------------------

create table runs (
  id            uuid primary key,
  test_id       uuid references tests(id) on delete set null,
  user_id       uuid references users(id) on delete set null,
  trigger       text not null default 'api'
                check (trigger in ('ui', 'api', 'schedule', 'ci')),
  goal          text not null,
  start_url     text not null,
  max_steps     int  not null,
  model         text,
  -- status values mirror server.js exactly
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'passed', 'failed',
                                  'completed', 'error')),
  success       boolean,                      -- judge verdict; null = none
  final_result  text,                         -- judge rationale
  error         text,
  steps_count   int,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  report_status text not null default 'none'
                check (report_status in ('none', 'generating', 'ready', 'error')),
  has_recording boolean not null default false,   -- US-006
  -- US-011 retention: artifacts (dir) can be pruned before the row is;
  -- non-null means the PDF/recording links are gone but history remains.
  artifacts_deleted_at timestamptz
);

create index runs_test_created_idx on runs (test_id, created_at desc);
create index runs_created_idx on runs (created_at desc);
-- overlap check for US-010 ("skip if previous scheduled run still going")
-- and crash recovery on boot (mark stale queued/running rows as error)
create index runs_active_idx on runs (status)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- notifications — delivery log for US-012. The unique constraint makes
-- sending idempotent: one email per run per recipient, retries update the row.
-- ---------------------------------------------------------------------------

create table notifications (
  id         bigint generated always as identity primary key,
  run_id     uuid not null references runs(id) on delete cascade,
  recipient  text not null,
  status     text not null default 'pending'
             check (status in ('pending', 'sent', 'error')),
  error      text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  unique (run_id, recipient)
);
