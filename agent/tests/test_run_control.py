"""Unit tests for run_control — the two helpers behind US-079's control lines.

Pure stdlib, no browser: both helpers take the agent as an argument, so a fake
with the two attributes browser-use actually exposes stands in for one. What
each test defends is a property of the *real* 0.13.6 that a fake cannot check
for us, so each names it:

  - Agent.pause() and Agent.resume() both print() to stdout, and stdout here is
    the NDJSON event stream. Verified against the pinned 0.13.6 (2026-08-10) —
    pause prints "Press [Enter] to resume or [Ctrl+C] again to quit", which is
    not true in our UI and must never reach a viewer as a `log` event.

  - Agent.add_new_task does the same append as MessageManager.add_new_task and
    then also assigns the bare hint to `agent.task`, sets follow_up_task,
    clears the stop and pause flags, and rebuilds the eventbus the live run is
    using. So the helper must reach the message manager and nothing else.
"""
import io
import sys

import pytest

import run_control


class FakeMessageManager:
    def __init__(self):
        self.appended = []

    def add_new_task(self, text):
        self.appended.append(text)


class FakeAgent:
    """The three members run_control touches, and a record of what was called."""

    def __init__(self):
        self._message_manager = FakeMessageManager()
        self.calls = []
        # The two flags Agent.add_new_task clears as a side effect. Nothing in
        # run_control may move them, so they are here to be found untouched.
        self.task = "the original goal"
        self.follow_up_task = False

    def pause(self):
        self.calls.append("pause")
        print("⏸️ Paused the agent. Press [Enter] to resume or [Ctrl+C] again to quit.")

    def resume(self):
        self.calls.append("resume")
        print("▶️  Resuming agent execution where it left off...")


class TestQuietly:
    def test_swallows_what_the_call_prints(self, capsys):
        agent = FakeAgent()
        run_control.quietly(agent.pause)
        assert capsys.readouterr().out == ""

    def test_the_call_still_happens(self):
        agent = FakeAgent()
        run_control.quietly(agent.pause)
        run_control.quietly(agent.resume)
        assert agent.calls == ["pause", "resume"]

    def test_stdout_is_restored_afterwards(self, capsys):
        agent = FakeAgent()
        run_control.quietly(agent.pause)
        # The channel is the run's only way to speak; muting it permanently
        # would silence every event after the first pause.
        print("an event")
        assert capsys.readouterr().out == "an event\n"

    def test_stdout_is_restored_even_when_the_call_raises(self, capsys):
        def boom():
            print("half a line")
            raise RuntimeError("the browser was closed")

        with pytest.raises(RuntimeError):
            run_control.quietly(boom)
        print("an event")
        assert capsys.readouterr().out == "an event\n"

    def test_it_is_stdout_and_not_the_real_writer_that_moves(self):
        # sys.stdout is rebound, not closed: `emit` writes through
        # sys.stdout.write, so a closed or replaced-forever stream would take
        # the whole protocol down with it.
        before = sys.stdout
        run_control.quietly(lambda: None)
        assert sys.stdout is before
        assert not isinstance(sys.stdout, io.StringIO)


class TestApplyHint:
    def test_appends_through_the_message_manager(self):
        agent = FakeAgent()
        run_control.apply_hint(agent, "the button is in the account menu")
        assert agent._message_manager.appended == ["the button is in the account menu"]

    def test_leaves_the_goal_alone(self):
        # The failure this guards is using Agent.add_new_task, which assigns the
        # hint to `task` — the run would then be judged against the correction
        # instead of against what it was asked to prove.
        agent = FakeAgent()
        run_control.apply_hint(agent, "scroll down first")
        assert agent.task == "the original goal"

    def test_does_not_touch_the_agent_s_own_run_state(self):
        # follow_up_task is the flag that goes with rebuilding the eventbus.
        agent = FakeAgent()
        run_control.apply_hint(agent, "try the search box")
        assert agent.follow_up_task is False
        assert agent.calls == []

    def test_two_hints_both_land_in_order(self):
        agent = FakeAgent()
        run_control.apply_hint(agent, "first")
        run_control.apply_hint(agent, "second")
        assert agent._message_manager.appended == ["first", "second"]
