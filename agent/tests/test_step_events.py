"""Unit tests for step_events — what a step boundary emits (US-044, US-006).

`browser_state` and `agent_output` are read with `getattr` and nothing else, so
these hand in plain objects and never start a browser. What is pinned here is
the assembled event and the durable screenshot beside it: the shape
`server/src/runEvents.js` declares, the scrub over every field the page or the
model authored, and a screenshot failure resolving to a null rather than to a
lost step.

**The ORDERING inside `step_events.callback` is deliberately not asserted here.**
Report the fence's blocks, flush the previous step's diagnostics, then advance
the attribution — flush-before-advance is what stops a chatty first step
spending the run's diagnostics budget and silencing the step that fails. That
is an assertion-first surface (`backlog/correctness-critical.md`), so the
assertion is the maintainer's to write and this file leaves it room. The seam
is already there: `callback` takes `report_blocks`, `flush_diagnostics` and
`set_step` as plain callables, plus `emit` and a `clock`, so a recorder of the
call order is the whole fixture it needs.
"""
import base64
import os

import pytest

import step_events


class State:
    def __init__(self, url=None, screenshot=None):
        self.url = url
        self.screenshot = screenshot


class Output:
    def __init__(self, evaluation_previous_goal=None, next_goal=None, thinking=None):
        self.evaluation_previous_goal = evaluation_previous_goal
        self.next_goal = next_goal
        self.thinking = thinking


def event(state=None, output=None, step_number=1, elapsed=0.0, screenshot_file=None, sensitive=None):
    return step_events.step_event(
        state or State(), output or Output(), step_number, elapsed, screenshot_file, sensitive
    )


class TestEventShape:
    def test_the_fields_are_exactly_what_runevents_declares(self):
        # StepEvent in server/src/runEvents.js, which run_agent.py authors and
        # `npm run check` reads. A field added here without landing there is a
        # relay and a viewer reading a shape nothing describes.
        assert set(event()) == {
            "type", "step", "elapsed", "url",
            "evaluation", "next_goal", "thinking", "screenshot_file",
        }

    def test_absent_attributes_become_null_not_missing_keys(self):
        # browser-use's own objects are what arrive here, and the fields this
        # reads are optional on them. A key that vanishes rather than nulling is
        # a viewer rendering "undefined" and a report with a hole in it.
        class Bare:
            pass

        assembled = step_events.step_event(Bare(), Bare(), 3, 1.0, None, None)
        assert assembled["url"] is None
        assert assembled["evaluation"] is None
        assert assembled["next_goal"] is None
        assert assembled["thinking"] is None

    def test_the_step_number_and_screenshot_are_carried_through(self):
        assembled = event(step_number=7, screenshot_file="step_7.png")
        assert assembled["type"] == "step"
        assert assembled["step"] == 7
        assert assembled["screenshot_file"] == "step_7.png"

    def test_elapsed_is_rounded_to_a_tenth(self):
        assert event(elapsed=12.34567)["elapsed"] == 12.3
        assert event(elapsed=0.0)["elapsed"] == 0.0


class TestScrubbing:
    def test_every_authored_field_is_scrubbed(self):
        # All four carry text the page or the model wrote, and after the agent
        # follows a fetched confirmation link the URL *is* the secret.
        secret = "s3cr3t-token"
        sensitive = {"email_link": secret}
        assembled = event(
            state=State(url=f"https://app.example.com/confirm?t={secret}"),
            output=Output(
                evaluation_previous_goal=f"typed {secret}",
                next_goal=f"open {secret}",
                thinking=f"the code is {secret}",
            ),
            sensitive=sensitive,
        )
        for field in ("url", "evaluation", "next_goal", "thinking"):
            assert secret not in assembled[field]
            assert "<redacted:email_link>" in assembled[field]

    def test_the_dict_is_read_live_not_copied(self):
        # `get_email_code` adds the fetched code to `sensitive` mid-run, and
        # browser-use re-reads the same dict on every action. A copy taken when
        # the callback was built would keep scrubbing against the old contents,
        # so the step that actually uses the code is the one that leaks it.
        sensitive = {}
        state = State(url="https://app.example.com/verify?code=482913")
        assert "482913" in event(state=state, sensitive=sensitive)["url"]
        sensitive["email_code"] = "482913"
        assert "482913" not in event(state=state, sensitive=sensitive)["url"]

    def test_no_secrets_passes_the_text_through(self):
        assembled = event(state=State(url="https://example.com/"), sensitive=None)
        assert assembled["url"] == "https://example.com/"


class TestScreenshot:
    def test_it_writes_the_frame_and_returns_the_bare_filename(self, tmp_path):
        # A bare filename, not a path: runEvents.js says the report resolves it
        # inside runs/<runId>/, and an absolute path there would be a link out
        # of the artifact directory.
        png = b"\x89PNG\r\n\x1a\n-not-really"
        name = step_events.save_screenshot(
            str(tmp_path), 4, base64.b64encode(png).decode()
        )
        assert name == "step_4.png"
        assert (tmp_path / "step_4.png").read_bytes() == png

    def test_it_creates_the_run_directory(self, tmp_path):
        run_dir = tmp_path / "runs" / "abc"
        name = step_events.save_screenshot(str(run_dir), 1, base64.b64encode(b"x").decode())
        assert name == "step_1.png"
        assert os.path.isfile(run_dir / "step_1.png")

    def test_each_step_gets_its_own_file(self, tmp_path):
        for step in (1, 2, 3):
            step_events.save_screenshot(str(tmp_path), step, base64.b64encode(b"x").decode())
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "step_1.png", "step_2.png", "step_3.png"
        ]

    @pytest.mark.parametrize("frame", [None, ""])
    def test_no_frame_is_no_file_and_no_error(self, tmp_path, frame):
        assert step_events.save_screenshot(str(tmp_path), 1, frame) is None
        assert list(tmp_path.iterdir()) == []

    def test_no_run_directory_is_no_file(self):
        # The server always names one; a direct invocation of run_agent.py does
        # not, and that run still has to produce steps.
        assert step_events.save_screenshot(None, 1, base64.b64encode(b"x").decode()) is None

    def test_an_unwritable_frame_is_a_null_not_a_lost_step(self, tmp_path):
        # The step event is the run's live progress. Every screenshot failure —
        # undecodable payload, full disk, a path that is not a directory —
        # resolves to None, and runEvents.js says the report draws a placeholder
        # for exactly that.
        assert step_events.save_screenshot(str(tmp_path), 1, "not base64 at all!!") is None
        blocked = tmp_path / "blocked"
        blocked.write_text("i am a file, not a directory")
        assert step_events.save_screenshot(str(blocked), 1, base64.b64encode(b"x").decode()) is None
