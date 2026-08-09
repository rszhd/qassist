"""Unit tests for session_recorder — sampling and lifecycle for the mp4 (US-006).

The encoder is browser-use's `VideoRecorderService` and PIL sizes the first
frame, so run_agent.py hands both in as one `start_service(frame) -> service`
callable. That injection is what these assertions stand on: a fake service
records what it was asked to encode and a fake clock advances by hand, so the
whole sampling contract is pinned without a Chromium, a codec or a wait.

The failures this file exists to catch are all quiet ones. A recording is
watched by a human long after the run, so nothing downstream contradicts a
recorder that sampled every repaint (a run's worth of frames encoded
synchronously, on the hot path of every page paint), retried a missing codec
once per frame, or accepted the stragglers Chromium keeps sending after
`stopScreencast` and reopened a file that was already saved.
"""
import os

import pytest

from session_recorder import RECORD_FPS, RECORD_MIN_INTERVAL, SessionRecorder


class FakeService:
    """Stands in for VideoRecorderService: it only has to take frames and stop."""

    def __init__(self):
        self.added = []
        self.saves = 0

    def add_frame(self, frame_b64):
        self.added.append(frame_b64)

    def stop_and_save(self):
        self.saves += 1


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
        return self.now


def make_recorder(tmp_path, service=None, clock=None):
    """A recorder, its fake service, and the clock driving the sampler."""
    service = FakeService() if service is None else service
    clock = clock or FakeClock()
    starts = []

    def start_service(frame_b64):
        starts.append(frame_b64)
        return service

    recorder = SessionRecorder(str(tmp_path / "recording.mp4"), start_service, clock=clock)
    return recorder, service, clock, starts


class TestSampling:
    def test_the_first_frame_is_always_encoded(self, tmp_path):
        # The sampler compares against the last frame it ADMITTED, and at the
        # start there is no such frame. A recorder that compared against a zeroed
        # timestamp instead would drop the opening frame or not, depending on
        # what the clock happened to read — and the first frame is the one the
        # video is sized from.
        recorder, service, _, starts = make_recorder(tmp_path)
        recorder.add("frame-1")
        assert service.added == ["frame-1"]
        assert starts == ["frame-1"]
        assert recorder.frames == 1

    def test_frames_inside_the_interval_are_dropped(self, tmp_path):
        recorder, service, clock, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        clock.advance(RECORD_MIN_INTERVAL / 3)
        recorder.add("frame-2")
        clock.advance(RECORD_MIN_INTERVAL / 3)
        recorder.add("frame-3")
        assert service.added == ["frame-1"]
        assert recorder.frames == 1

    def test_a_frame_at_the_interval_is_encoded(self, tmp_path):
        recorder, service, clock, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        clock.advance(RECORD_MIN_INTERVAL)
        recorder.add("frame-2")
        assert service.added == ["frame-1", "frame-2"]

    def test_a_dropped_frame_does_not_reset_the_interval(self, tmp_path):
        # The sampler must measure from the last frame it encoded, not from the
        # last frame it saw. Measuring from the last frame SEEN means a page
        # repainting faster than RECORD_MIN_INTERVAL never leaves a gap, so
        # nothing after the first frame is ever encoded and the recording is one
        # still image — which looks like a broken page rather than a broken
        # sampler.
        recorder, service, clock, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        for _ in range(20):
            clock.advance(RECORD_MIN_INTERVAL / 10)
            recorder.add("noise")
        assert "frame-1" in service.added
        assert len(service.added) > 1


class TestStartingTheEncoder:
    def test_the_encoder_is_started_once_for_the_run(self, tmp_path):
        recorder, _, clock, starts = make_recorder(tmp_path)
        for i in range(4):
            recorder.add(f"frame-{i}")
            clock.advance(RECORD_MIN_INTERVAL)
        assert starts == ["frame-0"]

    def test_an_unavailable_encoder_is_attempted_once_not_per_frame(self, tmp_path):
        # `start_service` returns None when the video deps are missing or the
        # first frame could not be read, and run_agent.py has already emitted the
        # warning by then. Retrying would decode a JPEG and warn again on every
        # sampled frame for the whole run — a recording that is merely absent
        # would become a run drowning in warnings.
        attempts = []

        def start_service(frame_b64):
            attempts.append(frame_b64)
            return None

        clock = FakeClock()
        recorder = SessionRecorder(str(tmp_path / "recording.mp4"), start_service, clock=clock)
        for i in range(5):
            recorder.add(f"frame-{i}")
            clock.advance(RECORD_MIN_INTERVAL)
        assert attempts == ["frame-0"]
        assert recorder.frames == 0

    def test_a_dropped_frame_does_not_spend_the_start_attempt(self, tmp_path):
        # Sampling comes first, so the frame the encoder is sized from is one
        # that was actually encoded.
        recorder, service, clock, starts = make_recorder(tmp_path)
        recorder.add("frame-1")
        clock.advance(RECORD_MIN_INTERVAL / 4)
        recorder.add("dropped")
        assert starts == ["frame-1"]
        assert service.added == ["frame-1"]


class TestStop:
    def test_stop_saves_and_reports_the_file(self, tmp_path):
        recorder, service, _, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        open(recorder.output_path, "wb").close()
        assert recorder.stop() is True
        assert service.saves == 1

    def test_stop_reports_nothing_when_the_file_was_never_written(self, tmp_path):
        # `stop_and_save` returning normally is not evidence of an mp4. The
        # server links a `recording` event straight to a download, so a claim
        # made off the encoder's word alone becomes a 404 in the report.
        recorder, service, _, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        assert not os.path.exists(recorder.output_path)
        assert recorder.stop() is False
        assert service.saves == 1

    def test_stop_before_any_frame_saves_nothing(self, tmp_path):
        recorder, service, _, _ = make_recorder(tmp_path)
        assert recorder.stop() is False
        assert service.saves == 0

    def test_frames_after_stop_are_refused(self, tmp_path):
        # Chromium keeps delivering screencast frames for a moment after
        # `stopScreencast`, and by then the file has been finalized. Encoding
        # into a saved recording is the failure this flag exists to prevent.
        recorder, service, clock, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        recorder.stop()
        clock.advance(RECORD_MIN_INTERVAL * 10)
        recorder.add("straggler")
        assert service.added == ["frame-1"]
        assert recorder.frames == 1

    def test_a_second_stop_does_not_save_again(self, tmp_path):
        recorder, service, _, _ = make_recorder(tmp_path)
        recorder.add("frame-1")
        open(recorder.output_path, "wb").close()
        recorder.stop()
        assert recorder.stop() is False
        assert service.saves == 1


class TestFrameCount:
    def test_frames_counts_what_was_encoded_not_what_arrived(self, tmp_path):
        # The count rides on the `recording` event and is what the report says
        # the video contains, so it has to be the encoder's tally.
        recorder, _, clock, _ = make_recorder(tmp_path)
        for i in range(3):
            recorder.add(f"frame-{i}")
            recorder.add("dropped")  # same instant, inside the interval
            clock.advance(RECORD_MIN_INTERVAL)
        assert recorder.frames == 3


class TestVideoOffset:
    """Where a step boundary is inside the mp4 (US-076).

    The recording is condensed — Chromium emits a frame only when the page
    repaints and the sampler keeps RECORD_FPS of those — so the run's clock and
    the file's clock are different clocks, and the gap between them is every
    wait the run sat through. `video_seconds` is the second one, and it is only
    ever read at a step boundary, before that step has acted: the frames
    admitted so far belong to the steps before it, so frame index `frames` is
    the first frame that can show what this step did.

    Every failure here is quiet. A seek landing one frame early shows the
    previous step's page and nothing says so; a seek computed from wall-clock
    looks right on a busy run and is minutes out on a slow one. So the cases
    assert the landing INTERVAL rather than an arithmetic result — what the
    number has to do is pick a frame, and that survives a change of fps or of
    rounding, which an expected float does not.
    """

    def record(self, recorder, clock, count):
        """`count` frames actually admitted, and it checks that they were.

        Well clear of the sampling interval rather than exactly on it: adding
        1/3 repeatedly accumulates float error, and a gap landing a hair under
        the interval drops a frame — which silently makes the arithmetic below
        assert against a count the recorder never reached. What is under test
        here is the mapping, not the sampler, which `TestSampling` owns.
        """
        for i in range(count):
            recorder.add(f"frame-{i}")
            clock.advance(RECORD_MIN_INTERVAL * 2)
        assert recorder.frames == count

    @pytest.mark.parametrize("frames", [0, 1, 2, 3, 9, 40])
    def test_a_boundary_lands_inside_the_step_s_own_first_frame(self, tmp_path, frames):
        # Frame n occupies [n/fps, (n+1)/fps) in the file. Landing below that
        # window shows the page as the PREVIOUS step left it, which is the
        # off-by-one this mapping exists to get right, and landing above it
        # skips whatever the step did first.
        recorder, _, clock, _ = make_recorder(tmp_path)
        self.record(recorder, clock, frames)
        at = recorder.video_seconds
        assert frames / RECORD_FPS <= at < (frames + 1) / RECORD_FPS

    def test_the_first_boundary_is_the_start_of_the_file(self, tmp_path):
        # Step 1's callback runs before any repaint it caused, so the recorder
        # may hold nothing at all. The encoder starts on the first frame it is
        # given, so that frame is t=0 — there is no lead-in to skip.
        recorder, _, _, _ = make_recorder(tmp_path)
        assert 0 <= recorder.video_seconds < 1 / RECORD_FPS

    def test_idle_time_does_not_move_it(self, tmp_path):
        # The whole reason this is not `elapsed`. A run waiting on a
        # confirmation email repaints nothing for minutes; the file does not
        # grow, so neither does the offset.
        recorder, _, clock, _ = make_recorder(tmp_path)
        self.record(recorder, clock, 6)
        waiting = recorder.video_seconds
        clock.advance(300)
        assert recorder.video_seconds == waiting

    def test_dropped_frames_do_not_count(self, tmp_path):
        # The offset is the ENCODER's tally, like `frames` on the `recording`
        # event. Counting repaints the sampler refused would drift the mapping
        # further with every busy page.
        recorder, _, clock, _ = make_recorder(tmp_path)
        for i in range(4):
            recorder.add(f"frame-{i}")
            recorder.add("dropped")  # same instant, inside the interval
            clock.advance(RECORD_MIN_INTERVAL * 2)
        assert recorder.frames == 4
        assert 4 / RECORD_FPS <= recorder.video_seconds < 5 / RECORD_FPS

    def test_a_recorder_whose_encoder_never_started_maps_to_nothing(self, tmp_path):
        # Missing video deps or an unreadable first frame: there is no file to
        # seek, so there is no offset either. A 0.0 here would be a number that
        # reads as "the start of the recording" for a run that has none, and it
        # would be written into report_data.json for every step.
        def start_service(frame_b64):
            return None

        clock = FakeClock()
        recorder = SessionRecorder(str(tmp_path / "recording.mp4"), start_service, clock=clock)
        recorder.add("frame-0")
        assert recorder.video_seconds is None

    def test_it_stays_readable_after_the_file_is_finalized(self, tmp_path):
        # `stop()` runs before the last events are assembled, and the offsets
        # already emitted must not be contradicted by a recorder that forgot its
        # count on the way out.
        recorder, _, clock, _ = make_recorder(tmp_path)
        self.record(recorder, clock, 5)
        at = recorder.video_seconds
        recorder.stop()
        assert recorder.video_seconds == at


@pytest.mark.parametrize("empty", ["", None])
def test_a_frame_with_no_data_still_follows_the_contract(tmp_path, empty):
    # Nothing upstream promises a payload; `on_frame` reads it straight out of
    # the CDP event. The recorder is on the hot path of every repaint, so an
    # empty one must reach `start_service` — which owns the decode and its
    # failure — rather than raise here.
    recorder, service, _, starts = make_recorder(tmp_path)
    recorder.add(empty)
    assert starts == [empty]
    assert service.added == [empty]
    # But it is not counted. browser-use's `add_frame` logs a warning and drops
    # a payload it cannot decode, and it returns nothing either way — so this is
    # the one lost frame the sampler can see for itself. A count that included
    # it would drift the US-076 offset a frame later for the whole run, and the
    # drift accumulates.
    assert recorder.frames == 0
