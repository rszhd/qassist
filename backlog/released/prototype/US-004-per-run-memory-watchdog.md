# US-004 — Per-run memory watchdog

**As a** platform operator, **I want** a runaway test killed automatically when it exceeds a memory limit, **so that** one heavy/leaky page can never starve the other users' runs on the same server.

- **Status:** ✅ Done (2026-07-21)
- **Priority:** P2
- **Estimate:** ~1 h
- **Depends on:** —

## Details

Soft cap enforced by Express, which already owns each run's child process:

- Every few seconds, measure the run's **process tree** RSS (e.g. `pidusage`
  with children, or walk `/proc`). Chromium is many processes — must sum the
  tree, not just the Python parent.
- Over limit (default ~1.2 GB, env `MAX_RUN_MEMORY_MB`) → kill the process
  tree, mark run `failed` with reason `resource limit exceeded`, emit the
  event to subscribers, still generate the report.

Backstops / later hardening:

- Container-level `mem_limit` in docker-compose protects the VPS itself
  (blunt: Docker may OOM-kill the whole app).
- Hard OS-level cap = one Docker container per run with `--memory=1g` — do as
  part of US-011 (horizontal scaling), not before.

## Acceptance criteria

- [x] A run exceeding the limit is killed within ~10 s and reported as failed
      with a clear reason (API + UI + PDF)
- [x] Other concurrent runs are unaffected
- [x] Normal runs (≤1 GB peak) never trip it

## Results (2026-07-21)

Implemented in `server/src/server.js`: no new dependency — walks `/proc`
(sums RSS over the child's descendant tree, 3 s poll), agent now spawned
`detached: true` so the whole process group can be SIGKILLed; the `/proc`
pid list is killed too as a backstop. On trip: status → `failed`,
`result.message` = `resource limit exceeded: run used N MB (limit M MB)`,
an `error` event goes to subscribers (UI shows the banner), report is still
generated, and the normal `close` path emits `end` + starts the next queued
run. Env: `MAX_RUN_MEMORY_MB` (default raised 1200 → 1600 on 2026-07-22).

**Amendment (2026-07-22):** summing RSS double-counts Chromium's shared pages
— a recording run measures 1177 MB by this metric but only 663 MB PSS. US-006
added ~100 MB and started tripping the 1200 MB limit on healthy runs, so the
default was raised to 1600 as a stopgap.

**Amendment (2026-08-05, [US-024](../../sprint/current/done/US-024-memory-watchdog-pss-metric.md)):**
the metric is now PSS, read from `/proc/<pid>/smaps_rollup`, and the walk moved
out of `runs.js` into `server/src/procMemory.js`. Default `MAX_RUN_MEMORY_MB`
1600 → **1000**, and the unit it is expressed in changed with it. Corrected
numbers for a recording run: **704 MB PSS**, against 1187 MB by the old summed
RSS — the ratio is 1.69x, not the 1.8x estimated in 2026-07-22. The
`≤1 GB peak` in the acceptance criteria above was written in the old unit and
reads as ~590 MB in this one.

Verified locally with a stub agent (300 MB cap): single-process hog killed
in ~4 s at 310 MB; multi-process hog (parent + 2 allocating grandchildren)
killed at 390 MB summed across 3 pids, no orphans; a concurrent normal run
was unaffected and finished `passed`; killed run's `report.pdf` served 200.
