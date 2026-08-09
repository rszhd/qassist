"""Unit tests for step_events — what a step boundary emits (US-044, US-006).

`browser_state` and `agent_output` are read with `getattr` and nothing else, so
these hand in plain objects and never start a browser. What is pinned here is
the assembled event and the durable screenshot beside it: the shape
`server/src/runEvents.js` declares, the scrub over every field the page or the
model authored, and a screenshot failure resolving to a null rather than to a
lost step.

`TestStepBoundary` pins what the boundary is FOR: a finding says which step it
belongs to, a chatty step cannot spend the next one's evidence budget, nothing
is handed over twice, and no collaborator can take the run down at a boundary.
It asserts those against a real `Diagnostics`, not against the call order —
`flush_diagnostics` and `set_step` commute today, because `Diagnostics` stamps
the step and reads the budget when a finding is CAPTURED and there is no await
between the two calls. The order is still the right one to write, and the cases
below fail if a later change makes it load-bearing in the wrong direction.
"""
import asyncio
import base64
import os

import pytest

import diagnostics
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


def event(
    state=None, output=None, step_number=1, elapsed=0.0, screenshot_file=None,
    sensitive=None, video_seconds=None,
):
    return step_events.step_event(
        state or State(), output or Output(), step_number, elapsed, screenshot_file,
        sensitive, video_seconds,
    )


def wiring(*, report_blocks=None, run_dir=None, video_seconds=lambda: None):
    """`run_agent.main`'s wiring of the callback, minus the browser.

    The `flush_diagnostics` closure is `run_agent.py`'s, and `diag` is a real
    `Diagnostics`: what the boundary has to get right is what a finding ends up
    SAYING, which a recorder of the call order cannot see.
    """
    emitted = []
    diag = diagnostics.Diagnostics()

    def flush_diagnostics():
        entries = diag.drain()
        if entries:
            emitted.append(
                {"type": "diagnostics", "entries": entries, "dropped": diag.dropped}
            )

    on_step = step_events.callback(
        emit=emitted.append,
        report_blocks=report_blocks or (lambda step_number=None: []),
        flush_diagnostics=flush_diagnostics,
        set_step=diag.set_step,
        run_dir=run_dir,
        sensitive=None,
        run_started=0.0,
        video_seconds=video_seconds,
        clock=lambda: 0.0,
    )
    return diag, on_step, emitted


def boundary(on_step, step_number, url=None):
    """browser-use awaits the callback once per step, before that step acts."""
    asyncio.run(on_step(State(url=url), Output(), step_number))


def findings(emitted):
    """Every diagnostic handed over, batches flattened, in arrival order."""
    return [e for batch in emitted if batch["type"] == "diagnostics" for e in batch["entries"]]


class TestEventShape:
    def test_the_fields_are_exactly_what_runevents_declares(self):
        # StepEvent in server/src/runEvents.js, which run_agent.py authors and
        # `npm run check` reads. A field added here without landing there is a
        # relay and a viewer reading a shape nothing describes.
        assert set(event()) == {
            "type", "step", "elapsed", "url",
            "evaluation", "next_goal", "thinking", "screenshot_file", "video_seconds",
        }

    def test_absent_attributes_become_null_not_missing_keys(self):
        # browser-use's own objects are what arrive here, and the fields this
        # reads are optional on them. A key that vanishes rather than nulling is
        # a viewer rendering "undefined" and a report with a hole in it.
        class Bare:
            pass

        assembled = step_events.step_event(Bare(), Bare(), 3, 1.0, None, None, None)
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

    def test_the_two_clocks_are_carried_separately(self):
        # US-076. `elapsed` is the run's clock and `video_seconds` the file's,
        # and on a run that spent a minute waiting they are minutes apart. A
        # step event that carried one of them twice, or derived either from the
        # other, is a seek that lands wrong without saying so.
        assembled = event(elapsed=91.8, video_seconds=9.17)
        assert assembled["elapsed"] == 91.8
        assert assembled["video_seconds"] == 9.17

    def test_no_recording_is_a_null_offset_not_a_zero(self):
        # A run with QA_RECORD=0, or one whose encoder never came up: readers
        # take the null as "no seek". A 0.0 would send every row of an
        # unrecorded run to the start of a file that does not exist.
        assert event(video_seconds=None)["video_seconds"] is None


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


class TestStepBoundary:
    def test_a_finding_is_filed_against_the_step_it_happened_in(self):
        # The callback announcing step 2 is what hands over step 1's findings,
        # so "which step" cannot be read off the batch it arrives in. A finding
        # filed against the following step points the reader at a page that was
        # fine, and both renderers group by this field.
        diag, on_step, emitted = wiring()
        boundary(on_step, 1)
        diag.console("error", "the submit handler died")
        boundary(on_step, 2)
        assert [(f["step"], f["text"]) for f in findings(emitted)] == [
            (1, "the submit handler died")
        ]

    def test_a_finding_before_the_first_step_belongs_to_no_step(self):
        # A page's own assets fail before the agent has taken a step. Attributing
        # those to step 1 blames the agent's first action for the page's load.
        diag, on_step, emitted = wiring()
        diag.console("error", "favicon 404")
        boundary(on_step, 1)
        assert [f["step"] for f in findings(emitted)] == [None]

    def test_a_chatty_step_does_not_silence_the_step_that_fails(self):
        # The per-kind cap is per STEP, and only `set_step` refreshes it. Skip
        # the refresh and step 1's noise spends the whole run's allowance, so
        # the step that actually failed reports nothing — a failed run with a
        # clean evidence section, which reads as a page that had nothing to say.
        diag, on_step, emitted = wiring()
        boundary(on_step, 1)
        for i in range(diagnostics.MAX_PER_KIND_PER_STEP * 3):
            diag.console("error", f"step one noise {i}")
        boundary(on_step, 2)
        diag.console("error", "the 500 that explains the failure")
        boundary(on_step, 3)

        kept = findings(emitted)
        assert sum(1 for f in kept if f["step"] == 1) == diagnostics.MAX_PER_KIND_PER_STEP
        assert [f["text"] for f in kept if f["step"] == 2] == [
            "the 500 that explains the failure"
        ]
        assert diag.dropped == diagnostics.MAX_PER_KIND_PER_STEP * 2

    def test_what_one_boundary_hands_over_the_next_does_not_repeat(self):
        diag, on_step, emitted = wiring()
        boundary(on_step, 1)
        diag.console("error", "once")
        boundary(on_step, 2)
        boundary(on_step, 3)
        assert [f["text"] for f in findings(emitted)] == ["once"]

    def test_a_boundary_with_nothing_to_hand_over_emits_no_batch(self):
        # An empty batch per step is noise on the pipe the screencast shares.
        _, on_step, emitted = wiring()
        boundary(on_step, 1)
        assert [e["type"] for e in emitted] == ["step"]

    def test_the_blocks_reach_the_feed_before_the_step_that_follows_them(self):
        # `report_blocks` reads the errors of the step that is ENDING (US-042),
        # so a viewer appending in arrival order has to see the refusal above
        # the next step's heading, not below it.
        def report_blocks(step_number=None):
            emitted.append({"type": "blocked", "url": "https://evil.example", "step": step_number})
            return ["https://evil.example"]

        _, on_step, emitted = wiring(report_blocks=report_blocks)
        boundary(on_step, 2)
        assert [e["type"] for e in emitted] == ["blocked", "step"]

    @pytest.mark.parametrize(
        "collaborator",
        ["report_blocks", "flush_diagnostics", "set_step", "video_seconds"],
    )
    def test_a_collaborator_that_raises_costs_one_warning_not_the_run(self, collaborator):
        # browser-use awaits this callback; an exception escaping it ends the run
        # at a step boundary. A reporting bug must cost the report, never the run.
        def boom(*args, **kwargs):
            raise RuntimeError("reporting bug")

        emitted = []
        collaborators = {
            "report_blocks": lambda step_number=None: [],
            "flush_diagnostics": lambda: None,
            "set_step": lambda step: None,
            "video_seconds": lambda: None,
        }
        collaborators[collaborator] = boom
        on_step = step_events.callback(
            emit=emitted.append, run_dir=None, sensitive=None, run_started=0.0, **collaborators
        )
        boundary(on_step, 1)

        assert [e["type"] for e in emitted] == ["warn"]
        assert "reporting bug" in emitted[0]["message"]
        # And the step event goes with it: the whole body is one try, so a
        # failure before the emit costs the viewer that step's heading. Pinned
        # as the price of the single wrapper, not as the desirable outcome —
        # per-call guards would keep the step event.

    def test_the_offset_is_read_at_the_boundary_not_when_the_callback_was_built(self):
        # US-076. It arrives as a callable for the same reason `sensitive` is
        # read live: the recorder is still filling while the run goes on, so a
        # value captured at wiring time would send every step of the run to the
        # same place — the start of the file.
        offsets = iter([0.17, 3.5, 8.83])
        _, on_step, emitted = wiring(video_seconds=lambda: next(offsets))
        for step in (1, 2, 3):
            boundary(on_step, step)
        assert [e["video_seconds"] for e in emitted if e["type"] == "step"] == [0.17, 3.5, 8.83]

    def test_the_step_event_carries_the_screenshot_the_boundary_wrote(self, tmp_path):
        _, on_step, emitted = wiring(run_dir=str(tmp_path))
        frame = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
        asyncio.run(on_step(State(url="https://a", screenshot=frame), Output(), 4))
        assert emitted[-1]["screenshot_file"] == "step_4.png"
        assert (tmp_path / "step_4.png").exists()
