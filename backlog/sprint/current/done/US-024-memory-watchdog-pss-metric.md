# US-024 — Memory watchdog: measure PSS, not summed RSS

**As an** operator, **I want** the per-run memory watchdog to measure what the
machine actually pays, **so that** healthy runs are not killed and the limit is
a number I can size a VPS against.

- **Status:** ✅ Done 2026-08-05
- **Priority:** P2 (pulled into the current sprint 2026-08-05)
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

- [x] Watchdog reports PSS, with an RSS fallback that is logged once
- [x] Default limit re-baselined against a fresh measurement
- [x] README env table documents the unit and the sizing rule it implies
- [x] US-004 amended with the corrected metric and numbers

## Notes

- The probe used for these numbers launches the profile, navigates and runs the
  real `screencast()` coroutine with no LLM involved — worth rebuilding as a
  committed script if this gets measured a third time.
- Sizing implication once the metric is honest: ~700 MB per concurrent run, so
  `MAX_CONCURRENT_SESSIONS`'s `floor((RAM_GB − 1.5) / 1)` rule is roughly right
  but conservative.

## Results (2026-08-05)

`processTree` moved out of `runs.js` into **`server/src/procMemory.js`**, taking
a `procRoot` parameter so the metric is assertable against a fake `/proc`
without root or a real process — the reason it is now a module of its own.
Per pid it reads `Pss:` from `smaps_rollup` and falls back to `stat` RSS.
`MAX_RUN_MEMORY_MB` 1600 → **1000**.

**Re-measurement**, `agent/measure_memory.py --url https://try.discourse.org
--seconds 60`, headless Chromium in `qassist:latest`, no viewer attached:

| | tree RSS sum (old metric) | PSS (new metric) | procs |
|---|---|---|---|
| `QA_RECORD=0` | 1088 MB | 621 MB | 7 |
| recording on (default) | 1187 MB | 704 MB | 8 |

Both are ~1 % above 2026-07-22, so the drift over a fortnight of feature work is
noise, not a trend. The overstatement is **1.69x** with recording and 1.75x
without — the 2026-07-22 file estimated 1.8x. Per-process PSS at peak with
recording: renderer 211, browser 131, python 116, gpu 72, ffmpeg 54, extension
49, utilities 43 + 29. Recording costs 83 MB PSS, of which ffmpeg is 54.

**1000 MB is not a tightening.** The 1600 MB it replaces permitted ~947 MB of
PSS at the measured 1.69x ratio, so the new limit is marginally *more*
permissive while meaning something. That was the deciding argument over the
~1050 that a flat 50 % headroom over 704 MB would have given: a re-baseline
that quietly narrowed the envelope would be found by a killed run, not by
reading the diff.

**The sizing rule followed** (2026-08-05, maintainer's call). `MAX_CONCURRENT_
SESSIONS`'s rule of thumb was `floor((RAM_GB − 1.5) / 1)` and is now
`floor((RAM_GB − 1.5) / 0.7)`, stated the same way in `README.md`,
`.env.example`, `docs/deploy/production.md` and `docs/quickstart.md`. The old
divisor was conservative *by accident* — it inherited the 1.7x over-count — so
leaving it would have kept the README contradicting its own new 700 MB figure
in the adjacent row. The **default stays 4**: this is guidance, not a capacity
change, and no instance re-sizes itself. Documented as a ceiling to size down
from, because 700 MB is one page with no LLM in the loop; on 7.6 GB the rule
now says 8 where it said 6.

### The RSS fallback is the part that needed the assertions

`smaps_rollup` is absent before Linux 4.14 and unreadable without ptrace access,
so the fallback is real. Substituting *that pid's* RSS makes the tree total
neither metric — it over-reports by exactly the shared pages of the process that
could not be read, and Chromium's renderer is both the largest sharer and the
one most likely to be unreadable. So `processTree` returns `fellBack` naming
those pids rather than folding them into a number called PSS, and `runs.js`
warns once per **process**: whether a box can report PSS is a property of its
kernel and permissions, not of any one run, and a per-poll log would repeat
every 3 s forever.

Raised as an assertion-first candidate before implementing, on the grounds that
the result is only ever compared against a single threshold: a unit slip is off
by 1024x (kB read as bytes) or 4x (kB read as pages) and still looks like a
memory reading, and nothing downstream contradicts it. Both directions fail
silently — too high kills healthy runs, which is exactly how US-006 surfaced
this; too low and the watchdog stops guarding without ever saying so.
`server/test/proc-memory.test.js` pins nine cases: the kB unit, PSS *replacing*
rather than adding to RSS, a shared-heavy tree summing to per-process PSS, the
fallback and its report, a malformed `Pss:` line falling back instead of
counting zero (the one failure that removes the guard entirely), descendants
only and to any depth, a pid exiting mid-scan, a dead root, and an unreadable
`/proc`.

`server` suite 724 pass, `npm run check` clean.

### Not done

- **US-020 was excluded deliberately** (maintainer's call, 2026-08-05). It is
  open in this same sprint, so step screenshots are not in the measured peak.
  The 1.4x headroom absorbs a per-step JPEG comfortably, but the number to
  re-measure against is the one above, with the probe.
- **The release notes still owe the breaking-change line.** There is no
  changelog file in the repo — release notes are written by hand at tag time —
  so the README env row carries the warning and this is the reminder. A value
  an operator set explicitly before this change needs dividing by ~1.7.
- `PAGE_BYTES` is still hardcoded 4096 on the fallback path, as it was before.
  Node has no `sysconf`, and on a 16K-page kernel it under-reports, which errs
  towards letting a run live.
