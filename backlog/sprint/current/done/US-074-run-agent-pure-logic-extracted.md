# US-074 — `run_agent.py`: move the pure logic where the tests can reach it

**As a** maintainer, **I want** the pure logic inside `run_agent.py` extracted
into stdlib-importable modules, **so that** the agent suite covers the
orchestrator's decisions and not only its helpers.

- **Status:** ✅ **Done** 2026-08-05, 6/6 — three extractions, then the
  step-boundary assertion, reviewed and closed the same day. The extraction
  policy below outlives the story
- **Priority:** P3 (the code works; a regression here surfaces as a broken run,
  quickly. The incremental policy below is the substance)
- **Estimate:** spent — three extractions plus one reviewed assertion
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

## The step-boundary assertion (2026-08-05)

`TestStepBoundary` in `agent/tests/test_step_events.py`, 10 cases, suite 274 →
284. Written as a candidate under the assertion-first rule and reviewed before
the story closed.

**Writing it disproved the failure this story stated.** "Advance the
attribution before flushing and a step's findings are filed against the next
step" cannot happen against the current `Diagnostics`. `_add` stamps `step` and
charges the per-step cap when a finding is **captured**, and there is no `await`
between `flush_diagnostics()` and `set_step()`, so the two calls commute:
swapping them produces byte-identical NDJSON over a three-step scenario with a
chatty step 1. The claim was in the `callback` docstring and in the register row,
and both said it with confidence.

So the assertion pins the property the order exists to protect, not the order:

- A finding is filed against the step that was in flight when it happened, and
  one that predates step 1 is filed against no step. Both fail if the stamp
  moves to drain time.
- A chatty step cannot spend the next step's evidence budget — the case fails if
  `set_step` stops being called at every boundary, which is the *real* route to
  a failed run with a clean evidence section.
- What one boundary hands over, the next does not repeat, and a boundary with
  nothing to say emits no batch.
- The fence's blocks reach the feed above the step heading that follows them.
- No collaborator can raise past the callback: each of the three costs one
  `warn` and the run continues.

Mutation-checked by hand, not assumed: dropping `set_step` fails 3 cases,
stamping the step at drain time fails 2, and swapping flush with advance fails
none — which is the finding, stated at the top of the test file and in the
`callback` docstring rather than left for the next reader to rediscover.

**One trade-off, surfaced and accepted.** The callback's body is a single `try`,
so a collaborator that raises takes that step's event with it and the live feed
skips a heading. Per-call guards would keep the event; the single wrapper is
simpler and a reporting bug that costs one heading still costs no run. Pinned by
the case rather than left implicit, so the day it matters the assertion is
already there to change deliberately.

The policy above does not close with this. It runs for as long as `run_agent.py`
has pure logic left in it.
