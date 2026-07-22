# CLAUDE.md

QAssist (formerly QAgent) — goal-based AI browser testing. User gives a URL +
plain-English goal; a Python agent drives real Chromium via browser-use,
streams the session live over WebSocket, judges pass/fail, renders a PDF
report. Working prototype, deployed on a VPS behind an SSH tunnel. Hosted paid
tier planned at qassist.run.

## Architecture (full details: README.md)

React viewer (`frontend/`) → Express REST + WS relay (`server/src/server.js`)
→ spawns `agent/run_agent.py` per run (NDJSON on stdout: `frame`/`step`/`done`
events, relayed to WS) → on completion `agent/make_report.py` renders the PDF.
Artifacts land in `runs/<runId>/`. `docker compose up` builds one app image
plus a `db` (Postgres) service.

`server/src/` splits as: `server.js` (wiring only), `config.js` (env, read at
import time), `db.js` (pool, migrations, boot seed/recovery), `runs.js` (run
engine + persistence), `routes/{tests,suites,helpers}.js`.

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
  `release-1/` is current scope. Story files record design decisions with
  rationale — read the relevant US-xxx before implementing it, and keep
  `backlog/README.md` in sync when a story changes state.
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
- Report iteration: render against `sample-report.pdf` locally; don't burn
  real runs to tweak the report.

## Workflow rules

- **Never auto-deploy.** Always ask before deploying to the VPS.
- Don't commit or push unless asked. `dev` is the working branch; PRs → `main`.
- Never log or commit secrets; `.env` stays untracked. Bearer token required
  on every API/WS call.
