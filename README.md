# QAgent (prototype)

Goal-based, adaptive browser testing you can watch run live. Give it a URL and a
plain-English goal; an AI agent drives a real browser like a user and reports
pass/fail.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite (live viewer) |
| API | Express (REST + WebSocket relay) |
| Agent | Python + [browser-use](https://github.com/browser-use/browser-use) driving Chromium |
| Model | OpenAI (default `gpt-4.1`) |
| Packaging | Single Docker image, `docker compose up` |

Express receives a run, spawns `agent/run_agent.py`, and relays the agent's
NDJSON step events (each with a screenshot) to the browser over a WebSocket.

## Run it

```bash
cp .env.example .env      # then set WORKER_API_TOKEN and OPENAI_API_KEY
docker compose up --build
```

Open `http://<host>:8080`, paste your `WORKER_API_TOKEN`, enter a URL + goal, and
watch it run.

## API

```bash
# start a run
curl -X POST http://<host>:8080/api/runs \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goal":"Search for a laptop and add the first result to cart","start_url":"https://example.com"}'
# -> {"runId":"...","status":"running"}

# poll status/result
curl http://<host>:8080/api/runs/<runId> -H "Authorization: Bearer $WORKER_API_TOKEN"

# live feed: ws://<host>:8080/ws?runId=<runId>&token=<WORKER_API_TOKEN>
```

## Local development

```bash
# terminal 1 — API
cd server && npm install && WORKER_API_TOKEN=dev OPENAI_API_KEY=sk-... \
  PYTHON_BIN=../.venv/bin/python node src/server.js
# terminal 2 — frontend (proxies /api and /ws to :8080)
cd frontend && npm install && npm run dev
```

## Notes / next steps

- Worker is **stateless** per run; state (saved tests, schedules, history) belongs
  in a control plane added later.
- Put this behind HTTPS + a real token before exposing it publicly.
- Roadmap: save & reuse tests, scheduled runs, email reports, Postgres, true
  video screencast (currently per-step screenshots).
