"""Runs a single browser-use agent and streams NDJSON events to stdout.

Express spawns this as a child process (one per test run) and relays each
line to the browser over a WebSocket. One JSON object per line, flushed
immediately so the UI updates live.

Two kinds of visual events are emitted:
  - {"type":"frame", "data": <jpeg-b64>}   CDP screencast (~6 fps), only while
                                            a viewer is attached (see below)
  - {"type":"step",  ...}                   one per agent reasoning step

Every run is also recorded to <ARTIFACTS_DIR>/<runId>/recording.mp4 off the
same frame stream (US-006); a {"type":"recording"} event announces the file
just before the run's done/error event.

Express also writes control commands to our stdin, one JSON object per line:
  {"cmd": "screencast", "on": true|false}   viewer attached / last viewer left
Frames are only emitted while "on". Without recording the screencast itself is
stopped too, so an unwatched run skips the JPEG encoding entirely; a recorded
run needs the frames regardless and only gates the emitting.

Inputs come from environment variables:
  QA_GOAL, QA_START_URL, QA_MAX_STEPS, BROWSER_USE_MODEL, OPENAI_API_KEY
  QA_RUN_ID, ARTIFACTS_DIR (recording + step screenshots)
  QA_RECORD=0 disables recording (US-002's viewer gating then applies again)
  QA_IMAP_* / QA_MAILBOX_DOMAIN (optional — enables email confirmation, see
  email_codes.py)
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import secrets as pysecrets
import sys
import time
from pathlib import Path

from browser_use import Agent, ChatOpenAI, Tools
from browser_use.browser.profile import BrowserProfile, ViewportSize
from browser_use.browser.video_recorder import VideoRecorderService
from PIL import Image

from email_codes import ImapMailbox

# Screencast tuning — keep bandwidth modest so stdout never backs up.
FRAME_FORMAT = "jpeg"
FRAME_QUALITY = 55
FRAME_MAX_W = 1024
FRAME_MAX_H = 720
FRAME_MIN_INTERVAL = 1 / 6  # cap emitted frames to ~6 fps

# Recording (US-006). Chromium allows one screencast per target and US-002's
# viewer gating already owns it, so we encode the recording off the same frame
# stream rather than setting BrowserProfile.record_video_dir — browser-use's
# RecordingWatchdog would otherwise fight us over start/stopScreencast. Only
# its encoder service is reused.
RECORD_FILENAME = "recording.mp4"
RECORD_FPS = 3  # sample rate and video framerate — reviewable, cheap to encode
RECORD_MIN_INTERVAL = 1 / RECORD_FPS


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


class SessionRecorder:
    """Encodes sampled screencast frames into <run dir>/recording.mp4.

    Sized from the first frame, so the video keeps the browser's aspect ratio
    without a per-frame resize. Chromium only emits a screencast frame when
    the page repaints, so the result is a condensed replay of the session, not
    a wall-clock one. Encoding is synchronous (as in browser-use's own
    watchdog) — at RECORD_FPS that costs a few ms per frame.
    """

    def __init__(self, output_path: str) -> None:
        self.output_path = output_path
        self._svc: VideoRecorderService | None = None
        self._tried_start = False
        self._closed = False
        self._last_add = 0.0
        self.frames = 0

    def add(self, frame_b64: str) -> None:
        now = time.monotonic()
        if self._closed or now - self._last_add < RECORD_MIN_INTERVAL:
            return
        self._last_add = now
        if not self._tried_start:
            self._tried_start = True
            self._svc = self._start(frame_b64)
        if self._svc is None:
            return
        self._svc.add_frame(frame_b64)
        self.frames += 1

    def _start(self, frame_b64: str) -> VideoRecorderService | None:
        try:
            with Image.open(io.BytesIO(base64.b64decode(frame_b64))) as img:
                size = ViewportSize(width=img.width, height=img.height)
            os.makedirs(os.path.dirname(self.output_path), exist_ok=True)
            svc = VideoRecorderService(Path(self.output_path), size=size, framerate=RECORD_FPS)
            svc.start()
        except Exception as e:
            emit({"type": "warn", "message": f"recording unavailable: {type(e).__name__}: {e}"})
            return None
        if not svc._is_active:  # optional video deps missing (browser-use[video])
            emit({"type": "warn", "message": "recording unavailable: video deps missing"})
            return None
        return svc

    def stop(self) -> bool:
        """Finalize the file. Blocking — call via asyncio.to_thread."""
        self._closed = True  # stragglers after stopScreencast must not reopen it
        if self._svc is None:
            return False
        self._svc.stop_and_save()
        self._svc = None
        return self.frames > 0 and os.path.exists(self.output_path)


async def stdin_control(watch_event: asyncio.Event, stop_event: asyncio.Event) -> None:
    """Apply {"cmd":"screencast","on":bool} control lines from Express."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    try:
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    except Exception:
        return
    while not stop_event.is_set():
        try:
            line = await reader.readline()
        except Exception:
            return
        if not line:
            return  # stdin closed — parent is gone
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("cmd") == "screencast":
            if msg.get("on"):
                watch_event.set()
            else:
                watch_event.clear()


async def screencast(
    session,
    watch_event: asyncio.Event,
    stop_event: asyncio.Event,
    recorder: SessionRecorder | None = None,
) -> None:
    """Stream CDP screencast frames while a viewer is attached (watch_event set).

    Mirrors browser-use's own recording watchdog: register a frame handler,
    start the screencast on the focused target, ack every frame, and re-target
    when the agent switches tabs.

    Without a recorder the screencast stays stopped while no viewer is attached,
    so Chromium does no frame encoding at all (US-002). A recorder needs the
    frames either way, so it keeps the screencast running for the whole run and
    only the emitting is gated.
    """
    registered = False
    current_sid = None
    last_emit = 0.0

    async def ack(event, session_id):
        try:
            await session.cdp_client.send.Page.screencastFrameAck(
                params={"sessionId": event["sessionId"]}, session_id=session_id
            )
        except Exception:
            pass

    def on_frame(event, session_id):
        nonlocal last_emit
        try:
            # Ack keeps Chromium sending frames; do it for every frame.
            asyncio.create_task(ack(event, session_id))
            if recorder is not None:
                recorder.add(event["data"])
            if not watch_event.is_set():
                return  # stragglers after stopScreencast, or nobody watching
            now = time.monotonic()
            if now - last_emit >= FRAME_MIN_INTERVAL:
                last_emit = now
                emit({"type": "frame", "data": event["data"]})
        except Exception:
            pass

    params = {
        "format": FRAME_FORMAT,
        "quality": FRAME_QUALITY,
        "maxWidth": FRAME_MAX_W,
        "maxHeight": FRAME_MAX_H,
        "everyNthFrame": 1,
    }

    async def stop_current():
        nonlocal current_sid
        if current_sid:
            try:
                await session.cdp_client.send.Page.stopScreencast(session_id=current_sid)
            except Exception:
                pass
            current_sid = None

    while not stop_event.is_set():
        if not watch_event.is_set() and recorder is None:
            await stop_current()
            try:
                await asyncio.wait_for(watch_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass  # re-check stop_event each second
            continue

        try:
            # focus=False so polling never steals focus from the agent.
            cdp_session = await session.get_or_create_cdp_session(target_id=None, focus=False)
        except Exception:
            await asyncio.sleep(0.3)
            continue

        if not registered:
            try:
                session.cdp_client.register.Page.screencastFrame(on_frame)
                registered = True
            except Exception:
                await asyncio.sleep(0.3)
                continue

        if cdp_session.session_id != current_sid:
            await stop_current()
            current_sid = cdp_session.session_id
            try:
                await cdp_session.cdp_client.send.Page.startScreencast(
                    params=params, session_id=cdp_session.session_id
                )
            except Exception:
                current_sid = None

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass  # re-check focused target (and watch state) each second

    await stop_current()


async def main() -> int:
    goal = os.environ.get("QA_GOAL", "").strip()
    start_url = os.environ.get("QA_START_URL", "").strip()
    max_steps = int(os.environ.get("QA_MAX_STEPS", "60"))
    model = os.environ.get("BROWSER_USE_MODEL", "gpt-4.1")

    if not goal or not start_url:
        emit({"type": "error", "message": "QA_GOAL and QA_START_URL are required"})
        return 1

    llm = ChatOpenAI(model=model)  # api_key read from OPENAI_API_KEY

    task = (
        f"Go to {start_url}\n\n"
        f"Then complete and verify this goal, acting like a real user:\n{goal}\n\n"
        f"When finished, clearly state whether the goal succeeded or failed and why."
    )

    run_id = os.environ.get("QA_RUN_ID")
    artifacts_dir = os.environ.get("ARTIFACTS_DIR")
    run_started = time.monotonic()

    # Record every run by default: the recording is part of the deliverable.
    recorder = None
    if run_id and artifacts_dir and os.environ.get("QA_RECORD", "1") != "0":
        recorder = SessionRecorder(os.path.join(artifacts_dir, run_id, RECORD_FILENAME))

    # --- email confirmation (US-013 tier 1), enabled when a mailbox is configured ---
    # Secrets (generated password, fetched code/link) go through browser-use
    # sensitive_data: the LLM only ever sees <secret>name</secret> placeholders,
    # so real values never appear in steps, logs, or the report. get_email_code
    # adds the fetched code/link to `sensitive` at runtime — browser-use re-reads
    # the same dict on every action, so later steps can substitute them.
    mailbox = ImapMailbox.from_env(os.environ)
    tools = None
    sensitive: dict[str, str] | None = None
    if mailbox:
        tools = Tools()
        tag = (run_id or pysecrets.token_hex(4)).replace("-", "")[:10]
        test_address = mailbox.generate_address(tag)
        sensitive = {"qa_password": "Qa1!" + pysecrets.token_urlsafe(9)}
        mail_since = time.time() - 60  # small clock-skew allowance

        @tools.action(
            "Fetch the confirmation email sent to the run's test email address and "
            "extract its verification code or confirmation link. Call this right after "
            "submitting a form that triggers a confirmation email; it waits up to "
            "timeout_seconds for the email to arrive."
        )
        async def get_email_code(timeout_seconds: int = 90) -> str:
            timeout = max(10, min(int(timeout_seconds), 180))
            # Wait in chunks so the viewer sees live progress during the poll.
            emit({"type": "progress", "message": f"Waiting for confirmation email to {test_address} (up to {timeout}s)…"})
            conf = None
            waited = 0
            try:
                while waited < timeout:
                    chunk = min(15, timeout - waited)
                    conf = await asyncio.to_thread(
                        mailbox.wait_for_confirmation, test_address, mail_since, chunk
                    )
                    waited += chunk
                    if conf is not None:
                        break
                    emit({"type": "progress", "message": f"Still waiting for confirmation email… ({waited}s)"})
            except Exception as e:
                emit({"type": "progress", "message": f"Mailbox error: {type(e).__name__}"})
                return f"Mailbox error ({type(e).__name__}) — cannot fetch the email. Report the goal as blocked."
            if conf is None:
                emit({"type": "progress", "message": f"No confirmation email after {timeout}s"})
                return (
                    f"No confirmation email arrived for {test_address} within {timeout}s. "
                    "Check the address was submitted correctly, or try once more."
                )
            got = []
            if conf.code:
                sensitive["email_code"] = conf.code
                got.append("a verification code — type <secret>email_code</secret> into the code field")
            if conf.link:
                sensitive["email_link"] = conf.link
                got.append("a confirmation link — navigate to <secret>email_link</secret>")
            # Scrub the subject: it may literally contain the code ("123456 is
            # your code"), which must not reach the LLM or the event feed.
            subject = scrub(conf.subject)
            emit({"type": "progress", "message": f'Confirmation email received: "{subject}"'})
            if not got:
                return (
                    f'Email arrived (subject: "{subject}") but no code or confirmation '
                    "link could be extracted from it."
                )
            return f'Confirmation email received (subject: "{subject}"). It contains ' + " and ".join(got) + "."

        task += (
            "\n\nEmail confirmation support: if the flow asks for an email address, use exactly "
            f"{test_address} — do not invent another. If asked to create a password, enter "
            "<secret>qa_password</secret>. After submitting a step that sends a confirmation "
            "email, use the get_email_code action, then enter <secret>email_code</secret> or "
            "open <secret>email_link</secret> as instructed by its result. Never guess codes."
        )

    # Secret values can leak into emitted events through side channels the
    # <secret> substitution doesn't cover — e.g. after navigating to a fetched
    # confirmation link, the browser URL *is* the secret. Scrub known values
    # from everything we emit.
    def scrub(text):
        if not isinstance(text, str) or not sensitive:
            return text
        for name, value in sensitive.items():
            if value and value in text:
                text = text.replace(value, f"<redacted:{name}>")
        return text

    async def on_step(browser_state, agent_output, step_number):
        try:
            url = scrub(getattr(browser_state, "url", None))

            # Save a durable per-step screenshot for the PDF report (separate
            # from the ephemeral live screencast frames).
            screenshot_file = None
            shot_b64 = getattr(browser_state, "screenshot", None)
            if shot_b64 and run_id and artifacts_dir:
                try:
                    run_dir = os.path.join(artifacts_dir, run_id)
                    os.makedirs(run_dir, exist_ok=True)
                    screenshot_file = f"step_{step_number}.png"
                    with open(os.path.join(run_dir, screenshot_file), "wb") as f:
                        f.write(base64.b64decode(shot_b64))
                except Exception:
                    screenshot_file = None

            emit({
                "type": "step",
                "step": step_number,
                "elapsed": round(time.monotonic() - run_started, 1),
                "url": url,
                "evaluation": scrub(getattr(agent_output, "evaluation_previous_goal", None)),
                "next_goal": scrub(getattr(agent_output, "next_goal", None)),
                "thinking": scrub(getattr(agent_output, "thinking", None)),
                "screenshot_file": screenshot_file,
            })
        except Exception as e:
            emit({"type": "warn", "message": f"step callback error: {e}"})

    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            # Memory-reduction flags: test sessions are ephemeral, so trade
            # site-isolation/crash-resilience for fewer, smaller processes.
            "--disable-gpu",
            "--process-per-site",
            "--renderer-process-limit=3",
            "--js-flags=--max-old-space-size=256",
            "--disable-extensions",
            "--mute-audio",
            "--disable-background-networking",
            "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
        ],
    )

    agent = Agent(
        task=task,
        llm=llm,
        browser_profile=profile,
        register_new_step_callback=on_step,
        tools=tools,
        sensitive_data=sensitive,
    )

    emit({"type": "start", "goal": goal, "start_url": start_url, "model": model})
    if mailbox:
        emit({"type": "log", "message": f"email confirmation enabled, test address: {test_address}"})

    stop_event = asyncio.Event()
    watch_event = asyncio.Event()  # set while at least one viewer is attached
    ctl_task = asyncio.create_task(stdin_control(watch_event, stop_event))
    sc_task = asyncio.create_task(screencast(agent.browser_session, watch_event, stop_event, recorder))
    # The failure is reported after cleanup, so the recording event always
    # reaches Express before done/error — the report is built off those.
    failure = None
    try:
        history = await agent.run(max_steps=max_steps)
    except Exception as e:
        failure = f"{type(e).__name__}: {e}"
    finally:
        stop_event.set()
        ctl_task.cancel()
        try:
            await asyncio.wait_for(sc_task, timeout=5)
        except Exception:
            pass
        if recorder is not None:
            saved = await asyncio.to_thread(recorder.stop)
            if saved:
                emit({"type": "recording", "file": RECORD_FILENAME, "frames": recorder.frames})

    if failure is not None:
        emit({"type": "error", "message": failure})
        return 1

    emit({
        "type": "done",
        "success": safe(history.is_successful),
        "steps": safe(history.number_of_steps),
        "duration_seconds": safe(history.total_duration_seconds),
        "final_result": scrub(safe(history.final_result)),
        "urls": [scrub(str(u)) for u in safe(history.urls, []) or []],
        "errors": [scrub(str(e)) for e in safe(history.errors, []) or [] if e],
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(1)
