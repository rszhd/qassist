-- 014_project_fixtures.sql — US-048: files a project's tests may upload.
--
-- A fixture is per-project setup data, the same shape as a variable (US-035):
-- a team uploads `cv.pdf` once and every test in the project can attach it.
-- Inert on the day it lands — a project with no fixtures behaves exactly as it
-- did, and no existing row needs a backfill.
--
-- What is NOT here is the point: no bytes. The file lives under
-- FIXTURES_DIR/<project id>/<filename>, deliberately outside runs/<id>/ so
-- ARTIFACT_RETENTION_DAYS never sees it (a customer's fixture must not
-- evaporate a week after they uploaded it), and this table is metadata only —
-- the same rule the design principles state for run artifacts.
--
-- The whitelist handed to the agent as `available_file_paths` is read off that
-- directory at spawn, not assembled from these rows: the thing that decides
-- what a browser may open has to be the thing that actually exists. These rows
-- are what the UI lists and what the quota is counted from.

create table fixtures (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  filename   text not null,

  -- The case-folded, NFC-normalized filename, stored rather than expressed as a
  -- functional unique index for two reasons. A `unique (project_id,
  -- lower(filename))` needs `create unique index`, which the test harness
  -- strips (db.js's skipIndexes) — so the constraint that matters would be
  -- absent in exactly the place the tests run. And lower() is not the fold we
  -- want anyway: the server normalizes to NFC first, because macOS uploads
  -- `Résumé.pdf` decomposed and Linux composed, and those are one file to
  -- everyone except a byte comparison.
  --
  -- Why fold at all: on a case-insensitive volume `CV.pdf` and `cv.pdf` are two
  -- rows and one file, and the row that loses is a fixture whose bytes silently
  -- became another fixture's.
  name_key   text not null,

  size_bytes bigint not null,
  -- What the browser sent. Advisory only — nothing dispatches on it, and the
  -- agent never sees it. Kept so the UI can show a sensible icon and so a
  -- support question about a rejected upload has an answer.
  content_type text,
  created_at timestamptz not null default now(),

  unique (project_id, name_key)
);

create index fixtures_project_idx on fixtures (project_id);
