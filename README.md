# QAgent

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
frontend/             React + Vite live viewer
Dockerfile            multi-stage: builds frontend, bundles Node + Python + Chromium
docker-compose.yml
.env.example
```

## Run it

```bash
cp .env.example .env      # set WORKER_API_TOKEN and OPENAI_API_KEY
docker compose up --build
```

Open `http://<host>:8080`, paste your `WORKER_API_TOKEN`, enter a URL + goal, and
watch it run. Finished runs expose a **Download PDF report** button.

## Configuration

Set in `.env` (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_API_TOKEN` | — | Bearer token required on every API/WS call |
| `OPENAI_API_KEY` | — | Drives the browser agent |
| `BROWSER_USE_MODEL` | `gpt-4.1` | OpenAI model |
| `MAX_CONCURRENT_SESSIONS` | `4` | Concurrent browser cap — the real throttle. Rule: `floor((RAM_GB − 1.5) / 1)` |
| `MAX_STEPS` | `60` | Safety ceiling on agent steps per run |
| `PORT` | `8080` | Express listen port |

Per-run artifacts (screenshots, `report_data.json`, `report.pdf`) are written to
`runs/<runId>/` and persisted via the `./runs` volume.

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

# health
curl http://<host>:8080/api/health

# live feed: ws://<host>:8080/ws?runId=<runId>&token=<WORKER_API_TOKEN>
```

## Local development

```bash
# terminal 1 — API (point PYTHON_BIN at a venv with browser-use installed)
cd server && npm install && WORKER_API_TOKEN=dev OPENAI_API_KEY=sk-... \
  PYTHON_BIN=/path/to/.venv/bin/python node src/server.js
# terminal 2 — frontend (Vite proxies /api and /ws to :8080)
cd frontend && npm install && npm run dev
```

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
story, with status, priorities, dependencies, and acceptance criteria.
Highlights:

- **Session recording** — store an MP4 per run and light up the report's
  "View recording" button ([US-006](backlog/US-006-session-recording.md)).
- **Public HTTPS** — Caddy on 443, no more SSH tunnel; unblocks CI/CD
  ([US-007](backlog/US-007-https-reverse-proxy.md)).
- **Bring-your-own OpenAI key** ([US-005](backlog/US-005-byok-user-api-keys.md)).
- **CI/CD integration** — GitHub/GitLab, from a curl step up to PR status
  checks ([US-008](backlog/US-008-cicd-integration.md)).
- **Control plane** (Postgres) — saved tests, scheduling, history, email
  reports ([US-009](backlog/US-009-control-plane-saved-tests.md)–US-012).
- **Registration-flow verification** — email/SMS codes, social logins
  ([US-013](backlog/US-013-registration-flow-verification.md)).
- **Scaling to ~100 concurrent sessions**
  ([US-015](backlog/US-015-horizontal-scaling-100-concurrent.md)).

## Notes

- The worker is **stateless** per run — durable state belongs in the control plane above.
- **Secure it before exposing publicly:** always behind HTTPS, always with the token.
- Some sites (Reddit, Cloudflare-heavy pages) block datacenter IPs and will fail
  from a server — expected, not a bug.
