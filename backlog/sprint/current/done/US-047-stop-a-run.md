# US-047 — Stop a run

**As** someone watching a run go visibly wrong, **I want** to stop it, **so
that** I am not paying for thirty more steps of an agent hunting for a button
that does not exist — and so that the partial evidence survives.

- **Status:** ✅ **Done 2026-07-27, 6/6.** The engine, the route, the `cancelled`
  status and its migration, the agent's graceful stop, the report, the mail
  rule, CI's exit code, and the frontend — the Stop button in the Run view and
  in the live `RunDetail`, the status's colour and its word. Closed by the one
  claim no fixture could make: a real stopped run, watched back, plays through
  the steps it took. See [Results](#results).
- **Priority:** P3 while it sat unscheduled, but it is a conspicuous absence —
  the Run view streams a live session with no way to end it — and the release
  plumbing that outranked it is nearly done.
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

browser-use has the graceful lever, **verified against the pinned `0.13.6`
(2026-07-26)**: `Agent.stop()` (`agent/service.py:3912`) sets `state.stopped`
and releases the pause event; `register_should_stop_callback` (constructor
param, `service.py:164`) is the polled variant onto the same flag. The exit is
clean — the `InterruptedError` it raises is explicitly classified "not an error"
(`service.py:1254`), the loop breaks with `agent_run_error = 'Agent stopped
programmatically'`, and **`agent.run()` returns history normally**. So the
`finally` block in `run_agent.py` runs, the recording is finalized, the report
is built.

Two things that verification settled:

- **Prefer `agent.stop()` over the callback.** `stdin_control()` is already a
  live coroutine, so it can call `agent.stop()` the moment a `{"cmd":"stop"}`
  line arrives — no constructor parameter, no event to poll. Both routes set the
  same flag; this one adds no machinery.
- **The stop lands mid-step, not only between steps.** `_check_stop_or_pause()`
  runs before every action within a step (`service.py:2763`), so the latency is
  roughly one in-flight action, not a full LLM round trip. That is what makes a
  few-second escalation timeout to `killRunTree` reasonable rather than tight.

## Details

- **The transport already exists.** Express writes control lines to the agent's
  stdin — `{"cmd":"screencast","on":bool}` — and `stdin_control()` reads them.
  A `{"cmd":"stop"}` line setting an `asyncio.Event` that the should-stop
  callback reads is a handful of lines on both sides. No new channel, no signals.
- `POST /api/runs/:id/stop`, scoped to the run's owner, plus a button in the Run
  view and the live `RunDetail`. A queued run is simply dequeued.
- **`cancelled` is a terminal status of its own**, not a failure. A stopped run
  is not a red build, and CI (US-008) must not treat it as one — it should not
  contribute to a suite's exit code the way a real failure does. It **needs a
  migration**: `runs.status` carries a check constraint enumerating the six
  current values (`db/migrations/001_init.sql:111`), so an unmigrated write
  fails the insert rather than storing an unknown status. `TERMINAL` in
  `runs.js`, `STATUS_COLORS`/`--fill-*` in `frontend/src/status.js` and the
  `.badge-<status>` block in `App.css` are the other three places the vocabulary
  is spelled out.
- Keep `killRunTree` as the backstop with a timeout: an agent wedged inside a
  step will not reach the callback, so a stop that has not landed within a few
  seconds escalates to the existing kill. That is also the honest reason not to
  delete the hard path.
- The partial artifacts are the point: whatever steps ran are reported, the
  recording plays, and the report says the run was stopped rather than pretending
  a verdict.

## Acceptance criteria

- [x] A running run can be stopped by its owner; a queued one is dequeued and
      never spawns — `POST /api/runs/:id/stop`, from the Run view's header while
      the run is live and from `RunDetail` in History and on `/runs/<id>`.
- [x] A stopped run ends in a distinct `cancelled` status, excluded from failure
      emails (US-012) and from CI's non-zero exit (US-008), and visible in
      History — its own badge, its own dot colour, and its own entry in the
      status filter.
- [x] The steps that ran are in the report, which states the run was stopped,
      and the recording of a stopped run plays.
- [x] The freed concurrency slot is released and the queue advances
- [x] A wedged agent that does not honour the stop is killed by the existing
      watchdog path within a bounded time, and still ends `cancelled`
- [x] One user cannot stop another's run

## Results

**Correctness-critical, assertion-first.** `stop-run.test.js` was written and
reviewed before a line of the implementation existed, and it has a row in
[`correctness-critical.md`](../../../correctness-critical.md). The failure it
exists for is the one that looks like success: browser-use returns history
*normally* out of `Agent.stop()`, so a stopped run still emits a `done` event
carrying the agent's self-report, and honouring it ends an aborted run `passed`
— a green CI build, a pass in History, a `run passed` skip in the mail. The test
stub emits `success: true` on its stop path deliberately, so nothing can quietly
regress into believing it. Its quieter twin was in the columns rather than the
status: `persistUpdate` and `liveRow` both derived `success` from the same
event, so a row could read `cancelled` and `success = true` at once. Both now go
through one `verdictOf(run)` — a cancelled run has no verdict, in the row, the
report JSON and the HTTP shape.

**The intent is a flag; only the run's end assigns the status.** `cancelled` has
to be in `TERMINAL` or `close` overwrites it — but `TERMINAL` is what
`retention.js` reads to decide a live run's artifacts are prunable and what
`attachViewer` reads to announce the end. Assign it when the request arrives and
a still-running run has `runs/<id>/` swept out from under it and every viewer
told it finished. So `stopRun` sets `run.cancelling` and nothing else; the
stdout handler and `close` both read that flag when the run actually ends.

**The slot arithmetic is asymmetric, and both errors stay invisible until the
box is full.** A queued run never took a concurrency slot, so a stop that
decrements one leaves `active` negative and the per-user cap quietly stops
holding; a running run's slot has to come back exactly once, from its own
`close`, or every later run queues forever. `stop-run.test.js` counts across
both directions — dequeue, release — and back to zero.

**The hard kill stays, and the graceful path is preferred rather than trusted.**
`STOP_GRACE_SECONDS` (default 10) then `killRunTree`, and `close` reads the
intent rather than the exit code — otherwise the honest backstop reports
`error`, which US-012 mails and US-008 fails the build on. One thing the
assertion got wrong on its first run and is now right about: a killed child is a
*zombie* until Node reaps it in the close handler, and a zombie still answers
`process.kill(pid, 0)`, so checking the pid at the status flip would have passed
against an implementation that killed nothing.

**The migration is proven against real Postgres, not pg-mem.** The two engines
name an inline column check differently — `runs_status_check` vs
`runs_constraint_2` — so `011` drops both, as `004` does. The ordinal was
confirmed by running the real `001` through pg-mem rather than assumed; guess it
wrong and the old constraint survives there and rejects every cancelled run in
the test suite only. On a throwaway real database the result is exactly one
status check, naming `cancelled`, still rejecting an unknown value — the last
part being what proves the drop widened the guard instead of deleting it.

**US-008's script changed, and its pinned hash with it** (`ee951934…` →
`4d2f5ea8…`). The `if` became a `case` with a `cancelled` branch that prints
`STOP` and leaves the exit code alone. Exercised for real rather than reasoned
about — in an Alpine container, the same one `docs/ci.md`'s GitLab job
describes, because this box has no `jq`: a lone `cancelled` exits 0, a
`passed,cancelled,failed` batch still exits 1 (a stop suppresses nothing), and
`completed` still exits 1.

**A tradeoff written into the doc rather than hidden.** A stopped run verified
*nothing*, so a job whose runs were all stopped now exits 0 having proved
nothing, and anyone who can reach the UI can green a gate by stopping its runs.
That is the story's own criterion and it is the right default — a red build for
the action whose entire purpose is to stop spending would make the feature cost
an incident — but it is a real edge, so `docs/ci.md` states it and tells a
release gate which one line to move.

**The frontend needed the verdict override a second time, which the story had
said it would not.** The earlier note here claimed the relayed `done` event was
"the server's own, with the verdict already overridden" — it is not. `verdictOf`
rewrites the row and the HTTP shape; the WebSocket relay pushes the agent's
event through untouched (`broadcast(run, evt)` in the stdout handler), so the
Run view receives `success: true` for a run somebody aborted, exactly as CI and
History would have without the server-side fix. So the view keeps its own
`stopping` flag and the `done` handler reads it — and `RunView.test.jsx`
carries the frontend twin of the engine's property V, with the same deliberately
green stub payload. That flag is a **ref** as well as state: `handleEvent` is
captured by `ws.onmessage` when the socket opens and never re-bound, so every
state read inside it is frozen at the render that opened the run.

**Two vocabularies for one status, resolved in favour of the button.** The
column is `cancelled` — the check constraint, the `?status=` filter, US-008's
`case` branch all spell it that way — but every place a person meets the feature
says "stop". A `CANCELLED` badge under a `Stop run` button is two names for one
thing, so `statusLabel()` in `status.js` renders it "stopped" wherever it is
shown (the mail already made this call: `notify.js` maps it to `STOPPED`). The
stored value is untouched.

**`info` was the unused fifth palette family, and a stop is what it is for.**
`--fill-cancelled` and `.badge-cancelled` take it rather than red (which would
say the run failed) or `completed`'s grey (both ended without a verdict, but
that would make the two indistinguishable in a scan of History). The one red
thing is the button: `danger` colours the *click*, because it interrupts
something, while the record it leaves stays neutral — which is where "a stop is
not a failure" actually has to hold.

**The recording was the one thing the suite could not answer, and it took a real
run to close.** Preferring `agent.stop()` over `SIGKILL` exists for exactly one
observable consequence: `agent.run()` returns, so `main()`'s `finally` reaches
`SessionRecorder.stop()`, `stop_and_save()` finalizes the container and the moov
atom is written — without which the mp4 on disk is a headerless blob no player
opens. Every test drives `server/test/stubs/fake_agent.js`, which writes the
string `fake mp4 for tests` into `recording.mp4`: no Chromium, no encoder, no
video, so that chain had only ever been read out of browser-use's source. One
real run, stopped mid-flight and watched back, played through the steps it had
taken. That is the story's whole promise — the partial evidence survives — and
it is now observed rather than argued.
