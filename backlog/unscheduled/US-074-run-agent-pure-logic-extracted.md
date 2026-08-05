# US-074 — `run_agent.py`: move the pure logic where the tests can reach it

**As a** maintainer, **I want** the pure logic inside `run_agent.py` extracted
into stdlib-importable modules, **so that** the agent suite covers the
orchestrator's decisions and not only its helpers.

- **Status:** 📋 Planned
- **Priority:** P3 (unscheduled — the code works; a regression here surfaces as
  a broken run, quickly. The incremental policy below is the substance)
- **Estimate:** incremental — extract when touched, US-065's pattern
- **Depends on:** —

## Problem

The agent suite is stdlib-only by design — no browser-use, no Playwright — and
every extracted helper module is tested: `diagnostics.py`, `redact.py`,
`navigation_policy.py`, `email_codes.py`, each was `run_agent.py`'s logic once.
But `run_agent.py` itself imports `browser_use` at module top, so the host can
never import it; only the throwaway-container import check sees it at all.
Everything still defined inside — `SessionRecorder`, `report_blocks`' scan
and dedup, `on_step`'s ordering (report blocks → flush diagnostics → advance
step attribution), the step-event assembly — sits outside the test regime the
project built. The convention "add a case per pure helper touched" stops at
this file's boundary, and the file is 885 lines (2026-08-05).

`on_step`'s ordering is the sharp part: flush-then-advance is what stops a
chatty first step silencing the one that fails. That is the subtle,
easy-to-regress shape the assertion-first rule exists for, and no assertion can
currently reach it.

## Policy (starts now, needs no scheduling)

When a change touches logic inside `run_agent.py` that does not itself need
`browser_use`, extract it to a module first, put the assertion on it, then make
the change. The story closes when the leftovers are genuinely wiring.

## Acceptance criteria

- [ ] Step-event assembly (what `on_step` emits, given a browser state and an
      agent output) is a pure function with tests
- [ ] `report_blocks`' scan-dedup-emit loop is importable and tested
      (`blocked_url_in` already is; the loop around it is not)
- [ ] `SessionRecorder` lives in its own module, its start/stop/add contract
      tested against an injected fake recorder
- [ ] What remains in `run_agent.py` needs `browser_use` to mean anything:
      `main()`, the callbacks' wiring, the CDP hookup
- [ ] Each extraction lands with its tests in the same commit; suite stays
      stdlib-only
