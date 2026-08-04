# US-068 — A module can say who hears about it

**As** someone whose project holds an `auth` module the platform team owns and a
`checkout` module the payments team owns, **I want** notification recipients and
mode settable on the module, **so that** a checkout failure reaches the people
who can fix it instead of everyone who has ever touched the project.

- **Status:** 📋 Planned — raised 2026-08-04.
- **Priority:** P3
- **Estimate:** ~half a day (migration + two columns on the module route + the
  existing dialog made entity-agnostic + tests)
- **Depends on:** [US-012](../sprint/current/done/US-012-email-reports.md) (the
  chain), [US-023](../sprint/current/done/US-023-projects-and-modules.md)
  (modules exist)
- **Interacts with:**
  [US-060](US-060-account-level-notification-prefs.md) — the other missing tier
  in the same chain. Neither blocks the other; see *Ordering* below.

## What exists today

`004_notifications.sql` moved the prefs off `tests` and onto `projects`, and its
own comment states the level rule it was applying: *a recipient list belongs to
the thing a person owns — "mail the checkout team when checkout breaks"*. A
module is exactly that thing. `projects` was the only container that existed
with an owner-shaped meaning at the time and the story stopped there.

So `prefsFor` (`server/src/notify.js:111`) reads the project and nothing between
it and the test:

| tier | source | who can change it |
|---|---|---|
| 1 | `projects.notify_emails` / `projects.notify` | any user, in `NotifyPrefs.jsx` |
| 2 | `NOTIFY_EMAILS` / `NOTIFY_MODE` env | the operator, with a redeploy |
| 3 | the test owner's `users.email` | nobody |

The gap shows up wherever a module already is a first-class target and mail is
not:

- **Schedules target a module** (`003_schedules.sql:23`) — a nightly `checkout`
  schedule mails the project's whole list every night.
- **CI runs a module by slug** — `POST /api/projects/checkout/modules/auth/run`
  is the documented pipeline step (US-008), and its failures are
  indistinguishable, by recipient, from any other run in that project.
- The only way to route a module's mail today is to make it its own project,
  which throws away the grouping it was created for and re-splits its schedules,
  suites and fixtures.

## The decision this story has to make

**The chain becomes module → project → env → owner's email**, most specific
first, and each field falls through *independently*.

Independent fallthrough is the part worth stating, because the alternative is
easy to write by accident. If a module that sets a recipient list also had to
carry a mode, then adding one address to `checkout` would silently re-decide
*when* checkout mails — either dragging its mode down to a default or pinning it
away from a project that later changes its own. Each column answers its own
question and inherits on its own.

**`modules.notify` is nullable, and `projects.notify` stays not-null.** This
looks like an inconsistency and is not. `004_notifications.sql` chose
not-null-with-a-default at the project level on the reasoning that *"two levels
of 'unset' (no project, project says nothing) would both resolve to the same env
default anyway"*. At the module level that reasoning inverts: there is now a
distinct, user-editable answer directly above, so "unset" and "'failure'" mean
different things and the row has to be able to say which.

**Emails keep empty-means-inherit** — no null needed there, matching the project
column and its `'{}'::text[]` shape. A module that wants silence says
`notify = 'never'`; that is the explicit answer, and an empty list stays the
"nothing stated here" one.

## Details

- `0NN_module_notify.sql` (next free number — 018 is taken):
  `modules.notify text` nullable, `modules.notify_emails text[] not null default
  '{}'::text[]`. Both inert on the day they land: a null and an empty array
  resolve to exactly today's chain.
  - Write the check as `notify is null or notify in ('failure','always','never')`
    rather than relying on a bare `in` yielding null for a null. Name it
    explicitly, for the reason 004 records: pg-mem names an inline column check
    `<table>_constraint_N` and leaves it behind on drop, so a check that is only
    droppable by its Postgres name is a trap for whoever edits this next.
  - Keep the `::text[]` cast on the default. Uncast, pg-mem returns the string
    `"{}"` instead of an empty array and the API answers a different shape in
    tests than in production (also 004's note).
- `prefsFor` gains one join: `left join modules m on m.id = t.module_id`, beside
  the `projects` and `users` joins already at `notify.js:115-116`. Still one
  query. Resolution is then `coalesce(m.notify, p.notify, NOTIFY_MODE)` for the
  mode, and first-non-empty of `m.notify_emails`, `p.notify_emails`,
  `NOTIFY_EMAILS`, `[owner_email]` for the list.
- `MODULE_COLS` (`server/src/routes/projects.js:29`) gains both columns, so every
  module read — the nested list, the flat `/api/modules`, the schedule target
  picker — returns them without a second call.
- `PUT /api/modules/:id` accepts `notify` / `notify_emails`, reusing
  `resolveNotify` (`routes/projects.js:178`) and therefore `cleanEmails`
  (`notify.js:34`) unchanged. **Not** on module creation, for US-012's reason:
  creating a thing names it, prefs come after.
- Frontend: `NotifyPrefs.jsx` is project-shaped only in its endpoint and its
  copy. Make it take the entity and its route rather than cloning it — two
  dialogs disagreeing about what a recipient list looks like is the bug this
  avoids. Reached from a `Bell` action on the module row, the way
  `ProjectsView.jsx:264` reaches the project's.
  - Inherited values show as the placeholder, not as pre-filled content, or
    every module that opens the dialog and saves silently pins the project's
    list into itself and stops inheriting.
- `docs/api.md`: the two fields on the module object and on `PUT /api/modules/:id`.
- Suppression is untouched and still wins over every tier: an unsubscribe is
  instance-wide (`email_suppressions`), and a module list must not be a way back
  into a mailbox that opted out.

## Ordering with US-060

The two stories add different rungs to one ladder and touch one function each
way. Whichever lands first, the other slots in without rework — the full chain
is **module → project → account → env → owner's email**, and the account tier
sits below project for the reason US-060 argues (a personal setting must not
override a team one). If they are scheduled together, do them as one change to
`prefsFor` rather than two; if not, the second one's tests should cover the rung
the first one added.

## Acceptance criteria

- [ ] With no module prefs set, every existing resolution is byte-for-byte
      today's — project list, else `NOTIFY_EMAILS`, else the owner's email
- [ ] A module's recipient list is used for runs of tests in that module, and
      the project's list for tests in the same project that are in no module
- [ ] A module list and a project list do not merge — the module's answer
      replaces, it does not append
- [ ] A module that sets only recipients inherits the project's mode; a module
      that sets only a mode inherits the project's recipients
- [ ] `notify = 'never'` on a module silences it while the project keeps mailing,
      including when the project set an explicit list
- [ ] A project set to `never` silences a module that named its own recipients —
      the mode answer is the module's own only if the module stated one
- [ ] A run of a suite spanning two modules mails each test's own module list
- [ ] A scheduled module run and a slug-addressed CI module run resolve the same
      recipients as an in-app run of the same test — the tier is a property of
      the test, not of how the run was started
- [ ] A test moved out of a module (its `module_id` nulled by
      `on delete set null`) resolves to the project tier with no error
- [ ] A suppressed address stays suppressed however it entered the chain
- [ ] Ad-hoc runs still mail nobody
- [ ] `cd server && npm test` covers each rung and the fallthrough between them;
      the migration applies against real Postgres

## Notes

- **Not correctness-critical.** Preference resolution, not secret handling; the
  mail path's sensitive parts (unsubscribe signing, the `(run_id, recipient)`
  idempotent send) are untouched. Same call US-060 made.
- **This does not change one-mail-per-run.** A module run of twenty tests is
  still twenty emails, now possibly to a different list. Digest remains parked
  where US-012 left it — it is a sender change, not a prefs change.
- Suites deliberately get no tier. A test belongs to at most one module, which
  is what makes the module a resolvable answer; a test in three suites would
  need a merge rule and a tie-break, and that is a different story.
