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
-- Six columns fewer than the first build's, and the absences are the design.
-- There is no `state`, no `archived`, no fingerprint of any kind, no `enabled`
-- and nothing recording a run that went wrong. Each was a rule the system applied
-- to itself, and each took a notebook away for a change that left the app under
-- test exactly where it was. What is left is the notebook, and only a passing run
-- writes it — nothing else takes it away but a person.

create table if not exists test_memory (
  -- One row per test, and the primary key says so. An upsert on conflict is
  -- then the natural write, and two runs of one test finishing together cannot
  -- produce two rows to choose between.
  test_id uuid primary key references tests(id) on delete cascade,

  -- The shape of `learned`. The one thing that can invalidate a notebook without
  -- somebody clicking: a deployment discards an old shape deliberately, by
  -- query, when the generator's sections change under it.
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
