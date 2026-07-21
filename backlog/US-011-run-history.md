# US-011 — Run history

**As a** user, **I want** to browse past runs with verdicts, reports, and recordings, **so that** I can spot regressions and trends instead of losing results after an hour.

- **Status:** 📋 Planned
- **Priority:** P3
- **Estimate:** ~1–2 days
- **Depends on:** US-009 (Postgres); richer with US-006 (recordings)

## Details

Today runs live in an in-memory Map with a 1 h TTL (`RUN_TTL_SECONDS`) —
history disappears on restart or timeout, even though artifacts stay on disk.

- Persist finished runs to Postgres (verdict, timings, steps count, artifact
  paths, test_id link).
- UI: history list with filters (test, status, date), per-run detail page
  linking report PDF + recording.
- Per-test pass/fail timeline is the regression-spotting view.
- Artifact retention policy goes here (delete old `runs/<id>/` dirs + rows).

## Acceptance criteria

- [ ] Finished runs remain visible after server restart
- [ ] History filterable by saved test and status
- [ ] Old artifacts cleaned per retention policy
