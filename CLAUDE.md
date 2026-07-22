# CLAUDE.md

QAssist (formerly QAgent) — goal-based AI browser testing. User gives a URL +
plain-English goal; a Python agent drives real Chromium via browser-use,
streams the session live over WebSocket, judges pass/fail, renders a PDF
report. Deployed on a VPS behind an SSH tunnel. Hosted paid tier planned at
qassist.run.

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

`frontend/src/` splits as: `App.jsx` (shell — token, health, which view, the
settings dialog), `TopBar.jsx` (header + view nav), `RunView.jsx` (a single
run: WS socket, live stage, run/edit dialog) with `SavedTests.jsx`,
`HistoryView.jsx` (past runs: filters, paging, timeline) with `RunDetail.jsx`,
and `LibraryView.jsx` (project/module management) with `Suites.jsx`. Shared
bits live in `api.js` (fetch wrapper + `openReport`) and `status.js`
(status→colour, date/duration formatters). New views land beside these — that
split exists so US-010/US-005 have somewhere to go. Run stays mounted while
hidden (unmounting drops the live WebSocket); History and Library remount,
which is how they refresh.

**UI conventions.** `ui.jsx` holds the shared vocabulary — `Button`
(variant/size, lucide icon), `IconButton`, `Field`, `CardHead`, `EmptyState`,
`Stat`, `PageHeader`, `Modal` — and every view is built from it rather than
from raw `<button>`/`<label>`. Icons come from `lucide-react`, never text
glyphs. `App.css` is one sheet in two halves: tokens + primitives, then
per-view layout; colours, spacing (`--s1`…`--s10`), type sizes (`--t-xs`…
`--t-xl`) and radii always resolve to a token, so the theme is swappable from
`:root` alone. Each view opens with a `PageHeader` carrying its primary
action; creating and editing happen in a `Modal`, and destructive/secondary
row actions hide behind `.row-actions` until the row is hovered or focused.

The palette is near-monochrome by design: one neutral graphite ramp, a single
accent spent only on the primary button, focus and the live pulse, and verdict
colours held below full saturation. Depth comes from hairline borders, not
from gradients or shadows — cards carry neither. A run status renders as a
tinted `.badge-<status>` pill; `statusColor()` in `status.js` is only for the
solid dots and timeline bars, so keep the two in step.

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
- Avoid: microservices, GraphQL, message queues, codegen/DSLs, barrel files,
  abstraction layers "for later".

## Roadmap & docs

- `backlog/` — one file per user story, organized by release folder;
  `release-1/` is current scope, and `release-1/done/` holds the ones already
  shipped, so the release folder itself is the remaining work. Story files
  record design decisions with rationale — read the relevant US-xxx before
  implementing it; when a story is finished, `git mv` it into `done/` and
  update `backlog/README.md` in the same commit.
- `db/README.md` — control-plane schema ground rules.
- `docs/repo-model.md` — open-source vs paid-cloud boundary.

## Run / develop

- Full stack: `cp .env.example .env` then `docker compose up --build` → :8080.
- Dev: `cd server && npm run dev` (hot reload on :8081; loads `../.env`,
  points `PYTHON_BIN` at `agent/.venv`, auto-starts the compose `db` service
  and defaults `DATABASE_URL` to it on :5433); `cd frontend && npm run dev` (Vite
  proxies /api and /ws to :8081). Setup steps: README "Local development". API examples: README.md.
- **Verify server changes:** `cd server && npm test` (node --test + supertest,
  in-process app with stubbed agent/report — no Python/browser needed) and
  `npm run check` (tsc over the JSDoc-typed JS). Run both after editing
  `server/src/`; add a test when adding an endpoint.
- **Verify frontend changes:** `cd frontend && npm run build` (no test suite
  yet). Exercise a new endpoint with `curl` against the dev server on :8081
  before wiring it into a view.
- Report iteration: render against `sample-report.pdf` locally; don't burn
  real runs to tweak the report.

## Workflow rules

- **Never auto-deploy.** Always ask before deploying to the VPS.
- Don't commit or push unless asked. `dev` is the working branch; PRs → `main`.
- Never log or commit secrets; `.env` stays untracked. Bearer token required
  on every API/WS call.
