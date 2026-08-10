"""The two helpers behind US-079's control lines, on stdlib alone.

Split out of `run_agent.py` rather than left beside `stdin_control`, for the
reason `agent/pytest.ini` states: run_agent imports browser_use, so anything
inside it is unreachable from a suite that installs pytest and nothing else.
Both functions below take the agent as an argument and never import it, which
is what lets a fake stand in for one.
"""
from __future__ import annotations

import contextlib
import io


def quietly(fn) -> None:
    """Call `fn`, keeping whatever it prints off the NDJSON channel.

    browser-use's pause() and resume() print to stdout, which for this process
    is the event stream. It corrupts nothing — Express turns an unparseable
    line into a `log` event — but the line reads "Press [Enter] to resume or
    [Ctrl+C] again to quit", and there is no [Enter] in our UI.

    `redirect_stdout` is process-wide, and that is safe here only because `fn`
    is synchronous and never awaits: no other coroutine, including the
    screencast's own emit, can run inside the block.
    """
    with contextlib.redirect_stdout(io.StringIO()):
        fn()


# Whether a person told this run something mid-flight (US-079). Read at the end
# of the run by US-081's generator, which credits the lesson to the person rather
# than to the agent: a hint is evidence from outside, and a panel that could not
# say so would report a discovery somebody handed it.
hinted = False


def apply_hint(agent, text: str) -> None:
    """Append a person's mid-run correction to the agent's own history.

    The message manager wraps `text` as <follow_up_user_request>, wraps the
    original goal as <initial_user_request> if it is not already, and appends
    one to the other. So this is ADDITIVE: the goal survives, the history of
    what the run already did survives, and the run carries on from the step it
    was on rather than from the first.

    Deliberately not Agent.add_new_task, which does this same append and then
    also assigns the bare hint to `agent.task`, sets state.follow_up_task,
    clears `stopped` and `paused`, and REBUILDS self.eventbus. That is
    machinery for restarting an agent whose run() has already returned and
    whose bus is shut down; firing it here tears down the bus the live loop is
    still using, and replaces the goal we were asked to prove.
    """
    global hinted
    hinted = True
    agent._message_manager.add_new_task(text)
