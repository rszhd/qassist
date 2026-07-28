"""Bounds what the agent may spend on teardown once its verdict is out.

A run is finished, in every sense anything downstream cares about, the moment
its `done`/`error` line crosses stdout: the server reads the status off that
event, renders the report from it, and never reads another thing this process
writes. But the run's `MAX_CONCURRENT` slot — and its owner's per-user slot —
is freed by the *process exiting*, not by the event. So a teardown that blocks
holds both until the server's wall-clock watchdog kills the tree at
`RUN_TIMEOUT_SECONDS`: ten minutes, by default, of queue for a run everyone can
already read the result of, and a terminal row whose `finished_at` stays null
because the `close` handler that writes it never fired (BUG-003).

So the terminal event arms this. Ordinary teardown gets `GRACE_SECONDS` and is
otherwise untouched — this is a backstop, not a shortcut past the exit path. If
the grace runs out, every thread's stack goes to stderr, which the server
prefixes with `[agent <id>]` and logs, so the next occurrence arrives already
diagnosed instead of needing `py-spy` on a box while the process is still hung.
Then the process exits with the code it was going to exit with anyway.
"""
from __future__ import annotations

import faulthandler
import os
import sys
import threading

# Generous next to an interpreter shutdown that is normally milliseconds, and
# small next to the RUN_TIMEOUT_SECONDS ceiling this exists to stop waiting for.
GRACE_SECONDS = 20

_timer: threading.Timer | None = None


def arm(exit_code: int, seconds: float = GRACE_SECONDS, _exit=os._exit) -> threading.Timer:
    """Start the countdown to a forced exit. First terminal event wins.

    Re-arming is a no-op rather than an extension: two terminal events would
    otherwise push the deadline out, and the first one is already the moment
    after which nothing this process does is read.
    """
    global _timer
    if _timer is not None:
        return _timer
    _timer = threading.Timer(seconds, _force_exit, (exit_code, seconds, _exit))
    _timer.daemon = True  # a healthy exit must never wait on this thread
    _timer.start()
    return _timer


def _force_exit(exit_code: int, seconds: float, _exit) -> None:
    print(
        f"[exit-watchdog] teardown still running {seconds}s after the terminal "
        f"event — stacks follow, then exiting {exit_code}",
        file=sys.stderr,
        flush=True,
    )
    faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
    _kill_children()
    sys.stdout.flush()
    sys.stderr.flush()
    _exit(exit_code)


def _kill_children() -> None:
    """Take Chromium with us if teardown had not got to it yet.

    `os._exit` skips whatever browser-use's own teardown still owed, and if that
    included killing the browser it would be reparented to init and squat on
    memory for good — the server's memory watchdog stops with the run, so
    nothing else is left watching. In the hang this was written for the browser
    was already gone; this is the case where it is not.
    """
    try:
        import psutil
    except ImportError:
        return
    try:
        children = psutil.Process().children(recursive=True)
    except psutil.Error:
        return
    for child in children:
        try:
            child.kill()
        except psutil.Error:
            pass
