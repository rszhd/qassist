# CLAUDE.md

QAssist (formerly QAgent) — goal-based AI browser testing. User gives a URL +
plain-English goal; a Python agent drives real Chromium via browser-use,
streams the session live over WebSocket, judges pass/fail, renders a PDF
report. Self-hosted via Docker. Hosted paid tier planned at qassist.run.

## Architecture (full details: README.md)

React viewer (`frontend/`) → Express REST + WS relay (`server/src/server.js`)
→ spawns `agent/run_agent.py` per run (NDJSON on stdout: `frame`/`step`/`done`
events, relayed to WS) → on completion `agent/make_report.py` renders the PDF.
Artifacts land in `runs/<runId>/`. `docker compose up` builds one app image
plus a `db` (Postgres) service.

`server/src/` splits as: `server.js` (wiring only), `config.js` (env, read at
import time), `db.js` (pool, migrations, boot seed/recovery), `runs.js` (run
engine + persistence), `routes/{runs,tests,suites,projects,modules,helpers}.js`.
`routes/runs.js` is the HTTP surface only — the engine stays `src/runs.js`.
`routes/projects.js` also holds the module query helpers `modules.js` imports.

`frontend/src/` splits as: `App.jsx` (shell — token, health, the routes, the
settings dialog), `TopBar.jsx` (header + view nav), `RunView.jsx` (a single
run: WS socket, live stage, run/edit dialog) with `SavedTests.jsx`,
`HistoryView.jsx` (past runs: filters, paging, timeline) with `RunDetail.jsx`,
`RunPage.jsx` (`/runs/<id>`, rendering that same `RunDetail`), and
`ProjectsView.jsx` (project/module management) with `Suites.jsx`. Shared
bits live in `api.js` (fetch wrapper + `openReport`) and `status.js`
(status→colour, date/duration formatters). New views land beside these — that
split exists so US-010/US-005 have somewhere to go.

**The URL picks the view** (react-router, US-030): `/`, `/history`,
`/schedules`, `/projects`, `/runs/<id>`, and anything else redirects to `/`.
`RunView` is deliberately **outside `<Routes>`**, hidden rather than unmounted —
unmounting drops the live WebSocket and the finished run's result. The routed
views remount, which is how they refresh; History in particular should show the
run you just watched finish. A new linkable thing is a `<Route>`; a new piece
of *live* state that must survive navigation goes outside `<Routes>` like Run.
Express already answers any non-`/api` path with `index.html`, so a new path
needs no server change.

**Visual design — the UI vocabulary, type scale, spacing rhythms, named sizes
and palette — lives in `docs/design-system.md`. Read it before changing
`App.css` or `ui.jsx`, or adding a view.** The rules there are load-bearing:
tokens over raw pixels, `ui.jsx` primitives over raw elements, dark as the
default identity, a near-monochrome palette.

Saved tests can be grouped into a **project**, and within it into at most one
**module**; a **suite** is the many-to-many alternative, scoped to one project.
All three are runnable in one call. Path params take a slug or a uuid.
**Grouping is revealed progressively** in the UI: with no projects the Run view
is exactly the pre-US-023 UI — keep it that way when adding features.

## Design principles

- **Worker is stateless.** Durable state (tests, runs metadata, schedules)
  belongs in the Postgres control plane (`db/`); the live WS relay stays in
  memory. Artifacts stay on disk under `runs/<id>/` — the DB stores metadata
  and verdicts, never blobs.
- **Self-host is always free.** Billing is env-gated: `STRIPE_*` unset = no
  billing UI, no gating. LLM tokens are BYOK on every tier. Feature-placement
  rules: `docs/repo-model.md`.
- **No auth configured = current single-token behavior** (`WORKER_API_TOKEN`).

## Stack decisions (settled — don't relitigate)

- **Express, not NestJS.** Plain JS with `// @ts-check` + JSDoc types; no TS
  build step. Split by feature when files grow (`routes/auth.js`,
  `routes/tests.js`, `db.js`), target ≤~300 lines per file.
- **Raw SQL via `pg`, no ORM.** Schema source of truth is
  `db/migrations/*.sql` (numbered, applied in order). Always parameterized
  queries. Design rationale + ER diagram: `db/README.md`.
- **Auth: magic-link email via Resend, no passwords** (US-021). Signed
  one-time link → HTTP-only session cookie; signup == login.
- Frontend: React 18 + Vite (JSX). Agent: Python + browser-use + Playwright.
- **Code explains itself; comments are the exception.** Spend the effort on
  names and structure instead — a comment restating what the line already says
  is noise that goes stale. Write one only when the code can't carry the
  meaning: a non-obvious *why* (a workaround, an ordering constraint, a
  protocol quirk), or a bare number in a place that can't hold a named token
  (the CSS breakpoints). JSDoc type annotations aren't comments in this sense
  — they're what `npm run check` reads, so keep them.
- Avoid: microservices, GraphQL, message queues, codegen/DSLs, barrel files,
  abstraction layers "for later".

## Roadmap & docs

- `backlog/` — one file per user story, organized by sprint folder;
  `sprint/current/` is current scope, and `sprint/current/done/` holds the ones already
  shipped, so the sprint folder itself is the remaining work. Story files
  record design decisions with rationale — read the relevant US-xxx before
  implementing it; when a story is finished, `git mv` it into `done/` and
  update `backlog/README.md` in the same commit.
- `db/README.md` — control-plane schema ground rules.
- `docs/design-system.md` — UI vocabulary, type/spacing/size tokens, palette.
- `docs/repo-model.md` — open-source vs paid-cloud boundary.
- `docs/testing.md` — testing philosophy: what we test and why, what we skip,
  and how AI-pair authorship changes the risk (and the mitigations).

## Run / develop

- Full stack: `cp .env.example .env` then `docker compose up --build` → :8080.
- Dev: `cd server && npm run dev` (hot reload :8081; loads `../.env`, points
  `PYTHON_BIN` at `agent/.venv`, auto-starts the compose `db` and defaults
  `DATABASE_URL` to it on :5433); `cd frontend && npm run dev` (Vite proxies
  /api and /ws to :8081). Setup + API examples: README "Local development".
- **One dev server per port.** `predev` runs `scripts/check-port.mjs` and aborts
  if :8081 is taken: `node --watch` doesn't exit on its child's `EADDRINUSE` —
  it waits and restarts, so a duplicate becomes a permanent watcher racing to
  bind the port, and the winner may serve a stale module graph (an edited route
  keeps 404ing while the file is correct). If a change isn't live, hunt
  duplicate watchers (`pstree -sp <pid>`; parent `systemd(1)` + TTY `?` =
  orphaned) before re-reading code. Kill by PID, npm parents first.
- **Verify server:** `cd server && npm test` (node --test + supertest,
  in-process app, stubbed agent/report — no Python/browser) and `npm run check`
  (tsc over JSDoc). Run both after editing `server/src/`; add a test per new
  endpoint.
- **pg-mem is not Postgres.** It diverges in ways that let a broken query pass:
  partial indexes return wrong rows (hence `skipIndexes`), array params don't
  bind, timestamps hold only ms (this hid a `where next_run_at = $1` that could
  never match Postgres's microsecond value). SQL whose correctness needs real DB
  semantics (precision, indexes, concurrency) needs a real server —
  `scheduler-postgres.test.js` is the pattern: create/drop its own database
  (never a schema inside an existing DB — the migration runner finds
  `schema_migrations` via the search path and adopts the surrounding database),
  skip with a reason when none answers.
- **Verify agent:** `cd agent && .venv/bin/python -m pytest` (pure stdlib units
  over parsing/extraction — no browser/IMAP/network; `email_codes.py` covered,
  browser core not). Install once: `uv pip install --python .venv/bin/python -r
  requirements-dev.txt`. Add a case per pure helper touched. Sensitivity audit:
  `.venv/bin/mutmut run` then `mutmut results` (config `agent/setup.cfg`) —
  survivors are uncaught mutations; read them, don't chase zero (some are
  equivalent). See `docs/testing.md`.
- **Verify frontend:** `cd frontend && npm test` (Vitest: pure `status.js` units
  in node + jsdom mount-smoke of shell and run-detail — `App.test.jsx`,
  `RunDetail.test.jsx` opt into jsdom per-file so `status.test.js` stays
  DOM-free) and `npm run build`. `curl` a new endpoint against :8081 before
  wiring it into a view. For visual changes, **ask before screenshotting — often
  quicker for me to look myself.** When asked: `agent/.venv` has Playwright, so a
  short `sync_playwright` script against the Vite port renders the real views
  (Chromium, `device_scale_factor=2`) with live :8081 data. Several Vite servers
  usually run; start your own, note its port, kill it **by PID** — never
  `pkill -f vite`.
- Report iteration: render against `sample-report.pdf` locally; don't burn real
  runs to tweak the report.

## Workflow rules

- **Never auto-deploy.** Always ask before deploying to the server.
- **A red test is fixed in the code, not the assertion.** Default: a failure
  caught a real regression — change the implementation until it passes. Editing
  the expected value is legitimate only when the behaviour was *meant* to change,
  and the commit says which and why. Never loosen, delete, or skip an assertion
  to reach green — the test says what the code should do, not the reverse.
- **Assertion-first for correctness-critical, easy-to-get-subtly-wrong pieces**
  (scheduler claim, slot math, redaction, billing gates). There the maintainer
  writes/tightens and reviews the assertion *first*, then the implementation is
  written against it, so the code can't quietly bend the spec — the same-mind
  failure the red-test rule guards, taken one step earlier. Spotting this class
  is **Claude's job, not the maintainer's** — surface the candidate, wait for the
  reviewed assertion, don't assume a piece is ordinary just because it wasn't
  called out. CRUD/wiring stay test-alongside. Known surfaces:
  `backlog/correctness-critical.md` (add a row when new work joins); reasoning:
  `docs/testing.md`.
- Don't commit or push unless asked. `dev` is the working branch; PRs → `main`.
- Never log or commit secrets; `.env` stays untracked. Bearer token required
  on every API/WS call.
