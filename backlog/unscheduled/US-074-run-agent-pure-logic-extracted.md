# US-074 — `run_agent.py`: move the pure logic where the tests can reach it

**As a** maintainer, **I want** the pure logic inside `run_agent.py` extracted
into stdlib-importable modules, **so that** the agent suite covers the
orchestrator's decisions and not only its helpers.

- **Status:** 🚧 Three extractions done 2026-08-05; open on one assertion (below)
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

- [x] Step-event assembly (what `on_step` emits, given a browser state and an
      agent output) is a pure function with tests
- [x] `report_blocks`' scan-dedup-emit loop is importable and tested
      (`blocked_url_in` already is; the loop around it is not)
- [x] `SessionRecorder` lives in its own module, its start/stop/add contract
      tested against an injected fake recorder
- [x] What remains in `run_agent.py` needs `browser_use` to mean anything:
      `main()`, the callbacks' wiring, the CDP hookup
- [x] Each extraction lands with its tests in the same commit; suite stays
      stdlib-only

## Results (2026-08-05)

`run_agent.py` 884 → 824 lines; agent suite 249 → 274 cases, still stdlib-only.
Nothing about a run changed — this is a move plus the assertions the move made
possible.

**Where the three went.**

- `session_recorder.py` — `SessionRecorder`, minus everything browser-use.
  `run_agent.recorder_for` keeps the PIL decode, the `VideoRecorderService`
  construction and the `_is_active` check in one closure and hands it in as
  `start_service(frame) -> service | None`. `None` is the module's whole
  vocabulary for "unavailable, already reported", which is what stops it
  retrying a missing codec once per frame.
- `step_events.py` — `save_screenshot`, `step_event`, and `callback`, which
  takes `report_blocks` / `flush_diagnostics` / `set_step` as plain callables.
- `navigation_policy.new_blocks` — `report_blocks`' scan-dedup half, beside the
  `blocked_url_in` it already calls. What is left in `run_agent.py` reads
  `agent.history.errors` and emits, which is wiring.

**The seam is the deliverable, not the tidiness.** Both extractions that
survived contact with the browser did so by inverting one call: the recorder
does not construct an encoder, it is handed one; the callback does not reach for
`diag`, it is handed three functions. Neither module imports `browser_use`, so
the host can import both — which is the only property that matters here, because
`run_agent.py`'s module-top `browser_use` import is why none of this was
reachable before. A module that merely *moved* out of that file and still
imported the library would have bought nothing.

**Two things the assertions found that the code was already right about,** and
both were written down rather than left implicit:

- `SessionRecorder` sampled against `_last_add = 0.0`. A frame is admitted when
  `now - _last_add >= RECORD_MIN_INTERVAL`, so the *first* frame was admitted
  because `time.monotonic()` happens to read well above ⅓ on any real box — not
  because the sampler meant to admit it. Under an injected clock starting at
  zero it was dropped, and the first frame is the one the video is sized from.
  Now `None`, which says "never sampled" in the sampler's own terms.
- The sampler measures from the last frame it **encoded**, not the last it
  **saw**. Measuring from the last seen frame means a page repainting faster
  than the interval never leaves a gap, so nothing after the first frame is ever
  encoded and the recording is one still image — which reads as a broken page,
  not a broken sampler. `test_a_dropped_frame_does_not_reset_the_interval`.

**Open: the step-boundary ordering.** Report blocks → flush → advance is an
assertion-first surface and now has a row in
[`correctness-critical.md`](../correctness-critical.md). The maintainer
writes that assertion; `step_events.callback` is built to receive it and
`test_step_events.py` says so at the top and covers assembly only. Advancing
before flushing files a step's findings against the following step; not
refreshing the cap budget lets a chatty first step spend the run's evidence
allowance, so the step that actually fails reports nothing — a failed run with a
clean evidence section, which is the loud failure wearing quiet clothes.

The story stays open on that one assertion. The policy above does not wait for
it.
