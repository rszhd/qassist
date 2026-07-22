# US-001 — Reduce per-session Chromium memory

**As a** platform operator, **I want** each test browser to use as little RAM as possible, **so that** one server can run more concurrent tests.

- **Status:** ✅ Done (2026-07-21, deployed to VPS)
- **Priority:** P1
- **Estimate:** ~10 min
- **Depends on:** —

## Details

Chromium's defaults assume a desktop user: site isolation spawns a process per
site (6–10 per page), plus GPU process, background networking, translate, etc.
Test sessions are ephemeral 2-minute runs — trade crash-resilience for fewer,
smaller processes.

Flags added to `BrowserProfile` in `agent/run_agent.py`:

```
--disable-gpu
--process-per-site
--renderer-process-limit=3
--js-flags=--max-old-space-size=256
--disable-extensions
--mute-audio
--disable-background-networking
--disable-features=Translate,BackForwardCache,AcceptCHFrame
```

## Acceptance criteria

- [x] Existing tests still pass (verified: example.com + multi-page Wikipedia flow)
- [x] Measurable RAM reduction per session

## Results (measured on VPS)

| Run | Before | After |
|---|---|---|
| example.com — peak Chromium RSS | 1.34 GB / 23 procs | 0.86 GB / 9 procs (−37%) |
| Wikipedia multi-page — peak RSS | — | 1.05 GB / 18 procs |

Sizing rule can move from `floor((RAM−1.5)/1)` toward `floor((RAM−1.5)/0.85)`;
gather more data on heavy sites before raising `MAX_CONCURRENT_SESSIONS`.

## Tradeoffs

- Fewer shared renderer processes: a crashing iframe can take down its page →
  that one run fails. Blast radius is still one run / one user.
- 256 MB JS heap cap could bite on very heavy web apps; remove the flag for a
  specific site if it ever misbehaves.
