# US-047 — Stop a run

**As** someone watching a run go visibly wrong, **I want** to stop it, **so
that** I am not paying for thirty more steps of an agent hunting for a button
that does not exist — and so that the partial evidence survives.

- **Status:** 📋 Planned.
- **Priority:** P3 among the unscheduled work, but it is a conspicuous absence:
  the Run view streams a live session with no way to end it.
- **Estimate:** ~3 h.
- **Depends on:** nothing.

## Why now

There is **no stop or cancel path in the product at all** — `grep` over
`server/src` finds no `/stop`, no `/cancel`, no `stopRun`. A run ends when the
agent finishes, when `QA_MAX_STEPS` runs out, or when the memory watchdog
`SIGKILL`s the process tree (`killRunTree`, `server/src/runs.js:389`). A user
who can see the agent looping on the wrong page can only wait, spending their
own key the whole time (US-039).

`SIGKILL` is also the wrong instrument even where we use it: the recording is
never finalized (`SessionRecorder.stop()` never runs, so `recording.mp4` has no
moov atom and is unplayable), no `done` event is emitted, and `make_report.py`
never runs. Everything the run had gathered is lost at exactly the moment
someone wanted to look at it.

browser-use has the graceful lever: **`register_should_stop_callback`**, an
`Agent` constructor parameter polled around the step loop. Returning `True`
finishes the current step and exits the loop normally — `history` is intact, the
`finally` block in `run_agent.py` runs, the recording is finalized, the report
is built.

## Details

- **The transport already exists.** Express writes control lines to the agent's
  stdin — `{"cmd":"screencast","on":bool}` — and `stdin_control()` reads them.
  A `{"cmd":"stop"}` line setting an `asyncio.Event` that the should-stop
  callback reads is a handful of lines on both sides. No new channel, no signals.
- `POST /api/runs/:id/stop`, scoped to the run's owner, plus a button in the Run
  view and the live `RunDetail`. A queued run is simply dequeued.
- **`cancelled` is a terminal status of its own**, not a failure. A stopped run
  is not a red build, and CI (US-008) must not treat it as one — it should not
  contribute to a suite's exit code the way a real failure does.
- Keep `killRunTree` as the backstop with a timeout: an agent wedged inside a
  step will not reach the callback, so a stop that has not landed within a few
  seconds escalates to the existing kill. That is also the honest reason not to
  delete the hard path.
- The partial artifacts are the point: whatever steps ran are reported, the
  recording plays, and the report says the run was stopped rather than pretending
  a verdict.

## Acceptance criteria

- [ ] A running run can be stopped by its owner; a queued one is dequeued and
      never spawns
- [ ] A stopped run ends in a distinct `cancelled` status, visible in History and
      excluded from failure emails (US-012) and from CI's non-zero exit (US-008)
- [ ] The recording of a stopped run is finalized and plays; the steps that ran
      are in the report, which states the run was stopped
- [ ] The freed concurrency slot is released and the queue advances
- [ ] A wedged agent that does not honour the stop is killed by the existing
      watchdog path within a bounded time, and still ends `cancelled`
- [ ] One user cannot stop another's run
