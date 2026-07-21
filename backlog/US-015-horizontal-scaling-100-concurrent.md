# US-015 — Horizontal scaling to ~100 concurrent sessions

**As a** platform operator, **I want** runs distributed across multiple worker VPSes behind a dispatcher, **so that** the service scales to ~100 concurrent tests with fault isolation and cheap incremental growth.

- **Status:** 📋 Planned (sizing analysis done 2026-07-21)
- **Priority:** P3 — build when demand approaches current capacity
- **Estimate:** ~1 week
- **Depends on:** US-005 (BYOK — removes LLM rate-limit ceiling), US-009
  (control plane is the natural dispatcher/queue); US-001/002/003 reduce the
  per-session cost first

## Sizing (post-US-001/002 measurements)

- Per session: ~0.5–0.6 GB RAM peak, ~0.2 vCPU average (unwatched).
- 100 sessions ≈ **64 GB RAM / 24–32 vCPU** total → e.g. **4 × (16 vCPU /
  32 GB)** VPSes at `MAX_CONCURRENT_SESSIONS≈25` each, or 2× with a queue
  absorbing bursts.
- Preferred over one big box (128 GB dedicated): fault isolation (one OOM
  can't take out all runs), cheaper incremental scaling.
- "100 concurrent requests" ≠ 100 simultaneous browsers — with queueing,
  60–70 slots typically serve a 100-concurrent-request load.

## Design

- Workers stay exactly as today: stateless, token-authed, same Docker image.
- Dispatcher (in the control plane) picks a worker with free slots, remembers
  runId→worker mapping, proxies/redirects status + WS + artifacts.
- Queue lives in the control plane (Postgres), replacing per-worker queues for
  cross-worker fairness.
- Per-run hard memory cap becomes practical here: one Docker container per run
  with `--memory=1g` (see US-004 for the interim soft watchdog).
- OS tuning per worker at high density: `ulimit -n`, `pid_max`, Docker shm
  size.

## Acceptance criteria

- [ ] Runs distribute across ≥2 workers transparently (same API surface)
- [ ] One worker going down fails only its own runs; new runs route around it
- [ ] Sustained 100-concurrent-request load test completes without OOM or
      queue starvation
