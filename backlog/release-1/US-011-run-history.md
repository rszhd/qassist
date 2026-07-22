# US-011 — Run history

**As a** user, **I want** to browse past runs with verdicts, reports, and recordings, **so that** I can spot regressions and trends instead of losing results after an hour.

- **Status:** 📋 Planned — **persistence already shipped with US-009**; what
  remains is the list endpoint, the UI and retention (see below)
- **Priority:** P2 (Release 1) — moved out of `unscheduled/` on 2026-07-22
- **Estimate:** ~1 day for the endpoint + view; retention is separate
- **Depends on:** US-009 (Postgres, done); richer with US-006 (recordings)

## Details

The original framing — "runs live in an in-memory Map with a 1 h TTL, history
disappears on restart" — was overtaken by US-009. The `runs` table is now the
source of truth for finished runs, so state that as built rather than as work:

**Already done (US-009):**

- `runs` persists verdict, timings, `steps_count`, `trigger`, `report_status`,
  `has_recording` and the `test_id` link; goal/start_url are denormalized at
  enqueue time so history survives editing or deleting the test.
- `runs.js` inserts on enqueue and updates on completion; `db.js` marks stale
  `queued`/`running` rows as errored on boot.
- `GET /api/runs/:id` falls back to the DB once the in-memory relay expires.
- Indexes for every filter this story wants: `runs_test_created_idx`,
  `runs_created_idx`, partial `runs_active_idx`.
- `artifacts_deleted_at` is reserved for retention — nothing writes it yet.

**Outstanding:**

- `GET /api/runs` — there is no list endpoint, only `/:id`. Filters:
  `test_id`, `status`, `project_id`, plus a date range and pagination.
- UI: a third view alongside `Run` and `Library` (the US-023 split is what
  gives it somewhere to live) — history list with filters, per-run detail
  linking the report PDF and, after US-006, the recording.
- Per-test pass/fail timeline — the regression-spotting view, and the reason
  the story is worth more than a log dump.
- Retention: nothing prunes `runs/<id>/` today, so disk grows without bound.
  Delete old artifact dirs, stamp `artifacts_deleted_at`, keep the row.

## Decisions

1. **Retention can ship separately from the UI.** Unbounded disk growth is a
   problem whether or not anyone browses history, and the column it needs
   already exists. Splitting it lets the view land first without waiting on a
   policy decision about how long to keep artifacts.
2. ~~**Scheduled after US-020.**~~ **Flipped 2026-07-22 — now ahead of
   US-020.** The reason for the original order was that a detail view built
   before recordings exist gets retrofitted for them; US-006 shipping both
   halves removes that risk. The recording player already exists in
   `RunView.jsx` and `GET /api/runs/:id` already returns `hasRecording` for a
   finished run it never watched (the fallback was written for this view).
   What still waits on US-020 is step screenshots in the detail panel.

## Acceptance criteria

- [x] Finished runs remain visible after server restart (US-009)
- [ ] `GET /api/runs` lists runs, filterable by saved test, status and project
- [ ] History view: list + per-run detail linking the report PDF
- [ ] Per-test pass/fail timeline
- [ ] Old artifacts cleaned per retention policy, `artifacts_deleted_at`
      stamped, history rows kept
