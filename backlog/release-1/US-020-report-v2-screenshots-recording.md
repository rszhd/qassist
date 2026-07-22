# US-020 — Report v2: embedded step screenshots + recording

**As a** user, **I want** the report to show per-step screenshots and give me the session recording, **so that** I can see exactly what the agent did — especially on failures — without rerunning the test.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1)
- **Estimate:** ~1–2 days
- **Depends on:** US-006 (recording must exist to link/embed)

## Context

Supersedes **US-003**: the per-step PNGs the agent already saves in
`runs/<runId>/step_N.png` were slated for deletion as unused; the release-1
report makes them a feature instead. The current report is a deliberate
single-page "verdict band" design — embedding screenshots means evolving the
layout (steps section / appendix pages), not bolting images onto the band.

## Details

- Keep the existing screenshot-save path in `run_agent.py` `on_step` (it
  already works); consider downscaling PNGs at save time — full-resolution
  frames are report-quality overkill and `runs/` grows fast.
- `make_report.py`: add a steps section — per step: screenshot thumbnail,
  action/evaluation text, timing. Keep page 1 as the verdict band summary.
- Wire `recording_url` (currently always `null`) so the "View recording"
  button works — the PDF links to the authed recording endpoint from US-006.
- Retention: `runs/` now durably holds PNGs + video + PDF per run — add
  age-based cleanup or a size cap (was US-003's concern; it lands here).

## Acceptance criteria

- [ ] Report shows a screenshot per step alongside the step's action text
- [ ] "View recording" in the report opens the run's video
- [ ] Report generation time stays reasonable (< a few seconds per run)
- [ ] `runs/` cleanup keeps disk usage bounded
