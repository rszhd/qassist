-- 021_test_memory.sql — US-081: what a test remembers between runs.
--
-- One disposable row per test, deliberately separate from immutable run history:
-- a run is evidence, and this is a working note that is rewritten and thrown
-- away without any of that history changing. `on delete cascade` is the word
-- "disposable" written down — nothing here is worth keeping once its test is
-- gone, and nothing else reads it.
--
-- Inert on the day it lands: no test has a row, and no row means an empty
-- notebook, which is exactly what every existing test has learned so far.
--
-- Five columns fewer than the first build's, and the absences are the design.
-- There is no `state`, no `archived`, no `archive_fingerprint`, no `enabled` and
-- nothing recording a run that went wrong: every one was derivable, served a
-- hand-written half of the notebook that was cut, or punished a test for failing.
-- What is left is one hash and one notebook, and only a passing run touches it.

create table if not exists test_memory (
  -- One row per test, and the primary key says so. An upsert on conflict is
  -- then the natural write, and two runs of one test finishing together cannot
  -- produce two rows to choose between.
  test_id uuid primary key references tests(id) on delete cascade,

  -- The canonical hash of every resolved input the lessons were derived under
  -- (`server/src/testMemory.js`). Two jobs, and both are comparisons rather than
  -- lookups: a run reads it to decide whether the notebook still applies, and
  -- the conditional write checks it so a run that started before an edit cannot
  -- teach the inputs it never ran with.
  fingerprint text not null,
  -- Stored beside the fingerprint rather than folded into it alone, so a
  -- deployment can discard an old learned *shape* deliberately, by query,
  -- without waiting for each test to be edited into a new fingerprint.
  format_version int not null,

  -- The notebook, in the agent's three sections. Provenance is per item — the
  -- run that taught it, when, whether a person hinted it, and the steps it was
  -- read from — because a notebook accumulates and holds lessons from several
  -- runs at once. A row-level stamp would answer "which run taught this?" with
  -- the wrong run for every item but the newest.
  learned jsonb not null default '{}'::jsonb,

  -- When the row was last written. Per-item `learned_at` is what the eviction
  -- backstop reads; this one is for the panel and for a deliberate sweep.
  learned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- What a run was actually given, recorded on the run itself. `memory_used` is
-- the run's own history — cold or memory-assisted — and it is what says whether
-- the run was an independent observer, so it belongs beside the verdict and not
-- in a working note that may be overwritten before anyone reads it.
--
-- False on every existing row, which is what those runs were: nothing had been
-- learned yet, so nothing was supplied.
alter table runs add column if not exists memory_used boolean not null default false;
-- The fingerprint the run started with, which the conditional write compares
-- against. Null on every run from before this shipped.
alter table runs add column if not exists memory_fingerprint text;
