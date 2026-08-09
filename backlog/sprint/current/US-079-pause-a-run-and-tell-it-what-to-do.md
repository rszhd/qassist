# US-079 — Pause a run, and tell it what to do

**As** someone watching the agent hunt for a button that is one click away,
**I want** to pause the run and type a sentence, **so that** the run finishes
the goal instead of being thrown away and started again with a longer prompt.

- **Status:** 📋 Planned — scheduled into `sprint/current/` on 2026-08-10, the
  day it was written.
- **Priority:** P2. Today the only lever on a live run is US-047's Stop, which
  is all-or-nothing: a run that is 80 % right and stuck ends with nothing
  proved, and the fix costs a full re-run on the user's own key (US-039). This
  makes something *possible* rather than better, which is the README's own
  reason to move a story up.
- **Estimate:** ~4 h.
- **Depends on:** US-047 (the stdin control channel, the `stopping` event and
  the grace-window precedent), US-076 (the activity timeline the hint appears
  in).

## Why now

Nothing in the product can talk to a run in flight. The stdin channel carries
`{"cmd":"screencast"}` and `{"cmd":"stop"}` and that is the whole vocabulary.
So the recovery for a stuck agent is: stop, edit the goal, run it again from
the first step — paying for every step that already worked.

browser-use has the levers, **verified against the pinned `0.13.6`
(2026-08-09)** by reading the installed source in `qassist:latest`:

- **`Agent.pause()` / `Agent.resume()`** (`agent/service.py`) set
  `state.paused` and clear/set `_external_pause_event`. That is the same flag
  `_check_stop_or_pause()` reads before every action *within* a step, not only
  between steps — so a pause lands within roughly one in-flight action, the
  same latency profile US-047 measured for the stop.
- **The comment is `_message_manager.add_new_task(text)`.** It wraps the text
  as `<follow_up_user_request>`, wraps the original goal as
  `<initial_user_request>` if it is not already, appends one to the other, and
  pushes a `HistoryItem` carrying the new text. It is **additive**: the hint
  corrects the agent, it does not replace the goal, and the agent keeps the
  history of what it has already done.

## Details

- **Call the message manager, not `Agent.add_new_task`.** The Agent-level
  wrapper does the same append, then also sets `state.follow_up_task`, resets
  `stopped` and `paused` to `False`, and **rebuilds `self.eventbus`** — that is
  machinery for restarting an agent whose `run()` has already returned (the bus
  is shut down after each run). Firing it mid-run tears down the bus the live
  loop is using. The one-line call underneath it does exactly what we want.
- **Three new control lines, no new channel:** `{"cmd":"pause"}`,
  `{"cmd":"hint","text":…}`, `{"cmd":"resume"}` in `stdin_control()`
  (`agent/run_agent.py:156`), beside the two that are there. A hint arriving
  while paused should append *and* resume, so the user types once and the run
  continues — but resume stays a separate command, because pausing to read the
  screencast without saying anything is a legitimate thing to want.
- **`POST /api/runs/:id/pause`, `/resume`, `/hint`**, scoped to the run's owner
  exactly as `/stop` is (`server/src/routes/runs.js:317`), and documented in
  `docs/api.md`. A queued run cannot be paused — there is no process — so that
  is a `409`, not a silent success.
- **`paused` is a flag on the live run, never a status.** US-047 already
  settled this shape and the reason is the same: `TERMINAL` drives
  `retention.js`'s pruning and `attachViewer`'s end-of-run announcement, and a
  paused run is still running. It is `run.paused` in `runState.js` plus a
  `paused` / `resumed` event in `runEvents.js` — the server's own, like
  `stopping`.
- **The wall clock is the part that needs a decision.** `RUN_TIMEOUT_MS`
  (`RUN_TIMEOUT_SECONDS`, default 600) exists because `MAX_STEPS` bounds steps
  and not time, and its kill path reports the run as a resource failure. A
  paused run left on someone's second monitor would be killed as if it had hung
  — and simply pausing the watchdog turns a forgotten pause into a leaked
  browser, a leaked process and a held concurrency slot. Proposal: the pause
  suspends the wall-clock watchdog and starts its own `PAUSE_MAX_SECONDS`
  budget (default ~600) that escalates to `stopRun`, so a forgotten pause ends
  the way an abandoned run should — `cancelled`, with its partial evidence
  intact — rather than as an error nobody caused.
- **The hint is evidence, and it goes in the report.** A run that passed
  because a human said "the button is in the account menu" is a different fact
  from a run that passed alone. The hint text and its timestamp belong in the
  step timeline (US-076) and on the PDF, and the report should state plainly
  that the run was assisted. Without that the verdict quietly overstates what
  was proved — the same failure class as US-047's `success: true` on a stopped
  run.
- **The tested app's own session can expire while the run is paused** (US-043),
  and browser-use's own comment on `resume()` notes the browser can be found
  closed. So resume is not guaranteed to work; a resume that lands on a dead
  session must fail the run honestly rather than looking like the agent lost
  its way.
- **Minor: `pause()` and `resume()` `print()` to stdout**, which is the NDJSON
  channel. This does not corrupt anything — `runs.js:576` turns an unparseable
  line into a `log` event — but the viewer would show "Press [Enter] to resume
  or [Ctrl+C] again to quit", which is untrue in our UI. Suppress it.

## Correctness-critical candidate

The pause/timeout interaction is the assertion-first candidate here, and it is
the shape the Workflow rule describes: two timers, one of which must be
suspended and the other started, invisible until a box is full or a run is
abandoned. The failures are that a paused run is killed as `error` by the
watchdog it should not be answering to; that a resumed run comes back with no
wall-clock bound at all; and that a pause holds its concurrency slot forever.
The register row goes in when the work starts, not now.

The rest — the routes, the control lines, the flag, the buttons — is ordinary
wiring and stays test-alongside.

## Acceptance criteria

- [ ] A running run can be paused and resumed by its owner, from the Run view
      and from the live `RunDetail`, and the screencast keeps working while
      paused
- [ ] A hint typed while paused reaches the agent as a follow-up request, the
      original goal survives, and the run continues from the step it was on —
      not from the first step
- [ ] A hint can also be sent to a running run without pausing first
- [ ] A paused run is bounded: it does not hold a slot indefinitely, and the
      bound ends it as `cancelled` with its evidence, not as a timeout error
- [ ] The hint and its time appear in the run's activity and on the report, and
      the report states the run was assisted
- [ ] A queued run cannot be paused; a finished one cannot be resumed
- [ ] One user cannot pause, resume or hint another's run
- [ ] `docs/api.md` documents the three endpoints; `manual/` says what the
      feature is for and what it costs a verdict
