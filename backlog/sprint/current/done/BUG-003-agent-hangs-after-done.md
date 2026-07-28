# BUG-003: an agent that hangs after `done` holds its slot for the full ceiling

**Status:** ✅ Fixed 2026-07-28
**Reported:** 2026-07-27
**Area:** agent (`agent/run_agent.py` teardown), visible in `server/src/runs.js`
and in History

## What happens

`run_agent.py` emitted its `done` event, the report rendered, and the Python
process then never exited. Observed on run `7ab5f0fb` while taking US-043's
AC #6 measurement:

- `status` = `failed` (set from the `done` event), `report_status` = `ready`
- `finished_at` = **null**, because that column is written by the child's
  `close` handler, which never fired
- no Chromium children left, 2 threads, sleeping on a futex — so the browser
  was already gone and Python was waiting on something in its own teardown

The run self-heals at `RUN_TIMEOUT_SECONDS` (default 600), when the wall-clock
watchdog kills the tree and `close` finally runs.

## Why it matters

The verdict is already known and already persisted — the user sees a finished
run — while the run keeps its `MAX_CONCURRENT` slot and its per-user
concurrency slot for up to ten more minutes. On a box at its cap that is ten
minutes of queue for a run everyone can already read the result of.

The secondary symptom is `finished_at` being null on a row whose `status` is
terminal. Anything computing a duration from `finished_at - started_at` gets
null rather than a number, which is how this was found.

## Not caused by US-043

Worth stating because it surfaced during that story. Runs both before and after
the US-043 agent changes completed normally, and the two hooks that story adds
(`on_step_start` expiry check, `on_step_end` capture) are no-ops on a run with
no session and no capture target — which this run was. The likeliest candidates
are browser-use's own teardown or its telemetry flush.

## What was found

No stack was ever captured from the hung process, so what follows is the two
mechanisms that were *read out of the installed dependencies* — both of them
after `main()` returns, both consistent with two threads on a futex, and neither
provable as the one that fired on `7ab5f0fb`:

1. **browser-use's telemetry, joined at interpreter exit.** `ANONYMIZED_TELEMETRY`
   defaults to **true** (`browser_use/config.py:58`), and nothing in this repo
   set it, so every run built a PostHog client — confirmed in the venv: one
   consumer thread, `retries=3`, `timeout=15`. `Posthog.__init__` registers
   `atexit.register(self.join)` (`posthog/client.py:312`), and `join()` waits on
   that thread finishing its current upload. `BROWSER_USE_CLOUD_SYNC` defaults
   from the same value, so cloud sync was on too. This bounds at roughly a
   minute of its own accord, which does not by itself explain ten.
2. **`asyncio.run`'s executor shutdown, which has no timeout.**
   `loop.shutdown_default_executor()` joins every `asyncio.to_thread` worker and
   waits forever by construction. browser-use runs sync tool calls
   (`tools/registry/service.py:258`) and screenshot writes
   (`browser/python_highlights.py:543`) through it, so one worker wedged in a
   CDP call holds the interpreter until something kills it — which is exactly
   the observed shape, and the one that reaches the ceiling.

Both are *after* the browser is gone, which is why the hung process had no
Chromium children: `Agent.run()`'s `finally` calls `close()` → `browser_session
.kill()` (`agent/service.py:3272`, `:3967`), and that has already happened by
the time we emit `done`.

## The fix

Agent-side, and hang-agnostic — the server's slot accounting is untouched, so
US-047's "a slot comes back exactly once, from `close`" still holds as written.

- **`agent/exit_watchdog.py`** (new). The terminal event arms a daemon timer.
  Ordinary teardown is not shortcut and gets `GRACE_SECONDS` (20); if it runs
  out, every thread's stack goes to stderr — where the server already prefixes
  and logs it, so the *next* occurrence arrives diagnosed instead of needing
  `py-spy` on a box while it is still hung — surviving children are killed so
  `os._exit` can never orphan a Chromium, and the process exits with the code it
  was going to exit with anyway.
- **Armed from `emit()`, not from the four return sites** (`run_agent.py`), keyed
  on the event type. A terminal event added later cannot forget to bound its own
  teardown.
- **`ANONYMIZED_TELEMETRY` / `BROWSER_USE_CLOUD_SYNC` default to false** in
  `run_agent.py`, set before the browser-use import. This removes candidate 1
  entirely (no client is constructed, so no `atexit` is registered — verified),
  and it is the right default on its own terms: a run is the operator's traffic,
  not ours to report. `os.environ.setdefault`, so an operator who wants it back
  sets the variable.

The worst case is now 20 seconds of held slot instead of 600, and a `finished_at`
that is written because `close` fires.

## Assertions

`agent/tests/test_exit_watchdog.py` — the two claims this bug says are separate.
The deadline, with `os._exit` injected (fires, carries the terminal event's exit
code, first arm owns the deadline, does not fire early); and the one that
actually frees the slot, as a subprocess: a process whose teardown never returns
exits 0 within the grace with `[exit-watchdog]` and a thread dump on stderr,
while an armed process that exits on its own is neither delayed nor restyled.

Not added to `backlog/correctness-critical.md`: the guard is a timer and a
forced exit, and the accounting it protects — which *is* on that list, under
US-047 — was not touched.
