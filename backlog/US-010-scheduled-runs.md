# US-010 — Scheduled runs

**As a** user, **I want** my saved tests to run automatically on a schedule, **so that** I catch site breakage without anyone pressing a button.

- **Status:** 📋 Planned
- **Priority:** P3
- **Estimate:** ~1–2 days
- **Depends on:** US-009 (saved tests + Postgres)

## Details

- Per-test schedule (cron expression or simple presets: hourly/daily/weekly),
  stored in Postgres.
- Scheduler in the control plane enqueues runs; respects
  `MAX_CONCURRENT_SESSIONS` via the existing queue (bursts of scheduled tests
  must queue, not stampede the workers).
- Handle overlap: skip if the same test's previous scheduled run is still
  running.
- Pairs with US-012 (email reports) for notify-on-failure.

## Acceptance criteria

- [ ] A daily-scheduled test runs within a few minutes of its slot
- [ ] Schedules survive restarts
- [ ] A burst of simultaneous schedules queues instead of exceeding the
      concurrency cap
