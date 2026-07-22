# Control-plane database design

Postgres schema for US-009–US-012 (+ stored BYOK keys from US-005). Migrations
live in [`migrations/`](migrations/), numbered SQL files applied in order —
`001_init.sql` is the whole initial design.

## Ground rules

- **Worker stays stateless** (README design principle). The DB is the control
  plane: tests, runs metadata, schedules, notification state. The live run
  relay (WebSocket frames/events) stays in memory as today.
- **Artifacts stay on disk**, under `runs/<id>/` exactly as now. The DB stores
  verdicts and status, never blobs. `runs.id` doubles as the directory name,
  so no path columns are needed.
- **Column names mirror `server.js`** (`goal`, `start_url`, `max_steps`,
  `status` values `queued/running/passed/failed/completed/error`,
  `report_status`) so persisting a run is a straight insert of the existing
  in-memory object.

## Entities

```mermaid
erDiagram
  users ||--o{ api_keys : has
  users ||--o{ tests : owns
  users ||--o{ suites : owns
  suites ||--o{ suite_tests : contains
  tests ||--o{ suite_tests : "member of"
  tests ||--o{ runs : "produced (nullable — ad-hoc runs have no test)"
  runs  ||--o{ notifications : "emailed as"
```

| Table | Owns | Story |
|---|---|---|
| `users` | identity + encrypted OpenAI key (BYOK) | US-005/009 |
| `api_keys` | hashed bearer tokens, revocable — replaces the single `WORKER_API_TOKEN` | US-009 |
| `tests` | saved goal+URL+settings, per-test schedule, per-test notify prefs | US-009/010/012 |
| `suites` + `suite_tests` | named test groups for one-shot triggering (US-008 CI) | US-009 |
| `runs` | durable run history — replaces the in-memory Map for finished runs | US-009/011 |
| `notifications` | per-recipient email delivery log (idempotent sends) | US-012 |

## Key decisions

- **Runs denormalize `goal`/`start_url`/`max_steps`/`model`** at enqueue time.
  Editing or deleting a test must not rewrite history; `test_id` is
  `on delete set null` so ad-hoc and orphaned runs are the same shape.
- **No `suite_runs` table.** Running a suite creates one `runs` row per member
  test and returns the ids; US-008 CI polls each run. A grouping row buys
  nothing until something needs a suite-level verdict — add it then.
- **Schedule is columns on `tests`, not a table.** US-010 is one schedule per
  test; a join table adds nothing. `next_run_at` is precomputed so the
  scheduler is a cheap poll (`tests_due_idx` is a partial index over enabled
  schedules only), and it survives restarts. Overlap-skip = "does this test
  have a row in `runs` with status queued/running" (`runs_active_idx`).
- **Notification prefs on `tests`** (`notify` mode + `notify_emails[]`),
  delivery attempts in `notifications` with a `(run_id, recipient)` unique
  key — a crashed/retried sender can't double-email.
- **Step-level detail is not in the DB.** It already lives in
  `report_data.json` on disk and is only read to render the report. If a
  per-step UI is ever needed, add a `steps jsonb` column then — don't pay for
  it now.
- **BYOK stored keys**: `users.openai_key_ciphertext` is app-side encrypted
  (AES-256-GCM with a server secret from env), nullable — per-request keys
  (US-005 v1) keep working and nothing is persisted unless the user opts in.
- **Retention (US-011)** is two-phase: prune `runs/<id>/` dirs first and stamp
  `artifacts_deleted_at` (history stays browsable, links go dead), delete rows
  on a longer horizon.
- **Crash recovery**: on boot, any row still `queued`/`running` is stale (the
  worker died with it) — mark it `error`. The partial index makes this free.

## Implementation notes (for US-009)

- Driver: plain `pg` + these SQL files run in order at startup (tracked in a
  tiny `schema_migrations` table). No ORM — the server is small, hand-written
  SQL keeps it that way. Revisit only if query count balloons.
- `docker-compose.yml` gains a `postgres:16` service + volume; server gets
  `DATABASE_URL`. Local dev without Docker: any local Postgres works.
- v1 seeds one user (operator email) and one api_key hashed from
  `WORKER_API_TOKEN`, so existing clients/CI keep working unchanged.
