# BUG-003: an agent that hangs after `done` holds its slot for the full ceiling

**Status:** 📋 Open
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

## What would fix it

Unclear without a stack from the hung process, which is the first thing to get
(`py-spy dump`, or `faulthandler.register` on a signal so the agent can be asked
for one). Two candidate directions once it is known:

- If the hang is after everything we care about has been emitted, the agent can
  simply `os._exit(0)` once the terminal event is flushed — nothing after it is
  load-bearing, and the current path already relies on the process exiting to
  free the slot.
- If it is worth waiting for, the *server* can stop waiting: `close` frees the
  slot, but a run whose terminal event has arrived and whose report is `ready`
  is finished in every sense the queue cares about. Releasing the slot on that
  signal rather than on process exit would decouple the two — carefully, since
  US-047's accounting says a slot must come back exactly once.

Either way it needs its own assertion: "slot released" and "process exited" are
two claims and only one of them is currently checked.
