# US-020 — Report v2: embedded step screenshots + recording

**As a** user, **I want** the report to show per-step screenshots and give me the session recording, **so that** I can see exactly what the agent did — especially on failures — without rerunning the test.

- **Status:** 📋 Planned. Left the current sprint on 2026-07-23 (that sprint was the
  self-host launch, and a better report is not what gates it) and was pulled back
  into it on 2026-07-27, once the release plumbing stopped needing attention.
- **Priority:** P2 — lowered 2026-07-23 because it blocks nothing, so it yielded
  to US-010/US-012 and then out of the release entirely. It is now scheduled
  ahead of US-044 (`sprint/next/`), which needs the layout this story builds.
- **Estimate:** ~1–2 days
- **Depends on:** US-006 (recording must exist to link/embed)

## Context

Supersedes **US-003**: the per-step PNGs the agent already saves in
`runs/<runId>/step_N.png` were slated for deletion as unused; the current-sprint
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
- **Non-secret variables block** (from US-035): render the run's resolved
  non-secret variables — the environment it hit, e.g. `base_url=…` — so a
  shared PDF is attributable without opening the app. The data is already on
  `run.variables` (secret values are the marker `<secret>`, never the value);
  RunDetail shows it in-app, the report doesn't yet. A small facts-row addition,
  not a layout change — but it waits for the layout rework rather than bolting
  onto the current verdict band.
- **The step section is step-keyed, which is why `report_data.json` carries no
  `progress` events** (decided in US-026). It renders `Step {n}`, and a
  progress event has no step number to key on. Revisit that omission if the
  section stops being keyed by step.

## Acceptance criteria

- [ ] Report shows a screenshot per step alongside the step's action text
- [ ] "View recording" in the report opens the run's video
- [ ] Report generation time stays reasonable (< a few seconds per run)
- [ ] `runs/` cleanup keeps disk usage bounded
- [ ] Report shows the run's non-secret variables (from US-035); secrets never
      appear un-redacted
