# US-004 — Per-run memory watchdog

**As a** platform operator, **I want** a runaway test killed automatically when it exceeds a memory limit, **so that** one heavy/leaky page can never starve the other users' runs on the same server.

- **Status:** 📋 Planned
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

- [ ] A run exceeding the limit is killed within ~10 s and reported as failed
      with a clear reason (API + UI + PDF)
- [ ] Other concurrent runs are unaffected
- [ ] Normal runs (≤1 GB peak) never trip it
