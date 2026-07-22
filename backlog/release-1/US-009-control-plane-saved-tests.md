# US-009 — Control plane: save & reuse tests

**As a** user, **I want** to save a test (URL + goal + settings) and re-run it with one click, **so that** I don't retype goals and can build a regression suite over time.

- **Status:** ✅ Done (2026-07-22) — backend + UI; suite screen deliberately out of scope
- **Priority:** P1 (Release 1) — first control-plane feature; establishes Postgres; foundation for the rest of the release
- **Estimate:** ~2–3 days (includes standing up Postgres + auth model)
- **Depends on:** — (foundation for US-010/011/012 run history, scheduling, email)

## Details

This story introduces the **Postgres control plane** — the first durable state
in the system. The worker stays stateless per run (current design principle);
the control plane owns everything durable.

- Schema (initial): `users`/api keys, `tests` (name, goal, start_url,
  max_steps, model, created_at), `runs` (test_id nullable for ad-hoc, status,
  verdict, timings, artifact paths), `suites` + `suite_tests` (group tests
  for one-shot triggering — needed by US-008 CI integration).
- API: CRUD for tests and suites; `POST /api/tests/:id/run`,
  `POST /api/suites/:id/run` (both accept optional `start_url` override —
  US-008 uses it to target fresh preview URLs).
- UI: saved-test list, run button, edit form.
- Persisting `runs` rows here replaces the in-memory `runs` Map as the source
  of truth for finished runs (live relay stays in memory).
- With US-005 (BYOK): store user keys encrypted, or keep keys per-request.

## Acceptance criteria

- [x] Create/edit/delete a saved test in the UI
- [x] One-click re-run produces a normal run linked to the test (API)
- [x] Saved tests survive server restart (in-memory registry doesn't)

## Progress (2026-07-22)

**Done — backend.** Postgres control plane is live and covered by tests
(`server/test/control-plane.test.js`, 20 tests green, `npm run check` clean).

- `docker compose` gained a `db` service (postgres:16-alpine, healthcheck,
  `pgdata` volume, host `127.0.0.1:5433`). `npm run dev` auto-starts it via a
  `predev` script and defaults `DATABASE_URL` to it — no manual setup.
- Migrations run at boot, tracked in `schema_migrations`. Boot also seeds the
  operator user + an `api_keys` row hashed from `WORKER_API_TOKEN`, and marks
  rows stuck `queued`/`running` as `error` (crash recovery).
- **No `DATABASE_URL` = previous behavior**: ad-hoc runs work, saved-test and
  suite routes answer 503.
- `server.js` was split (it was 377 lines): `config.js`, `db.js`, `runs.js`
  (run engine + persistence), `routes/tests.js`, `routes/suites.js`,
  `routes/helpers.js`. `server.js` is now wiring only.
- Schema change vs the original design: added `suites` + `suite_tests`, which
  US-009 scoped but `001_init.sql` had omitted. Deliberately **no
  `suite_runs`** table — see `db/README.md`.

**API now available to the UI** (all require the bearer token when one is set):

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/tests` | list / create (`name`, `goal`, `start_url`, optional `max_steps`, `model`) |
| GET/PUT/DELETE | `/api/tests/:id` | PUT is a partial update; omitted fields keep their value |
| POST | `/api/tests/:id/run` | optional `start_url` / `max_steps` override → `{runId, testId, status}` |
| GET/POST | `/api/suites` | suite carries `test_ids` (order = run order) |
| GET/PUT/DELETE | `/api/suites/:id` | GET returns full `tests`; PUT replaces membership |
| POST | `/api/suites/:id/run` | one run per member → `{suiteId, runs:[…]}`; 400 if empty |

`GET /api/runs/:id` and the report endpoint now fall back to the DB for runs
the in-memory relay has dropped. `GET /api/health` reports `db`, `auth` and
`agent_ready`.

**Done — frontend.** `App.jsx` now drives the control plane; `vite build`
clean. New files: `api.js` (token-aware fetch wrapper that unwraps the
server's `{ error }` shape) and `SavedTests.jsx` (presentational list).

- Saved-test list sits above the ad-hoc run form in the left column — no
  third column, no tabs. Each row: ▶ run, ✎ edit, ✕ delete. The whole
  section is gated on `health.db`, so a no-Postgres deploy looks exactly
  like it did before.
- **The run form doubles as the editor** rather than adding a second form —
  the 340px column can't carry two. `editing` state: `null` = ad-hoc,
  `{ name }` = create, `{ id, name }` = update. Enter saves while the editor
  is open instead of starting a run.
- Edits send only `name`/`goal`/`start_url`; `max_steps`/`model` aren't in
  the form and PUT is a partial update, so editing never clobbers them.
- `/api/health` is fetched on mount: `agent_ready: false` renders a setup
  banner naming `OPENAI_API_KEY`, and the API-token field hides when
  `auth: false` (kept whenever a token is already in localStorage, so it
  stays clearable).
- Suite UI is **not** part of this story — the API exists for US-008 CI;
  decide separately whether Release 1 needs a suite screen.

**Also landed alongside (first-run / Docker-only experience).** Not part of the
original story; folded in because the control plane added a service to the
stack and the on-ramp had to keep working for non-developer QA users:

- `.env` is now optional in compose (`required: false`), so a fresh clone runs
  with `docker compose up` instead of dying on a missing-file parse error.
- A missing `OPENAI_API_KEY` returns a 503 explaining the fix on every
  run-starting route, instead of failing inside the Python agent ~15s in.
- `WORKER_API_TOKEN` is now blank by default = no auth for local use, with a
  startup warning. Covered by `server/test/first-run.test.js`.
