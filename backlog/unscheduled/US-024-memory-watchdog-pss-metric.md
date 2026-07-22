# US-024 — Memory watchdog: measure PSS, not summed RSS

**As an** operator, **I want** the per-run memory watchdog to measure what the
machine actually pays, **so that** healthy runs are not killed and the limit is
a number I can size a VPS against.

- **Status:** 📋 Planned
- **Priority:** P2 (unscheduled — the 1600 MB default unblocks runs for now)
- **Estimate:** ~half a day (incl. re-measuring)
- **Depends on:** — (amends US-004, measured against US-006)

## Problem

`processTree()` in `server/src/runs.js` sums `/proc/<pid>/stat` RSS over the
run's descendants. Chromium runs 6–7 processes that share a large amount of
memory, and summed RSS counts every shared page once per process — so the
metric reports roughly **1.8× the real footprint**.

Measured 2026-07-22 on a local run (headless Chromium, `try.discourse.org`, no
viewer attached, same `BrowserProfile` as `run_agent.py`):

| | tree RSS sum (current metric) | PSS (real) | procs |
|---|---|---|---|
| `QA_RECORD=0` | 1076 MB | 584 MB | 7 |
| recording on (default) | 1177 MB | 663 MB | 8 |

Per-process at peak with recording: renderer 332 MB, browser 195 MB, gpu
155 MB, renderer 132 MB, python 119 MB, utilities 117 + 88 MB, ffmpeg 40 MB.

This surfaced when US-006 landed: recording adds ~100 MB (ffmpeg process 40 MB,
numpy/imageio imports ~21 MB measured, ~40 MB of Chromium capture pipeline
because a recorder keeps the screencast running for the whole session even
with no viewer). That left 23 MB of headroom under the old 1200 MB limit and a
normal run was killed with `resource limit exceeded: run used 1222 MB`.

**Stopgap already applied (2026-07-22):** `MAX_RUN_MEMORY_MB` default raised
1200 → 1600. That unblocks runs but keeps a number that means nothing — it
must be re-tuned again for every feature that adds a process, and it can't be
used to size a host.

## Proposed fix

- Read `Pss:` from `/proc/<pid>/smaps_rollup` per pid, fall back to `stat` RSS
  when it is unreadable (old kernel, permissions) — one extra small read per
  pid per 3 s poll over ~8 pids, negligible next to the existing `/proc` scan.
- Re-baseline `MAX_RUN_MEMORY_MB` in PSS terms: ~1000 MB gives ~50% headroom
  over the measured 663 MB recording peak.
- **Breaking for anyone who set `MAX_RUN_MEMORY_MB` explicitly** — the unit
  changes meaning. Note it in the README env table and the release notes.
- Re-measure with US-020 in place (step screenshots may add to the peak).

## Acceptance criteria

- [ ] Watchdog reports PSS, with an RSS fallback that is logged once
- [ ] Default limit re-baselined against a fresh measurement
- [ ] README env table documents the unit and the sizing rule it implies
- [ ] US-004 amended with the corrected metric and numbers

## Notes

- The probe used for these numbers launches the profile, navigates and runs the
  real `screencast()` coroutine with no LLM involved — worth rebuilding as a
  committed script if this gets measured a third time.
- Sizing implication once the metric is honest: ~700 MB per concurrent run, so
  `MAX_CONCURRENT_SESSIONS`'s `floor((RAM_GB − 1.5) / 1)` rule is roughly right
  but conservative.
