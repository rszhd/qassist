"""The two claims BUG-003 says are separate: the deadline, and the exit.

The unit tests below assert the deadline (with `os._exit` injected, since a real
one would take pytest with it). The subprocess test asserts the thing that
actually frees the slot — a process whose teardown never returns still exits,
and says why on the way out.
"""
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import exit_watchdog

AGENT_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def disarmed():
    """The module-level timer is process-wide; no test may inherit another's."""
    yield
    if exit_watchdog._timer is not None:
        exit_watchdog._timer.cancel()
        exit_watchdog._timer = None


def arm_and_wait(exit_code, seconds=0.05):
    """Arm with a fake exit and return the code it was called with (None = never)."""
    called = []
    fired = threading.Event()

    def fake_exit(code):
        called.append(code)
        fired.set()

    exit_watchdog.arm(exit_code, seconds, _exit=fake_exit)
    fired.wait(timeout=5)
    return called[0] if called else None


def test_teardown_that_never_finishes_still_exits():
    assert arm_and_wait(0) == 0


def test_exits_with_the_code_the_terminal_event_stood_for():
    assert arm_and_wait(1) == 1


def test_first_terminal_event_owns_the_deadline():
    first = exit_watchdog.arm(0, 30, _exit=lambda code: None)
    assert exit_watchdog.arm(1, 60, _exit=lambda code: None) is first


def test_a_clean_teardown_is_not_hurried():
    """The timer must not fire before its grace: the normal path exits first."""
    exit_watchdog.arm(0, 30, _exit=lambda code: None)
    time.sleep(0.2)
    assert exit_watchdog._timer.is_alive()


def test_hung_process_exits_within_the_grace_and_dumps_stacks():
    """The real claim: `run_agent`'s slot comes back even when teardown wedges."""
    hung = (
        'import exit_watchdog, threading;'
        'exit_watchdog.arm(0, 1.0);'
        'threading.Event().wait()'  # a teardown that never returns
    )
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, '-c', hung],
        cwd=AGENT_DIR,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0
    assert time.monotonic() - started < 10
    assert '[exit-watchdog]' in proc.stderr
    assert 'Thread' in proc.stderr  # faulthandler's all-threads dump


def test_a_process_that_exits_on_its_own_is_untouched():
    """Armed but healthy: the daemon timer neither delays the exit nor sets the code."""
    quick = 'import exit_watchdog; exit_watchdog.arm(1, 30)'
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, '-c', quick],
        cwd=AGENT_DIR,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0
    assert time.monotonic() - started < 10
    assert '[exit-watchdog]' not in proc.stderr
