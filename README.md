# QAssist

**Goal-based, adaptive browser testing you can watch run live.** Give it a URL and
a plain-English goal; an AI agent drives a real Chromium browser like a user,
streams the session live, decides pass/fail, and produces a shareable PDF report.

> Status: **working prototype.** Runs end-to-end and is deployed on a VPS. See
> [Roadmap](#roadmap) for what's intentionally left for later.

## What it does

- **Goal-based testing** — no selectors or scripts. Describe the goal in English;
  the agent figures out the steps and adapts if the UI changes.
- **Watch it live** — a real-time CDP screencast of the browser streams to the UI
  over a WebSocket while the test runs.
- **Pass/fail verdict** — browser-use's built-in judge decides whether the goal
  was actually met, with a written rationale.
- **PDF report** — a polished one-page report (verdict, stats, summary, session
  recording link) is generated automatically when a run finishes.
- **Trigger from anywhere** — token-authed REST API to start runs and fetch
  results from your own tools or pipelines.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite (live viewer) |
| API | Express — REST + WebSocket relay |
| Agent | Python + [browser-use](https://github.com/browser-use/browser-use) driving Playwright Chromium |
| Report | HTML → PDF rendered by the same Chromium (embedded Bricolage Grotesque + IBM Plex Mono) |
| Model | OpenAI (default `gpt-4.1`) |
| Packaging | Single Docker image, `docker compose up` |

## How it works

```
┌──────────────┐   POST /api/runs    ┌──────────────────────────────┐
│ React viewer │ ──────────────────▶ │ Express (server/)            │
│ (frontend/)  │ ◀── WS /ws ──────── │  • spawns the Python agent   │
└──────────────┘   frames + events   │  • relays NDJSON → WebSocket │
                                      │  • renders PDF on completion │
                                      └───────────────┬──────────────┘
                                          spawn (1 per run) │ stdout: NDJSON
                                                            ▼
                                      ┌──────────────────────────────┐
                                      │ agent/run_agent.py           │
                                      │  • browser-use + Chromium    │
                                      │  • CDP screencast → "frame"  │
                                      │  • per-step → "step" events  │
                                      │  • final verdict → "done"    │
                                      └──────────────────────────────┘
```

Express spawns `agent/run_agent.py` as a child process per run. The script prints
newline-delimited JSON to stdout — `frame` events (JPEG screencast, ~6 fps) plus
`step`/`done` events — which Express relays over the WebSocket. The screencast is
viewer-gated: Express tells the agent over stdin when the first viewer attaches
and the last one leaves, and frames are only captured in between, so unwatched
runs (e.g. CI-triggered) skip the encode cost entirely. On completion the server
calls `agent/make_report.py` to render the PDF. The worker holds no durable
state between runs.

## Project layout

```
agent/                Python agent + report renderer
  run_agent.py        runs one browser-use test, emits NDJSON to stdout
  make_report.py      renders a run's JSON into a PDF (via Chromium)
  fonts/              embedded woff2 fonts (self-contained PDFs)
  requirements.txt
server/
  src/server.js       Express REST API + WebSocket relay + run registry
frontend/             React + Vite UI — Run view (live viewer) and Library
Dockerfile            multi-stage: builds frontend, bundles Node + Python + Chromium
docker-compose.yml
.env.example
```

## Run it

**Docker is the only thing you need installed** — Node, Python and Chromium all
live inside the image. Clone the repo, then:

```bash
cp .env.example .env      # add your OPENAI_API_KEY
docker compose up --build
```

The first build takes a few minutes (it downloads Chromium). Then open
`http://localhost:8080`, enter a URL + goal, and watch it run. Finished runs
expose a **Download PDF report** button.

Two things worth knowing on a fresh clone:

- **`OPENAI_API_KEY` is the one value you must supply.** The agent is
  bring-your-own-key. Without it the app still starts and the UI loads, but
  starting a run answers `503` telling you the key is missing — set it in
  `.env` and `docker compose up -d` to pick it up.
- **`WORKER_API_TOKEN` is optional for local use.** Leave it unset and the API
  needs no token, so there's nothing to paste into the UI. The server logs a
  warning at startup because this leaves the port open to your network — set a
  token before exposing it beyond localhost.

Everything else, including the Postgres control plane, is wired up by
`docker compose`; there is nothing else to configure.

## Configuration

Set in `.env` (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_API_TOKEN` | — | Bearer token required on every API/WS call |
| `OPENAI_API_KEY` | — | Drives the browser agent |
| `BROWSER_USE_MODEL` | `gpt-4.1` | OpenAI model |
| `MAX_CONCURRENT_SESSIONS` | `4` | Concurrent browser cap — the real throttle. Rule: `floor((RAM_GB − 1.5) / 1)` |
| `MAX_STEPS` | `60` | Safety ceiling on agent steps per run |
| `MAX_RUN_MEMORY_MB` | `1600` | Per-run process-tree RSS cap; over it the run is killed and marked failed. Summed RSS double-counts Chromium's shared pages — a recording run measures ~1177 MB here but only ~660 MB PSS (US-024) |
| `PORT` | `8080` | Express listen port |
| `QA_RECORD` | `1` | Record every session to `runs/<runId>/recording.mp4`. `0` disables it — frame capture is then skipped entirely while nobody is watching the run |
| `ARTIFACT_RETENTION_DAYS` | `7` | How long `runs/<runId>/` (report PDF + mp4 recording) is kept. Swept at startup and every 6 h; the history row and its verdict are kept forever regardless. `0` = never prune |
| `PUBLIC_BASE_URL` | — | Public address of this instance (`https://qa.example.com`). Only used to make the PDF report's "View recording" link resolvable; the recording is served either way |
| `DATABASE_URL` | — | Postgres control plane (saved tests, suites, run history). Set for you in both paths — `docker compose` points it at its own `db` service, `npm run dev` at the same container on `localhost:5433`. Unset = in-memory mode: ad-hoc runs still work, saved tests/suites answer 503 |

Per-run artifacts (screenshots, `recording.mp4`, `report_data.json`,
`report.pdf`) are written to
`runs/<runId>/` and persisted via the `./runs` volume. Durable metadata —
saved tests, suites, run verdicts — lives in Postgres (`pgdata` volume);
schema and rationale in [`db/README.md`](db/README.md).

The two have different lifetimes on purpose: a history row is a few hundred
bytes and is kept forever, while the directory beside it is tens of MB and is
deleted after `ARTIFACT_RETENTION_DAYS`. A pruned run keeps its verdict,
timings and step count, and simply stops offering the report and recording.

## API

```bash
# start a run
curl -X POST http://<host>:8080/api/runs \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"Search for a laptop and add the first result to cart","start_url":"https://example.com"}'
# -> {"runId":"...","status":"running"}

# poll status + result
curl http://<host>:8080/api/runs/<runId> -H "Authorization: Bearer $WORKER_API_TOKEN"

# download the PDF report (202 while generating, 200 when ready)
curl -L http://<host>:8080/api/runs/<runId>/report.pdf \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o report.pdf

# download the session recording (mp4; 404 if the run wasn't recorded).
# Supports range requests, and — alone among the endpoints — ?token=<token>
# instead of the header, so a <video> element can stream it directly.
curl -L http://<host>:8080/api/runs/<runId>/recording \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o recording.mp4

# health
curl http://<host>:8080/api/health

# live feed: ws://<host>:8080/ws?runId=<runId>&token=<WORKER_API_TOKEN>
```

### Saved tests, projects and modules

Needs the Postgres control plane (`DATABASE_URL`); without it these answer 503
and ad-hoc runs above still work.

A saved test is the reusable unit. Grouping is optional: a test can sit in a
**project**, and within it in at most one **module** (`auth`, `payment`, …).
A **suite** is the cross-cutting alternative — an arbitrary many-to-many
selection inside one project, so the same test can be in `smoke` and
`nightly`. Projects, modules and suites are all runnable in one call.

```bash
# save a test, then run it (start_url is overridable per run — point CI at a
# fresh preview deploy without editing the test)
curl -X POST http://<host>:8080/api/tests \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"login smoke","goal":"log in and see the dashboard","start_url":"https://example.com"}'
curl -X POST http://<host>:8080/api/tests/<testId>/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"start_url":"https://preview.example.com","trigger":"ci"}'

# organize: a project, a module in it, then file the test under the module
# (project_id is derived from the module — you never set both)
curl -X POST http://<host>:8080/api/projects \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Checkout"}'          # -> {"id":"...","slug":"checkout",...}
curl -X POST http://<host>:8080/api/projects/checkout/modules \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Auth"}'              # -> {"id":"...","slug":"auth",...}
curl -X PUT http://<host>:8080/api/tests/<testId> \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"module_id":"<moduleId>"}'

# run a whole module or project. Paths take a slug or a uuid, so CI configs
# don't have to carry ids; one run is started per member test.
curl -X POST http://<host>:8080/api/projects/checkout/modules/auth/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"trigger":"ci"}'
# -> {"moduleId":"...","runs":[{"runId":"...","testId":"...","status":"queued"}, ...]}

# list/filter: ?project_id=<id>, ?module_id=<id>, or project_id=none (Ungrouped)
curl "http://<host>:8080/api/tests?project_id=<projectId>" \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

Suites work the same way but belong to a project, and their members must too:

```bash
curl -X POST http://<host>:8080/api/suites \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"smoke","project_id":"<projectId>","test_ids":["<id>","<id>"]}'
curl -X POST http://<host>:8080/api/suites/<suiteId>/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

Deleting a module or project never deletes tests — they fall back to
Ungrouped. Deleting a project does take its suites with it.

### Run history

`GET /api/runs` lists finished and in-flight runs newest first, from the same
control plane (503 without `DATABASE_URL`). Every row carries the test's name
and grouping, so a history table renders from one request.

```bash
# filters combine: test_id, project_id, module_id, status (comma-separated),
# since/until (ISO timestamps on created_at), limit (≤200) and offset
curl "http://<host>:8080/api/runs?test_id=<testId>&status=failed,error&limit=20" \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"runs":[{"id":"...","status":"failed","test_name":"login smoke",
#              "success":false,"created_at":"...","has_recording":true, ...}],
#     "total":37,"limit":20,"offset":0}
```

`total` is the unpaginated count, for paging. A run's project is its test's,
reached by join — so a run whose test was later deleted keeps its history row
(goal and start_url were copied at enqueue time) but matches no project
filter. Once retention prunes `runs/<id>/`, `artifacts_deleted_at` is set and
the row reports no recording or report while the verdict survives.

## Local development

This section is for working *on* QAssist. To just run it, see
[Run it](#run-it) above — that path needs Docker only.

Developing needs Node 22+ and Python 3.11+ on the host, plus Docker: the dev
server starts the Postgres control plane as a container for you (see below),
so Docker has to be running even when you aren't using the full stack.

One-time setup:

```bash
cp .env.example .env      # set WORKER_API_TOKEN and OPENAI_API_KEY

# agent venv (browser-use + Playwright Chromium); needs python3-venv or uv
cd agent && uv venv .venv && uv pip install -r requirements.txt --python .venv/bin/python \
  && .venv/bin/playwright install chromium
# without uv: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && ...

cd ../server && npm install
cd ../frontend && npm install
```

Then run both dev servers, each with hot reload and logs in the foreground:

```bash
# terminal 1 — API on :8081 (node --watch; loads ../.env, uses agent/.venv;
# auto-starts the compose Postgres on 127.0.0.1:5433 and connects to it)
cd server && npm run dev
# terminal 2 — frontend on :5173 (Vite HMR; proxies /api and /ws to :8081)
cd frontend && npm run dev
```

Open `http://localhost:5173` and paste your `WORKER_API_TOKEN`. Dev defaults to
port 8081 so it can't collide with the Docker stack on 8080; override with
`PORT=<p> npm run dev` (server) and `API_PORT=<p> npm run dev` (frontend),
keeping the two in sync.

### The dev database

`npm run dev` runs `docker compose up -d --wait db` first, so Postgres is
already healthy by the time the server boots; pending migrations in
`db/migrations/` are then applied automatically. You don't set `DATABASE_URL`
— the dev script defaults it to the container on `127.0.0.1:5433`. Startup
logs `db=on` when the control plane is live (`db=off` means it fell back to
in-memory mode, where saved tests and suites answer 503).

- **Port 5433 already taken?** It's mapped that way to avoid colliding with a
  local Postgres on 5432. To use a different database entirely, pass the URL
  in the shell — `DATABASE_URL=postgres://… npm run dev` — not via `.env`,
  since the script's default is applied after `.env` is read.
- **Reset the data:** `docker compose down -v` drops the `pgdata` volume;
  the next `npm run dev` recreates the schema from scratch.
- `npm test` needs none of this — the control-plane tests run the real
  migrations against an in-memory Postgres (pg-mem).

## Deployment

Runs as a single container (`docker compose up -d`) on an Ubuntu VPS (4 vCPU /
8 GB is comfortable for ~4 concurrent sessions). Currently reachable via an SSH
tunnel while port 8080 stays firewalled:

```bash
ssh -L 8090:localhost:8080 <vps>   # then open http://localhost:8090
```

Fronting it with HTTPS (Caddy on 443) for public/API access is a [roadmap](#roadmap) item.

## Roadmap

Planned work lives in [`backlog/`](backlog/README.md) — one file per user
story, organized by release folder (`release-1/`, `unscheduled/`,
`released/`), with status, dependencies, and acceptance criteria.

**Release 1** (in [`backlog/release-1/`](backlog/README.md)):

- **Control plane** (Postgres) — saved tests & suites
  ([US-009](backlog/release-1/US-009-control-plane-saved-tests.md)), projects
  & modules ([US-023](backlog/release-1/US-023-projects-and-modules.md)), run
  history ([US-011](backlog/release-1/US-011-run-history.md)), scheduled runs
  ([US-010](backlog/release-1/US-010-scheduled-runs.md)), failure email
  notifications ([US-012](backlog/release-1/US-012-email-reports.md)).
- **Session recording** — store an MP4 per run
  ([US-006](backlog/release-1/US-006-session-recording.md)) and a report
  with per-step screenshots + working "View recording"
  ([US-020](backlog/release-1/US-020-report-v2-screenshots-recording.md)).
- **Public HTTPS** — Caddy on 443, no more SSH tunnel; unblocks CI/CD
  ([US-007](backlog/release-1/US-007-https-reverse-proxy.md)).
- **CI/CD integration (tier 1)** — GitHub/GitLab trigger saved tests/suites
  by id via a documented curl step
  ([US-008](backlog/release-1/US-008-cicd-integration.md), needs US-009).
- **Registration-flow verification** — email-confirmation signups, already
  working ([US-013](backlog/release-1/US-013-registration-flow-verification.md)).
- **Hosted paid tier** — bring-your-own OpenAI key
  ([US-005](backlog/release-1/US-005-byok-user-api-keys.md)), magic-link
  signup ([US-021](backlog/release-1/US-021-signup-auth.md)), and Stripe
  subscriptions ([US-022](backlog/release-1/US-022-stripe-billing.md)).
  Self-hosting stays free: billing is env-gated and off by default.

Later ([`backlog/unscheduled/`](backlog/README.md)): SMS/social
registration tiers, PR status checks, scaling to ~100 concurrent sessions
([US-015](backlog/unscheduled/US-015-horizontal-scaling-100-concurrent.md)),
and a possible desktop app.

## Notes

- The worker is **stateless** per run — durable state belongs in the control plane above.
- How the open-source repo relates to the paid hosted tier (and the future
  private cloud repo): [`docs/repo-model.md`](docs/repo-model.md).
- **Secure it before exposing publicly:** always behind HTTPS, always with the token.
- Some sites (Reddit, Cloudflare-heavy pages) block datacenter IPs and will fail
  from a server — expected, not a bug.
