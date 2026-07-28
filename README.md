# QAssist

**Goal-based, adaptive browser testing you can watch run live.** Give it a URL and
a plain-English goal; an AI agent drives a real Chromium browser like a user,
streams the session live, decides pass/fail, and produces a shareable PDF report.

> Status: **actively developed.** Runs end-to-end and is deployed. See
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
| Packaging | Single Docker image — [`ghcr.io/rszhd/qassist`](https://github.com/rszhd/qassist/pkgs/container/qassist), `docker compose up` |

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
frontend/             React + Vite UI — Run view (live viewer) and Projects
Dockerfile            multi-stage: builds frontend, bundles Node + Python + Chromium
docker-compose.yml
.env.example
```

## Run it

**Docker is the only thing you need installed** — Node, Python and Chromium all
live inside the image.

### Run a release (no clone, no build)

The fastest path: pull a published, tested image. Two files and one command, and
you never see the source.

```bash
curl -O https://raw.githubusercontent.com/rszhd/qassist/main/docker-compose.release.yml
curl -o .env https://raw.githubusercontent.com/rszhd/qassist/main/.env.example
# generate the one secret .env needs, then start it:
sed -i "s/^KEY_ENCRYPTION_SECRET=$/KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)/" .env
docker compose -f docker-compose.release.yml up -d
```

Images are published to
[ghcr.io/rszhd/qassist](https://github.com/rszhd/qassist/pkgs/container/qassist)
on every version tag — `:1.2.3` exactly, `:1.2` to float on patches, and
`:latest`. **Pin the exact version**; the file above does. Upgrading is editing
that tag and re-running the command, and the schema migrates itself at boot.

### Build from source

Clone the repo, then:

```bash
cp .env.example .env      # then generate its one required secret:
sed -i "s/^KEY_ENCRYPTION_SECRET=$/KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)/" .env
docker compose up --build
```

The first build takes a few minutes (it downloads Chromium). Either way, open
`http://localhost:8080`, enter a URL + goal, and watch it run. Finished runs
expose a **Download PDF report** button.

Two things worth knowing on a fresh clone:

- **Your OpenAI key goes in the app, not in `.env`.** The agent is
  bring-your-own-key: open Settings → OpenAI key and paste yours — it is
  stored encrypted (that is what `KEY_ENCRYPTION_SECRET` is for) and every run
  you start is funded by it. Until then, starting a run answers `503` pointing
  you at Settings. The server holds no key of its own, so an instance you
  share can never spend your tokens on someone else's runs (US-039).
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
| `BROWSER_USE_MODEL` | `gpt-4.1` | OpenAI model |
| `MAX_CONCURRENT_SESSIONS` | `4` | Concurrent browser cap — the real throttle. Rule: `floor((RAM_GB − 1.5) / 1)`. Runs over the cap wait in an in-memory FIFO and are told their position live; the queue is not durable, so a restart marks everything still waiting `error` |
| `MAX_STEPS` | `60` | Safety ceiling on agent steps per run |
| `MAX_RUN_MEMORY_MB` | `1600` | Per-run process-tree RSS cap; over it the run is killed and marked failed. Summed RSS double-counts Chromium's shared pages — a recording run measures ~1177 MB here but only ~660 MB PSS (US-024) |
| `STOP_GRACE_SECONDS` | `10` | How long a stopped run (US-047) has to end itself gracefully — finalizing its recording and report — before the process tree is killed anyway. A run stopped either way ends `cancelled` |
| `PORT` | `8080` | Express listen port |
| `QA_RECORD` | `1` | Record every session to `runs/<runId>/recording.mp4`. `0` disables it — frame capture is then skipped entirely while nobody is watching the run |
| `ARTIFACT_RETENTION_DAYS` | `7` | How long `runs/<runId>/` (report PDF + mp4 recording) is kept. Swept at startup and every 6 h; the history row and its verdict are kept forever regardless. `0` = never prune |
| `PUBLIC_BASE_URL` | — | Public address of this instance (`https://qa.example.com`). Only used to make the PDF report's "View recording" link resolvable; the recording is served either way |
| `KEY_ENCRYPTION_SECRET` | — | **Required.** Encrypts stored OpenAI keys at rest. Generate once (`openssl rand -hex 32`) and keep it — losing it makes every stored key undecryptable |
| `DATABASE_URL` | — | **Required** — Postgres control plane (saved tests, run history, and the users row a stored key lives on). Set for you in both paths — `docker compose` points it at its own `db` service, `npm run dev` at the same container on `localhost:5433`. Without it the server refuses to boot |
| `RESEND_API_KEY` | — | Resend key for result email. Unset (or `MAIL_FROM` unset) = notifications off: prefs still save, nothing sends. `/api/health` reports this as `mail` |
| `MAIL_FROM` | — | Sender address, on a domain verified with Resend (`QAssist <qa@example.com>`) |
| `NOTIFY_EMAILS` | — | Comma-separated fallback recipients, used when a project names none |
| `NOTIFY_MODE` | `failure` | Default for tests in no project — one of `failure`, `always`, `never`. `failure` covers anything that is not a pass, including a run that ended unjudged. Projects carry their own mode |
| `NOTIFY_SECRET` | `WORKER_API_TOKEN` | Signs unsubscribe links. Falls back to a per-boot random value if the token is blank too, which invalidates links already mailed |
| `OPERATOR_EMAIL` | `operator@qassist.local` | Seeds the single account row, and is the last-resort recipient after `NOTIFY_EMAILS`. The default is not a deliverable address |
| `STRIPE_SECRET_KEY`<br>`STRIPE_WEBHOOK_SECRET`<br>`STRIPE_PRICE_ID` | — | Subscription billing (see [Billing](docs/api.md#billing)). All blank = billing off, every run free — the self-host default. Also needs `PUBLIC_BASE_URL`, the control plane and `AUTH_ENABLED`; missing any one leaves the instance free. `/api/health` reports this as `billing` |
| `BILLING_EXEMPT_EMAILS` | `OPERATOR_EMAIL` | Comma-separated accounts that run without subscribing |
| `ACTIVATION_SLA_HOURS` | — | Hours a paid account waits while the operator adds capacity for it (see [the activation window](docs/api.md#the-activation-window)). Unset or `0` = off: accounts run the moment they are entitled. Turning it off releases anyone already waiting. Needs billing on |

Per-run artifacts (screenshots, `recording.mp4`, `report_data.json`,
`report.pdf`) are written to
`runs/<runId>/` and persisted via the `./runs` volume. Durable metadata —
saved tests, suites, run verdicts — lives in Postgres (`pgdata` volume);
schema and rationale in [`db/README.md`](db/README.md).

The two have different lifetimes on purpose: a history row is a few hundred
bytes and is kept forever, while the directory beside it is tens of MB and is
deleted after `ARTIFACT_RETENTION_DAYS`. A pruned run keeps its verdict,
timings and step count, and simply stops offering the report and recording.

A handful of further variables — `APP_HOST`, `ACME_EMAIL`, `QASSIST_IMAGE`,
`RUNS_DIR`, `ROBOTS_TAG` — are read *only* by the production overlay and are
documented in [`docs/deploy/production.md`](docs/deploy/production.md). A plain
`docker compose up` ignores
them entirely.

## API

Everything the UI does is an HTTP call, token-authed. Enough to start a run and
collect its verdict:

```bash
# start a run
curl -X POST http://<host>:8080/api/runs \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"Search for a laptop and add the first result to cart","start_url":"https://example.com"}'
# -> {"runId":"...","status":"running"}

# poll status + result (the run's own page is http://<host>:8080/runs/<runId>)
curl http://<host>:8080/api/runs/<runId> -H "Authorization: Bearer $WORKER_API_TOKEN"

# download the PDF report (202 while generating, 200 when ready)
curl -L http://<host>:8080/api/runs/<runId>/report.pdf \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o report.pdf

# live feed: ws://<host>:8080/ws?runId=<runId>&token=<WORKER_API_TOKEN>
```

The rest — saved tests, projects and modules, suites, schedules, run history,
email notifications, recordings and billing — is
**[docs/api.md](docs/api.md)**. Wiring a pipeline to it is
[docs/ci.md](docs/ci.md). Testing the part of your product that is behind a
login — saved sessions, email codes, social login — is
[docs/auth-in-tested-flows.md](docs/auth-in-tested-flows.md).

## Local development

This section is for working *on* QAssist. To just run it, see
[Run it](#run-it) above — that path needs Docker only.

Developing needs Node 22+ and Python 3.11+ on the host, plus Docker: the dev
server starts the Postgres control plane as a container for you (see below),
so Docker has to be running even when you aren't using the full stack.

One-time setup:

```bash
cp .env.example .env      # set WORKER_API_TOKEN and KEY_ENCRYPTION_SECRET

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
— the dev script defaults it to the container on `127.0.0.1:5433`. The
control plane is required (US-039): if Postgres isn't reachable the server
refuses to boot and says so, rather than serving a half-app.

- **Port 5433 already taken?** It's mapped that way to avoid colliding with a
  local Postgres on 5432. To use a different database entirely, pass the URL
  in the shell — `DATABASE_URL=postgres://… npm run dev` — not via `.env`,
  since the script's default is applied after `.env` is read.
- **Reset the data:** `docker compose down -v` drops the `pgdata` volume;
  the next `npm run dev` recreates the schema from scratch.
- `npm test` needs none of this — the control-plane tests run the real
  migrations against an in-memory Postgres (pg-mem).

## Deployment

Runs as a single container (`docker compose up -d`) on any Linux host with
Docker (4 vCPU / 8 GB is comfortable for ~4 concurrent sessions). The app
listens on port 8080.

To put it on a public hostname over HTTPS, layer the production overlay on the
same base file — it adds a Traefik reverse proxy with automatic Let's Encrypt
certificates and stops publishing 8080 on the host:

```bash
docker network create qassist-edge
docker compose -p qassist-proxy -f docker-compose.proxy.yml up -d
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The runbook — DNS, the `.env` values the overlay reads, verifying the
WebSocket, deploying a new tag, and the certificate store — is
[`DEPLOY.md`](DEPLOY.md). It also covers the hosted deployments this repo drives,
each of which is those same two compose files with a different project name and
env file: production, staging, the demo sandbox, and a preview environment. The
promotion chain is **dev → staging → main**, with `preview` a force-pushable
*spur* off the side of it rather than a stage in it — nothing merges out of
preview, which is what keeps `main` a fast-forward of what staging proved.

## Roadmap

Planned work lives in [`backlog/`](backlog/README.md) — one file per user
story, with status, dependencies and acceptance criteria, organized by sprint
folder. Finished stories move into `sprint/<name>/done/`, so
`ls backlog/sprint/current/` is exactly the work that is left, and
[`backlog/README.md`](backlog/README.md) is the overview: what is open, what
depends on what, and why the sprint is shaped the way it is.

## Notes

- The worker is **stateless** per run — durable state belongs in the control plane above.
- **Secure it before exposing publicly:** always behind HTTPS, always with the token.
- Some sites (Reddit, Cloudflare-heavy pages) block datacenter IPs and will fail
  from a server — expected, not a bug. When the site is *yours*, allowlist the
  box: [`docs/waf-allowlisting.md`](docs/waf-allowlisting.md).

## Contributing

Patches welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers getting the stack
running, which test suite to run for what, the house style, and the one
procedural ask — a DCO `Signed-off-by` line, which `git commit -s` adds for you.

## License

**[AGPL-3.0-only](LICENSE).** In plain terms:

- **Self-hosting is free, for anything, forever** — personal or commercial, no
  seat count, no feature gate, no key to buy. Running QAssist is not what the
  licence asks anything about. Model tokens are bring-your-own on every tier,
  so the only bill is the one you already have with your LLM provider.
- **Modify it and run your version freely.** The obligation attaches to
  *distribution* — and, because this is the AGPL rather than the GPL, to
  offering your modified version **to others as a network service**. Do that,
  and those users are entitled to your source under the same licence.
- That is the whole reason for the A: it keeps a competitor from taking this
  code, running it as a closed hosted product, and giving nothing back — while
  leaving every actual self-hoster completely unrestricted.

Contributions stay under the same licence and **you keep your copyright** —
DCO, not a CLA.

A paid hosted tier at [qassist.run](https://qassist.run) is planned, and it
runs **this** codebase — not a fork of it, and not a more capable private
sibling. Payment there covers hosting; it buys no feature you don't have here.
A private repo holds the commercial layer around that deployment, and what may
live in it is a deliberately narrow question with a public default — the rules,
and the routing test applied to every new feature, are in
[`docs/repo-model.md`](docs/repo-model.md).
