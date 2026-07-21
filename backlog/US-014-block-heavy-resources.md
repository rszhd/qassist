# US-014 — Block heavy page resources during tests

**As a** platform operator, **I want** test browsers to skip loading media and tracking resources, **so that** pages load faster and lighter — shorter runs free their slots sooner.

- **Status:** 📋 Planned
- **Priority:** P3
- **Estimate:** ~half a day (incl. verifying no visual regressions)
- **Depends on:** —

## Details

- Block via CDP `Network.setBlockedURLs` (or browser-use config if exposed):
  video/media files, font downloads, known analytics/ad domains.
- **Keep images** — the agent reasons from screenshots; blocking images would
  blind it and change pass/fail behavior.
- Shorter page loads are a double win: less CPU/RAM *and* faster slot turnover
  (a run finishing in 90 s instead of 150 s is ~40% more throughput per slot).

## Risks

- A site whose *goal* involves media (e.g. "play the video") would break —
  make the blocklist per-run overridable (`"block_resources": false`).
- Blocked fonts can shift layout slightly; screenshots may differ from a real
  user's view. Acceptable for goal-based verdicts; note in docs.

## Acceptance criteria

- [ ] Standard test suite (example.com, Wikipedia flow) passes with blocking on
- [ ] Measurable reduction in run duration and/or RSS on a media-heavy page
- [ ] Per-run opt-out works
