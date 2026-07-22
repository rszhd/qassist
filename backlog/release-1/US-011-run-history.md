# US-011 — Run history

**As a** user, **I want** to browse past runs with verdicts, reports, and recordings, **so that** I can spot regressions and trends instead of losing results after an hour.

- **Status:** ✅ Done (2026-07-22) — persistence had already shipped with
  US-009; the list endpoint, the History view and retention landed here
- **Priority:** P2 (Release 1) — moved out of `unscheduled/` on 2026-07-22
- **Estimate:** ~1 day for the endpoint + view; retention was separate
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

**Done 2026-07-22 (backend):** `GET /api/runs` — filters `test_id`, `status`
(comma-separated), `project_id`, `module_id`, `since`/`until`, `limit`/`offset`,
newest first, with an unpaginated `total`. Rows join `tests` for `test_name`,
`project_id`, `module_id` so a history table renders from one request. All the
run routes moved out of `server.js` into `routes/runs.js` on the way (the
engine stays `src/runs.js`).

**Done 2026-07-22 (frontend):** `HistoryView.jsx` — the third view, with
project/test/status/date filters, 25-per-page paging, and a `RunDetail.jsx`
panel carrying the PDF button and the recording player. The per-test pass/fail
timeline appears once a single test is selected. `status.js` now holds the
status→colour table (was private to `TopBar.jsx`) plus the date/duration
formatters, and `openReport()` moved into `api.js` — the Run view and the
history detail panel were about to poll the same 202 loop twice.

**Done 2026-07-22 (retention):** `src/retention.js` — `ARTIFACT_RETENTION_DAYS`
(default 7, `0` disables) in `.env`. Swept at boot and every 6 h.

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

3. **A run's project is its test's, by join.** `runs` gets no `project_id` of
   its own. Denormalizing it would have to answer what happens when the test
   moves project — copy at enqueue time and history disagrees with the
   library, follow the test and the "denormalized so history survives edits"
   rule breaks. The join keeps one answer, at the cost that a run whose test
   was deleted (`on delete set null`) matches no project filter. That is the
   honest result: the group it belonged to is no longer knowable, while the
   run's own goal/start_url copies still are.
4. **Pruned artifacts are hidden by the API, not just the UI.** The list
   reports `has_recording: false` and `report_status: 'none'` once
   `artifacts_deleted_at` is set, so no client can offer a link that 404s.
   `artifacts_deleted_at` itself is returned, so a client can say why.
5. **The sweep walks the directory, not the table.** Driving it from a DB
   query would leave orphans behind forever: dirs from runs that were never
   persisted (no `DATABASE_URL`) or whose row was deleted. Walking
   `ARTIFACTS_DIR` is the one path that bounds disk in both modes. Guards: only
   uuid-named directories are ever removed (`ARTIFACTS_DIR` is operator-set and
   the delete is recursive), and a run still live in the relay is skipped.
6. **Stamp the row, then delete the directory.** A crash between the two
   leaves a row saying "pruned" beside a directory that still exists — the
   next sweep sees the stale directory and finishes the job. The reverse order
   fails badly: a row still advertising a report, with no directory left to
   trigger a retry.
7. **mtime, not `finished_at`.** The sweep has to work without a control
   plane, and a directory's last write is when the run stopped writing to it.

## Acceptance criteria

- [x] Finished runs remain visible after server restart (US-009)
- [x] `GET /api/runs` lists runs, filterable by saved test, status and project
      (also module, date range; paginated with an unpaginated `total`)
- [x] History view: list + per-run detail linking the report PDF (and the
      recording, which US-006 made available ahead of schedule)
- [x] Per-test pass/fail timeline — shown when the filter narrows to one test
- [x] Old artifacts cleaned per retention policy, `artifacts_deleted_at`
      stamped, history rows kept
