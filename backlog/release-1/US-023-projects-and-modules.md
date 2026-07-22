# US-023 — Projects & modules (organize saved tests)

**As a** user with many saved tests, **I want** to group them into projects and, within a project, into modules (auth, payment, …), **so that** I can find tests quickly and trigger a whole module from CI.

- **Status:** 🚧 In progress — **backend done** (2026-07-22: migration `002`,
  `routes/projects.js` + `routes/modules.js`, suite project-scoping, test
  filters; `npm test` 28/28 and `npm run check` green). **Frontend outstanding.**
- **Priority:** P1 (Release 1) — pulled ahead of US-006 at the user's request
- **Estimate:** ~2 days (schema + routes ~0.5d; the frontend carries projects,
  modules *and* suite CRUD, which US-009 had deferred)
- **Depends on:** US-009 (control plane)

## Details

US-009 gave us a flat list of saved tests plus suites. This story adds the two
levels of structure that flat list is missing:

- **Project** — the top-level container (one product / one app under test).
  Just a name; nothing else lives on it (see Decisions).
- **Module** — a grouping *inside* a project: `auth`, `payment`, `checkout`.
  Modules exist purely to organize and to be triggered as a unit.

**Module vs suite** — the distinguishing rule: **a test belongs to at most one
module**, so modules form a partition (a taxonomy). A suite is an arbitrary
many-to-many selection, so the same test can sit in several suites
("smoke", "nightly"). Both stay; both are runnable from CI.

```
project (optional)
├── module (optional, one per test)
│   └── test
└── suite ──(many-to-many)── test    ← cuts across modules, not projects
```

## Decisions

1. **Both levels are optional.** `tests.project_id` and `tests.module_id` are
   nullable. Existing tests keep working untouched — no data migration, no
   "Default project" invented on the user's behalf. The UI shows unassigned
   tests in an **Ungrouped** bucket.
2. **A project is just a name.** No `base_url`, no inherited `max_steps` /
   `model` / notify defaults. Rejected because inheritance rules would have to
   be resolved in every read path (run enqueue, report, scheduler) for a
   convenience we have no evidence anyone needs yet. Revisit only when a real
   user asks.
3. **Modules belong to a project** (`modules.project_id NOT NULL`). A module
   without a project has nothing to scope its name against.
4. **The server derives `project_id` from the module.** When a write sets
   `module_id`, the route sets `project_id` to that module's project — so a
   test can never end up in module `auth` of project A while claiming project
   B. One write path, no cross-table CHECK constraint or trigger needed.
   Setting `project_id` alone (no module) is fine.
5. **Deleting a group never deletes tests.** Delete a module → member tests get
   `module_id = NULL` (stay in the project). Delete a project → its modules
   cascade away and member tests go back to Ungrouped.
6. **Suites move inside a project** (revised 2026-07-22; the first draft left
   them global). `suites.project_id` is **NOT NULL**, and a suite may only
   contain tests belonging to its project. Consequences, accepted
   deliberately:
   - A test with no project cannot be in any suite. Grouping is opt-in, but
     once you want *any* of it, a project is the entry point.
   - Creating a suite requires choosing a project first.
   - Deleting a project deletes its suites (cascade) — not its tests, which
     still just go back to Ungrouped per decision 5.
   - Migration backfills existing suites (see below); the suite UI was never
     built in US-009, so in practice there is little or nothing to backfill.
   A suite still cuts across *modules* freely — that is the property that
   makes it a suite and not a module.
7. **Keep the name "suite", don't rename to "tag".** A suite is many-to-many
   like a tag, but that shape isn't what names it — what names it is that you
   *run* it. `POST /api/suites/:id/run` reads right; "run the smoke tag" does
   not. Tags are for filtering; suites are curated, named, triggerable
   collections, and "test suite" is vocabulary every QA/CI user already has
   (US-008's docs lean on it). Rejected cost: ~10 files including public API
   paths, to swap a familiar term for one that describes the data structure
   instead of the use.

8. **Slugs: yes** (decided 2026-07-22). Projects and modules each carry a
   `slug` (lowercase, unique per parent) so CI configs never hold UUIDs:
   US-008 documents `POST /api/projects/checkout/modules/auth/run` rather than
   `POST /api/modules/9f3c…/run`. Costs two columns + a slugify helper.
   Accepted downside: renaming does not re-slug (the slug is generated once at
   create time and then editable on its own), because a rename silently
   breaking a CI config is worse than a slug that drifts from its name.
9. **Progressive disclosure** (decided 2026-07-22). Grouping is opt-in, so a
   user with no projects must see *exactly* today's UI — no empty selectors,
   no placeholder panels. See the UI section for the reveal table.

## Schema (`db/migrations/002_projects_modules.sql`)

```sql
create table projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);

create table modules (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug)
);

alter table tests
  add column project_id uuid references projects(id) on delete set null,
  add column module_id  uuid references modules(id)  on delete set null;

create index tests_project_idx on tests (project_id);
create index tests_module_idx  on tests (module_id);

-- suites become project-scoped (decision 6). Added nullable, backfilled, then
-- constrained, so the migration is safe whether or not suites already exist.
alter table suites add column project_id uuid references projects(id)
  on delete cascade;

insert into projects (user_id, name, slug)
select distinct s.user_id, 'Default', 'default'
  from suites s where s.project_id is null;

update suites s set project_id = p.id
  from projects p
 where s.project_id is null and p.user_id = s.user_id and p.slug = 'default';

alter table suites alter column project_id set not null;

create index suites_project_idx on suites (project_id);
```

The `Default` project only materializes for users who already own suites — no
project is invented for anyone else (decision 1 stands for tests).

Note `on delete set null` on both columns implements decision 5: dropping a
project nulls `tests.project_id`, and the module cascade nulls `module_id`.

`runs` is **not** changed — it already denormalizes goal/start_url at enqueue
time, and run history should stay accurate after a test is re-filed. Filtering
run history by project/module joins through `tests` (best-effort, since
`runs.test_id` is `on delete set null`).

## API

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/projects` | list / create (`name`) |
| GET/PUT/DELETE | `/api/projects/:id` | GET includes `modules` + test counts |
| GET/POST | `/api/projects/:id/modules` | list / create (`name`) |
| PUT/DELETE | `/api/modules/:id` | rename / delete |
| POST | `/api/modules/:id/run` | one run per member test → `{moduleId, runs:[…]}`; 400 if empty |
| POST | `/api/projects/:id/run` | same, every test in the project |
| POST | `/api/suites` | now requires `project_id`; members must be in it (400 otherwise) |
| GET | `/api/suites?project_id=` | existing routes gain the filter |

- `GET /api/tests` gains `?project_id=` / `?module_id=` filters, plus
  `project_id=none` for the Ungrouped bucket.
- `POST /api/tests` and the partial-update `PUT /api/tests/:id` accept
  `project_id` / `module_id` (per decision 4, `module_id` wins).
- Batch running: reuse the suite runner from `routes/suites.js` rather than
  writing a third copy — extract it to `routes/helpers.js` if it doesn't move
  cleanly.
- New file `server/src/routes/projects.js` (modules ride along; splitting into
  a fourth route file isn't worth it at this size — watch the ~300-line rule).

### As built (backend, 2026-07-22) — read this before writing the frontend

Deviations and details the API table above doesn't capture:

- **Routes split two ways.** `routes/projects.js` (297 lines) owns everything
  addressed under a project, including `POST /:project/modules` and the
  slug-addressed `POST /:project/modules/:module/run`; `routes/modules.js`
  owns the id-addressed `PUT`/`DELETE`/`POST /:id/run`. The story predicted
  one file, but it hit 348 lines — over the ~300 target.
- **Every `:project` / `:module` path param takes a uuid *or* a slug.**
- **Renaming never re-slugs.** `PUT` accepts `name` and `slug` independently;
  changing the slug is a deliberate act, since a rename that silently re-slugs
  would break the CI config pointing at it. Collisions get a 400.
- **Create auto-slugs with a numeric suffix on collision** (`checkout`,
  `checkout-2`, …), unique per parent.
- **Moving a test to a project clears its module** unless `module_id` is sent
  in the same write. One predictable rule beat a conditional that depends on
  the row's previous state (the old module may belong to another project).
  Send both when the UI knows both.
- **`POST`/`PUT /api/tests` accept `project_id` / `module_id`**; `module_id`
  wins and derives `project_id` (decision 4). `project_id: null` clears both.
- **A suite's project is immutable.** `PUT /api/suites/:id` won't move one —
  membership is scoped to the project, so a move would invalidate every member
  at once. Delete and recreate.
- **Counts come back on the list endpoints**: `GET /api/projects` returns
  `test_count` + `module_count` per project; module lists return `test_count`.
- **pg-mem constraint** (test harness, not Postgres): no correlated subquery
  against an outer alias, and no alias on an `UPDATE` target. Both are worked
  around in `002` and `projects.js` — keep new queries within that envelope or
  the tests will fail while real Postgres is fine.

## UI

**Layout decided 2026-07-22: two views — `Run` (default) and `Library` — with
grouping revealed progressively.**

`Run` is the landing view and keeps today's shape: saved-test list + run/edit
form in the 340px column, live viewer beside it. `Library` is a full-width
view holding all project / module / suite management. Rationale: a first-time
user should be able to type a URL and a goal and watch it run without meeting
a single organizational concept. Empty containers ("Project: none", an empty
module tree) cost attention and teach nothing, so nothing about grouping
renders until the user creates a project.

What the `Run` view reveals, and when:

| User state | Run view shows |
|---|---|
| No projects | Exactly today's UI — no selector, no headers |
| ≥1 project | Project filter above the saved-test list (`All` / `Ungrouped` / each project) |
| ≥1 module in the selected project | Module group headers in the list, each with a ▶ that runs the module |
| Editing a test | Project + module pickers in the form — only once a project exists |

`Library` holds create/rename/delete for projects and modules, and the full
suite UI (**in scope**, reversing the US-009 deferral): create, rename,
delete, edit membership via a multi-select over the project's tests, and run.
Suites live under their project (decision 6). Running a suite is also
reachable from `Run`; *editing* one is Library-only, which is what gives the
membership multi-select the width it needs — the constraint that made
squeezing this into 340px unattractive.

Accepted risk: a second view makes grouping discoverable but ignorable, and
some users who'd benefit will never open Library. Preferred over nudging.

`App.jsx` is already 424 lines against CLAUDE.md's ~300-line target, so this
story splits it into view components (`RunView`, `LibraryView`) rather than
growing it. US-010 (scheduling), US-011 (history) and US-005 (settings) each
need somewhere to live later; this split is where they land, which is part of
why it's worth paying for now rather than three more times.

## Acceptance criteria

Backend (done 2026-07-22):

- [x] Assign a test to a project and to at most one module; unassigning works
- [x] `POST /api/modules/:id/run` starts one run per member test and returns
      the run ids (the CI-facing behavior US-008 will document), plus the
      slug form `POST /api/projects/:slug/modules/:slug/run` and a
      whole-project `POST /api/projects/:id/run`
- [x] Deleting a module or project leaves its tests intact (a project delete
      does take its suites with it)
- [x] Creating a suite requires a project; adding a test from another project
      (or an ungrouped one) is rejected with a 400 — on create *and* on
      membership edit
- [x] `GET /api/tests` filters by `?project_id=` / `?module_id=`, with
      `project_id=none` for Ungrouped
- [x] Existing tests (no project, no module) behave exactly as before
- [x] `npm test` + `npm run check` green; new endpoints covered by tests

Frontend (outstanding — separate session):

- [ ] Create / rename / delete a project in the UI
- [ ] Create / rename / delete a module within a project
- [ ] Saved-test list filters by project, groups by module, shows Ungrouped
- [ ] Create / rename / delete a suite in the UI, edit its membership, and run
      it — membership choices are limited to the suite's project
- [ ] With zero projects, the Run view is visually identical to pre-US-023 —
      no project selector, no module headers, no pickers in the form

## Impact on other stories

- **US-008 (CI trigger)** — documents module triggering alongside suites;
  depends on the slug decision above.
- **US-010 (scheduling)** — unchanged (schedules stay per-test). Scheduling a
  whole module is a plausible follow-up; explicitly out of scope here.
- **US-011 (run history)** — can filter by project/module via the `tests` join.
