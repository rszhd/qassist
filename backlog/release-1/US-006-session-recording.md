# US-006 — Session recording (record everything by default)

**As a** user, **I want** a video recording of every test run, **so that** I can review exactly what the agent did after the fact — especially for failures.

- **Status:** 🚧 Backend done (2026-07-22) — frontend link pending
- **Priority:** P1 (Release 1)
- **Estimate:** ~half a day
- **Depends on:** — (US-003 superseded; `runs/` retention now lives in US-020)

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
- **`record_video_dir` was rejected in the build (2026-07-22).** Chromium
  allows exactly one screencast per target, and US-002's viewer gating already
  owns it: browser-use's `RecordingWatchdog` starts its own screencast and
  only re-targets on tab switch, so our `stopScreencast` when the last viewer
  leaves would kill the recording for good. `run_agent.py` instead feeds its
  existing frame handler into browser-use's `VideoRecorderService`
  (`SessionRecorder`), which also gives a deterministic
  `runs/<runId>/recording.mp4` instead of the watchdog's uuid7 filename.
- `agent/requirements.txt` → `browser-use[video]` (imageio[ffmpeg] + numpy;
  the ffmpeg binary ships with the wheel, no apt package needed).
- Recording is on by default; `QA_RECORD=0` turns it off and restores US-002's
  "no viewer, no frame capture" path.
- A `{"type":"recording","file":...}` event is emitted before `done`/`error`
  (the error path defers its emit until after cleanup for exactly this), so
  the report data is built with the recording already known.
- `server.js`: `GET /api/runs/:id/recording` (`video/mp4`, `sendFile` so
  Range/seek works, bearer header **or** `?token=`); `GET /api/runs/:id`
  reports `hasRecording`; `runs.has_recording` is persisted.
- `make_report.py`: `recording_url` is absolute (needs `PUBLIC_BASE_URL`) or
  null; with `has_recording` but no public URL the report says the replay is
  in the run view rather than "Not available".
- Retention: `runs/` volume grows per run — add simple age-based cleanup or
  cap; revisit properly with US-011 (`artifacts_deleted_at` is already in the
  schema).

## Frontend (still open) — what the backend already gives you

- Live: a `{"type":"recording","file":"recording.mp4","frames":N}` event
  arrives on the run's WebSocket just before `end`. `RunView.jsx` can flip a
  flag on it — no extra request needed for a run you are watching.
- After the fact: `GET /api/runs/:id` returns `hasRecording` (true for a
  finished run whose artifacts are still on disk).
- The file: `GET /api/runs/:id/recording` → `video/mp4`, `sendFile`, so Range
  requests and seeking work.
- **Auth for the player: decided 2026-07-22 — `?token=` is accepted on this
  route**, so the frontend is a plain
  `<video src={`/api/runs/${id}/recording?token=${token}`} controls />`, not a
  fetched blob. `report.pdf`'s header-and-blob pattern would have re-downloaded
  the whole file and thrown away seeking. The query token is scoped to this one
  route (`checkTokenOrQuery` in `server.js`) because it leaks into access logs,
  browser history and Referer headers; `/ws` already accepts one the same way.
  Send nothing when the token is empty — auth may be off.
- Placement: the recording belongs on the finished-run view next to the
  report button. Progressive disclosure still applies — nothing new appears
  while a run is mid-flight or when there is no recording.

## Acceptance criteria

- [x] Every finished run has a playable video in `runs/<runId>/`
- [x] Video downloadable via authed API endpoint
- [x] PDF report links it when `PUBLIC_BASE_URL` is set, and says it exists
      otherwise
- [ ] Frontend plays/links it on the finished-run view
- [ ] CPU overhead ≤ ~0.2 vCPU per session at chosen fps (not yet measured on
      the VPS)

## Tradeoffs

- **The video is a condensed replay, not wall-clock.** Chromium only emits a
  screencast frame when the page repaints, so idle time collapses. Fixing it
  would mean padding with duplicate frames — more encode cost and file size
  for no review value. browser-use's own recorder has the same behavior.
- **Video quality is the live feed's quality**: one screencast serves both, at
  JPEG q55 capped to 1024×720. Frames are sampled to 3 fps and encoded
  synchronously in the frame handler (as browser-use does), a few ms per frame.
- **A watchdog kill (`SIGKILL`) leaves the mp4 unfinalized** — no chance to
  close the writer. The endpoint serves whatever landed on disk.
