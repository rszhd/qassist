# US-006 — Session recording (record everything by default)

**As a** user, **I want** a video recording of every test run, **so that** I can review exactly what the agent did after the fact — especially for failures.

- **Status:** 📋 Planned (design decided 2026-07-21; user deferred build)
- **Priority:** P2
- **Estimate:** ~half a day
- **Depends on:** US-003 recommended first (keeps `runs/` tidy)

## Decision

**Record everything by default.** The recording is part of the deliverable (the
PDF report sells it: "View recording"). Mitigate cost with low fps/resolution
rather than opt-in. Recording is independent of the live screencast (US-002
gating stays: no reason to JPEG-stream for a run nobody has open).

Cost note: video capture uses the same CDP frame path as the screencast plus
encoding, so recorded runs pay ~0.1–0.2 vCPU extra. Alternatives considered:
opt-in `"record": true` flag; retain-on-failure (delete video when run passes)
— revisit if CPU becomes the binding constraint at scale.

## Implementation notes

- browser-use 0.13.6 supports it natively: `BrowserProfile.record_video_dir`
  (alias `save_recording_path`), `record_video_size`, `record_video_framerate`
  (default 30 — use 2–4 fps for review purposes); `video_recorder.py` /
  `recording_watchdog.py` handle capture. Verified present in the deployed
  container at `/opt/venv/lib/python3.11/site-packages/browser_use/browser/`.
- Set `record_video_dir=runs/<runId>/` in `run_agent.py`; emit the final video
  filename in the `done` event.
- `server.js`: `GET /api/runs/:id/recording` serving the file (token-authed),
  Content-Type per container format.
- `make_report.py`: wire `recording_url` (currently always `null` placeholder)
  → report's "View recording" button becomes live.
- Frontend: link/button on the finished-run view.
- Retention: `runs/` volume grows per run — add simple age-based cleanup or
  cap; revisit properly with US-009 (control plane).

## Acceptance criteria

- [ ] Every finished run has a playable video in `runs/<runId>/`
- [ ] Video downloadable via authed API endpoint
- [ ] PDF report's "View recording" opens it
- [ ] CPU overhead ≤ ~0.2 vCPU per session at chosen fps
