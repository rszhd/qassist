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

`frontend/src/` splits as: `App.jsx` (shell — token, health, routes, settings
dialog), `TopBar.jsx` (header + view nav), `RunView.jsx` (a single run: WS
socket + live stage) with `SavedTests.jsx`, its dialogs in `RunDialogs.jsx`
(`TestDialog`/`RunVarsDialog`) and pure helpers in `runHelpers.js`,
`HistoryView.jsx` (past runs) with `RunDetail.jsx`, `RunPage.jsx` (`/runs/<id>`,
same `RunDetail`), `ProjectsView.jsx` with `Suites.jsx`. Shared bits: `api.js`
(fetch wrapper + `openReport`) and `status.js` (status→colour, formatters). New
views land beside these.

**The URL picks the view** (react-router, US-030): `/`, `/history`,
`/schedules`, `/projects`, `/runs/<id>`, else redirect to `/`. `RunView` is
deliberately **outside `<Routes>`**, hidden not unmounted — unmounting drops the
live WebSocket and the finished run's result; routed views remount, which is how
they refresh. A new linkable thing is a `<Route>`; new *live* state that must
survive navigation goes outside `<Routes>` like Run. Express serves `index.html`
for any non-`/api` path, so a new path needs no server change.

**Before changing `App.css`/`ui.jsx` or adding a view, read
`docs/design-system.md`** — the UI vocabulary, type/spacing/size tokens and
palette. Load-bearing: tokens over raw pixels, `ui.jsx` primitives over raw
elements, dark as the default identity, a near-monochrome palette.

Saved tests group into a **project**, and within it at most one **module**; a
**suite** is the many-to-many alternative, scoped to one project. All three are
runnable in one call; path params take a slug or a uuid. **Grouping is revealed
progressively**: with no projects the Run view is exactly the pre-US-023 UI —
keep it that way when adding features.

## Design principles

- **Worker is stateless.** Durable state (tests, runs metadata, schedules) lives
  in the Postgres control plane (`db/`); the live WS relay stays in memory.
  Artifacts stay on disk under `runs/<id>/` — the DB stores metadata and
  verdicts, never blobs.
- **Self-host is always free.** Billing is env-gated: `STRIPE_*` unset = no
  billing UI, no gating. LLM tokens are BYOK on every tier. Placement rules:
  `docs/repo-model.md`.
- **No auth configured = current single-token behavior** (`WORKER_API_TOKEN`).

## Stack decisions (settled — don't relitigate)

- **Express, not NestJS.** Plain JS with `// @ts-check` + JSDoc types; no TS
  build step. Split by feature when files grow, target ≤~300 lines per file.
- **Raw SQL via `pg`, no ORM.** Schema source of truth is `db/migrations/*.sql`
  (numbered, applied in order). Always parameterized. Rationale + ER diagram:
  `db/README.md`.
- **Auth: magic-link email via Resend, no passwords** (US-021). Signed one-time
  link → HTTP-only session cookie; signup == login.
- Frontend: React 18 + Vite (JSX). Agent: Python + browser-use + Playwright.
- **Code explains itself; comments are the exception.** Spend the effort on
  names and structure. Write a comment only for a non-obvious *why* (workaround,
  ordering constraint, protocol quirk) or a bare number that can't hold a named
  token (CSS breakpoints). JSDoc annotations aren't comments — `npm run check`
  reads them, keep them.
- Avoid: microservices, GraphQL, message queues, codegen/DSLs, barrel files,
  abstraction layers "for later".

## Roadmap & docs

- `backlog/` — one file per user story by sprint folder; `sprint/current/` is
  current scope, `sprint/current/done/` the shipped ones, so the folder itself
  is the remaining work. Read the relevant US-xxx before implementing it; when
  finished, `git mv` it into `done/` and update `backlog/README.md` in the same
  commit.
- `db/README.md` — control-plane schema ground rules.
- `docs/design-system.md` — UI vocabulary, type/spacing/size tokens, palette.
- `docs/repo-model.md` — open-source vs paid-cloud boundary.
- `docs/testing.md` — testing philosophy, and the pg-mem/mutmut details below.

## Run / develop

- Full stack: `cp .env.example .env` then `docker compose up --build` → :8080.
- Dev servers: `cd server && npm run dev` (:8081) and `cd frontend && npm run
  dev` (Vite proxies /api, /ws). Setup details: README "Local development".
- **One dev server per port.** `predev` aborts if :8081 is taken; `node --watch`
  survives `EADDRINUSE`, so a duplicate becomes a stale-serving watcher racing to
  bind. If a change isn't live, hunt duplicate watchers and kill by PID (npm
  parents first) before re-reading code.
- **Verify server:** `cd server && npm test` (node --test + supertest,
  in-process, stubbed agent/report) and `npm run check` (tsc over JSDoc). Both
  after editing `server/src/`; add a test per new endpoint.
- **pg-mem is not Postgres** — it passes broken SQL (partial indexes return
  wrong rows, array params don't bind, timestamps lose precision). SQL whose
  correctness needs real DB semantics gets a real server;
  `scheduler-postgres.test.js` is the pattern. Full details: `docs/testing.md`.
- **Verify agent:** `cd agent && .venv/bin/python -m pytest` (pure stdlib units,
  no browser/IMAP/network). Add a case per pure helper touched. Mutation audit
  (`mutmut`) and rationale: `docs/testing.md`.
- **Verify frontend:** `cd frontend && npm test` (Vitest) and `npm run build`.
  `curl` a new endpoint against :8081 before wiring it into a view. For visual
  changes, **ask before screenshotting — often quicker for me to look myself.**
- Report iteration: render against `sample-report.pdf` locally; don't burn real
  runs to tweak the report.

## Workflow rules

- **Never auto-deploy.** Always ask before deploying to the server.
- **A red test is fixed in the code, not the assertion.** A failure caught a
  real regression — change the implementation until it passes. Editing the
  expected value is legitimate only when the behaviour was *meant* to change, and
  the commit says which and why. Never loosen, delete, or skip an assertion to
  reach green.
- **Assertion-first for correctness-critical, easy-to-get-subtly-wrong pieces**
  (scheduler claim, slot math, redaction, billing gates): the maintainer
  writes/reviews the assertion *first*, then the implementation is written
  against it. Spotting this class is **Claude's job** — surface the candidate and
  wait for the reviewed assertion; don't assume a piece is ordinary. CRUD/wiring
  stay test-alongside. Known surfaces: `backlog/correctness-critical.md` (add a
  row when new work joins); reasoning: `docs/testing.md`.
- Don't commit or push unless asked. `dev` is the working branch; PRs → `main`.
- Never log or commit secrets; `.env` stays untracked. Bearer token required on
  every API/WS call.
