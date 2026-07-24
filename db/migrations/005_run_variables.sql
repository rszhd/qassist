-- 005_run_variables.sql — US-035: per-run variables (environment overrides).
--
-- A saved test declares named variables; the goal references them as {{name}}.
-- At run creation the user (or CI) overrides any of them, and the resolved
-- values are denormalized onto the run so history stays accurate — the same
-- reason goal/start_url were denormalized in 001. `start_url` remains its own
-- column and override; variables sit alongside it rather than absorbing it.
--
-- Shape (validated in the app, not the DB — jsonb keeps the schema flat, as the
-- denormalize-at-enqueue pattern already does for goal/max_steps):
--   tests.variables : array of declarations
--     [{ "name": "env", "value": "staging", "secret": false, "optional": false }]
--     `value` is the default and may be absent (a CI-injected token has none);
--     `optional` variables may resolve empty, required ones reject at run start.
--   runs.variables  : the resolved map actually used for this run
--     { "env": "prod", "pw": { "secret": true } }
--     A secret's real value is never stored — only a presence marker — so the
--     run row can never leak it (US-035 redaction guarantee).

-- Cast the default rather than leaving it a bare literal: pg-mem (the test
-- harness) hands an uncast default back as the *string* "[]"/"{}", so the API
-- would answer a different shape there than in production. Same reason 004 cast
-- its text[] default.
alter table tests add column variables jsonb not null default '[]'::jsonb;
alter table runs  add column variables jsonb not null default '{}'::jsonb;
