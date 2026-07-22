-- 002_projects_modules.sql — US-023: two levels of structure over saved tests.
-- project (top-level container) → module (partition inside a project: a test
-- belongs to at most one). Suites stay many-to-many but become project-scoped.
-- Both levels are optional for tests: existing rows keep working untouched and
-- surface in the UI's "Ungrouped" bucket (US-023 decision 1).

-- Slugs (decision 8) keep UUIDs out of CI configs: US-008 documents
-- POST /api/projects/checkout/modules/auth/run.

create table projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);

create index projects_user_idx on projects (user_id);

create table modules (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug)
);

create index modules_project_idx on modules (project_id);

-- `on delete set null` on both columns implements decision 5 (deleting a group
-- never deletes tests): dropping a project nulls tests.project_id, and the
-- module cascade nulls module_id.
alter table tests
  add column project_id uuid references projects(id) on delete set null,
  add column module_id  uuid references modules(id)  on delete set null;

create index tests_project_idx on tests (project_id);
create index tests_module_idx  on tests (module_id);

-- Suites become project-scoped (decision 6). Added nullable, backfilled, then
-- constrained, so this is safe whether or not any suites exist. The 'Default'
-- project only materializes for users who already own suites — no project is
-- invented for anyone else.
alter table suites add column project_id uuid references projects(id)
  on delete cascade;

insert into projects (user_id, name, slug)
select distinct s.user_id, 'Default', 'default'
  from suites s where s.project_id is null;

-- No alias on the update target: pg-mem (test harness) can't resolve one in
-- UPDATE ... FROM, and the unaliased form is valid Postgres either way.
update suites set project_id = p.id
  from projects p
 where suites.project_id is null
   and p.user_id = suites.user_id
   and p.slug = 'default';

alter table suites alter column project_id set not null;

create index suites_project_idx on suites (project_id);
