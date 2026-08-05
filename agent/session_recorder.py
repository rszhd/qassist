"""Sampling and lifecycle for the session recording (US-006).

`run_agent.py` encodes the recording off the same CDP screencast the live
viewer uses, so every frame Chromium repaints arrives here. This module owns
*which* of them reach the encoder and what happens either side: sample at
RECORD_FPS, start the encoder lazily on the first frame that survives the
sample, and refuse everything after `stop()`.

The encoder itself is browser-use's `VideoRecorderService` and PIL is what
reads the first frame's size, so neither is imported here. `start_service` is
handed in by run_agent.py and is the whole browser-use surface — which leaves
the half above stdlib-only and testable against a fake, like redact.py and
navigation_policy.py.

    start_service(frame_b64) -> service | None

`None` means the recording is unavailable (missing video deps, an unreadable
first frame) and the caller has already said so; this object then stays inert
for the rest of the run rather than retrying per frame. The service it does
return is used for `add_frame(frame_b64)` and `stop_and_save()` and nothing
else.
"""
from __future__ import annotations

import os
import time

RECORD_FILENAME = "recording.mp4"
RECORD_FPS = 3  # sample rate and video framerate — reviewable, cheap to encode
RECORD_MIN_INTERVAL = 1 / RECORD_FPS


class SessionRecorder:
    """Encodes sampled screencast frames into <run dir>/recording.mp4.

    Sized from the first frame, so the video keeps the browser's aspect ratio
    without a per-frame resize. Chromium only emits a screencast frame when
    the page repaints, so the result is a condensed replay of the session, not
    a wall-clock one. Encoding is synchronous (as in browser-use's own
    watchdog) — at RECORD_FPS that costs a few ms per frame.
    """

    def __init__(self, output_path, start_service, clock=time.monotonic) -> None:
        self.output_path = output_path
        self.frames = 0
        self._start_service = start_service
        self._clock = clock
        self._svc = None
        self._tried_start = False
        self._closed = False
        # None rather than 0.0, so the first frame is admitted by "never sampled
        # yet" and not by the clock happening to read above one interval.
        self._last_add = None

    def add(self, frame_b64) -> None:
        now = self._clock()
        if self._closed:
            return
        if self._last_add is not None and now - self._last_add < RECORD_MIN_INTERVAL:
            return
        self._last_add = now
        if not self._tried_start:
            self._tried_start = True
            self._svc = self._start_service(frame_b64)
        if self._svc is None:
            return
        self._svc.add_frame(frame_b64)
        self.frames += 1

    def stop(self) -> bool:
        """Finalize the file, and say whether there is one. Blocking."""
        self._closed = True  # stragglers after stopScreencast must not reopen it
        if self._svc is None:
            return False
        self._svc.stop_and_save()
        self._svc = None
        return self.frames > 0 and os.path.exists(self.output_path)
