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

**UI conventions.** `ui.jsx` holds the shared vocabulary — `Button`
(variant/size, lucide icon), `IconButton`, `Field`, `CardHead`, `EmptyState`,
`Stat`, `PageHeader`, `Modal` — and every view is built from it rather than
from raw `<button>`/`<label>`. Icons come from `lucide-react`, never text
glyphs. `App.css` is one sheet in two halves: tokens + primitives, then
per-view layout; colours, spacing, sizes, type steps and radii always resolve
to a token, so the theme is swappable from `:root` alone — the light theme
lives in one `:root[data-theme='light']` block that overrides tokens and
nothing else, and needing a colour there that `:root` doesn't already declare
means some rule is reaching past the tokens. **Dark is the default and the
app's identity**; light is opt-in via the theme select in Settings (Dark /
Light / Match system, stored in `qassist_theme`), never inferred from
`prefers-color-scheme` — App.jsx resolves "Match system" to a concrete
`dark`/`light` so the palette stays written once. Each view opens
with a `PageHeader` carrying its primary action; creating and editing happen
in a `Modal`, and destructive/secondary row actions hide behind `.row-actions`
until the row is hovered or focused.

**Type.** Five steps, and each is a role rather than a nudge: `--t-xs` (11px)
uppercase micro-labels, `--t-sm` (12px) anything secondary to the line above
it, `--t-base` (13px) every primary run of text and every control, `--t-lg`
(16px) a heading or a number worth reading first, `--t-xl` (20px) the page
title alone. A sixth step is almost always the wrong emphasis asked for the
wrong way.

**Spacing.** Every margin, padding and gap is a token — no raw pixels. The
scale is `--s05` (2px) through `--s10` (40px), all multiples of 4 including
the `--s05`/`--s15` half-steps, which exist so component interiors stop
inventing 5/7/9/11px. Three rhythms and only three: `--s2` inside a `.group`,
`--s3` between the blocks of a card, `--s4` between cards and between form
fields. A card sets that distance with `gap` — `.card`, `.suites`,
`.run-detail` and `.group` are flex columns — so **nothing adds `margin-top`
to separate itself from a sibling**; a new block dropped into a card is
spaced correctly by existing there. Dividers inside a card (`.card > .hint`,
`.detail-goal`, `.suites`) are a `border-top` plus `padding-top: var(--s3)`,
the gap above supplying the matching half. Anything one line tall — button,
input, select — is `--ctl` (32px) or `--ctl-sm` (28px), set as a height rather
than padded to it, which is what keeps an input level with the button beside
it. Sticky columns use `--sticky-top`/`--sticky-h`, so they sit one gutter
under the bar like any other card.

**Sizes.** A number that appears in two rules is a measurement and gets a
name; a number that appears once stays a literal with a line saying what set
it. The named ones are `--col-side` (every column flanking the main content —
the Run rail and activity panel, History's detail, the Projects list),
`--rail-strip`, `--scroll-cap` (how tall a list grows inside a card before it
scrolls itself) and `--dot` (status dots). Media-query breakpoints can't read
tokens, so 900px and 1150px each carry a comment saying what they protect.

The palette is near-monochrome by design: one neutral ramp, a single accent
spent only on the primary button, focus and the live pulse, and verdict
colours held below full saturation. That holds in both themes — the ramp
inverts, the constraints don't. Depth comes from hairline borders, not from
gradients or shadows — cards carry neither. A run status renders as a tinted
`.badge-<status>` pill; `statusColor()` in `status.js` maps a status to a
`--fill-*` token for the solid dots and timeline bars, so the two can't drift
and a theme swap carries the dots with it.

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
- **One dev server per port.** `predev` runs `scripts/check-port.mjs` and
  aborts if :8081 is taken, because `node --watch` does *not* exit when its
  child dies of `EADDRINUSE` — it waits for the next file change and restarts.
  A duplicate start therefore becomes a permanent watcher, and every save has
  them racing to bind the port; the winner may hold an older module graph, so
  an edited route goes on 404ing while the file on disk is correct. If a change
  isn't live, look for duplicate watchers (`pstree -sp <pid>`; parent
  `systemd(1)` and TTY `?` = orphaned) before re-reading the code. Kill them by
  PID, npm parents first.
- **Verify server changes:** `cd server && npm test` (node --test + supertest,
  in-process app with stubbed agent/report — no Python/browser needed) and
  `npm run check` (tsc over the JSDoc-typed JS). Run both after editing
  `server/src/`; add a test when adding an endpoint.
- **pg-mem is not Postgres.** The suite runs on it, and it differs in ways that
  make a broken query pass: partial indexes return wrong rows (hence
  `skipIndexes`), array parameters don't bind, and timestamps hold only
  milliseconds — which hid a `where next_run_at = $1` claim that could never
  match a microsecond value real Postgres had written. SQL whose correctness
  depends on the database's own semantics — precision, index behaviour,
  concurrency — needs a real server: `scheduler-postgres.test.js` is the
  pattern, creating and dropping its own database (never a schema inside an
  existing one — the migration runner finds `schema_migrations` through the
  search path and silently adopts the surrounding database) and skipping with a
  reason when none answers.
- **Verify frontend changes:** `cd frontend && npm run build` (no test suite
  yet). Exercise a new endpoint with `curl` against the dev server on :8081
  before wiring it into a view. For visual changes, **ask before screenshotting
  — often it is quicker for me to look myself.** When asked to: `agent/.venv`
  already has Playwright, so a short `sync_playwright` script against the Vite
  port renders the actual views (Chromium, at `device_scale_factor=2`) with
  live data from :8081. Several Vite servers are usually running; start your
  own, note its port, and kill it **by PID** — never `pkill -f vite`.
- Report iteration: render against `sample-report.pdf` locally; don't burn
  real runs to tweak the report.

## Workflow rules

- **Never auto-deploy.** Always ask before deploying to the VPS.
- Don't commit or push unless asked. `dev` is the working branch; PRs → `main`.
- Never log or commit secrets; `.env` stays untracked. Bearer token required
  on every API/WS call.
