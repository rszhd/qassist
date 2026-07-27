"""Runs a single browser-use agent and streams NDJSON events to stdout.

Express spawns this as a child process (one per test run) and relays each
line to the browser over a WebSocket. One JSON object per line, flushed
immediately so the UI updates live.

Two kinds of visual events are emitted:
  - {"type":"frame", "data": <jpeg-b64>}   CDP screencast (~6 fps), only while
                                            a viewer is attached (see below)
  - {"type":"step",  ...}                   one per agent reasoning step

Why a run failed comes over a third (US-044):
  - {"type":"diagnostics", "entries":[…], "dropped": n}
    failed requests, console errors and uncaught exceptions, each stamped with
    the step it happened during. Batched one event per step boundary — never per
    console line — capped and deduplicated in `diagnostics.py` before it crosses
    stdout, and scrubbed of the run's secrets on the way in.

Every run is also recorded to <ARTIFACTS_DIR>/<runId>/recording.mp4 off the
same frame stream (US-006); a {"type":"recording"} event announces the file
just before the run's done/error event.

Express also writes control commands to our stdin, one JSON object per line:
  {"cmd": "screencast", "on": true|false}   viewer attached / last viewer left
  {"cmd": "stop"}                           the user stopped this run (US-047)
Frames are only emitted while "on". Without recording the screencast itself is
stopped too, so an unwatched run skips the JPEG encoding entirely; a recorded
run needs the frames regardless and only gates the emitting.

Inputs come from environment variables:
  QA_GOAL, QA_START_URL, QA_MAX_STEPS, BROWSER_USE_MODEL, OPENAI_API_KEY
  QA_RUN_ID, ARTIFACTS_DIR (recording + step screenshots)
  QA_RECORD=0 disables recording (US-002's viewer gating then applies again)
  QA_HAR=1 also writes runs/<runId>/network.har — the full archive beside the
  curated summary, headers and bodies omitted (US-044)
  QA_FIXTURES (JSON array of absolute paths — the only files this run may
  attach or read; see fixtures.py)
  QA_STORAGE_STATE / QA_INITIAL_ACTIONS / QA_SESSION_VERIFY / QA_STORAGE_STATE_OUT
  (US-043: start authenticated, run a deterministic preamble first, notice a
  session that has expired, and export what a login run captured — see
  browser_session.py)
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
from redact import scrub
import diagnostics
import fixtures
import navigation_policy
import secret_vars
import browser_session

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

# Full network archive (US-044), opt-in via QA_HAR=1. Written by the browser
# itself, headers and bodies omitted — see the profile kwargs in main().
HAR_FILENAME = "network.har"
# We never read a response body, so Chromium has no reason to hold one. Keep its
# network buffers small: this process shares MAX_RUN_MEMORY_MB with Chromium.
NETWORK_BUFFER_BYTES = 1_000_000
NETWORK_RESOURCE_BUFFER_BYTES = 100_000


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


async def stdin_control(agent, watch_event: asyncio.Event, stop_event: asyncio.Event) -> None:
    """Apply control lines from Express: screencast on/off, and stop (US-047)."""
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
        cmd = msg.get("cmd")
        if cmd == "screencast":
            if msg.get("on"):
                watch_event.set()
            else:
                watch_event.clear()
        elif cmd == "stop":
            # Agent.stop() sets state.stopped and releases the pause event.
            # browser-use checks that flag before every action within a step,
            # not only between steps, so this lands within roughly one in-flight
            # action. The InterruptedError it raises is classified "not an
            # error" internally and agent.run() still returns its history — so
            # main()'s finally block runs, the recording is finalized, and
            # Express still builds a report out of the steps that did happen.
            # That is the whole difference from the SIGKILL this replaces.
            emit({"type": "progress", "message": "Stop requested — finishing up…"})
            agent.stop()


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


async def diagnostics_watch(session, diag, stop_event: asyncio.Event) -> None:
    """Collect console errors, uncaught exceptions and failed requests (US-044).

    Subscribes on the agent's focused target and re-arms when it switches tabs,
    the same shape `screencast` uses — but deliberately its own loop rather than
    a passenger on that one, which parks itself whenever nobody is watching and
    nothing is being recorded (US-002). Evidence for the report has to be
    collected either way.

    Handlers register once: `register` is per CDP client and dispatches for every
    session, while the per-target `Runtime.enable`/`Network.enable` below are what
    actually start the flow. Nothing in here is allowed to raise — these run on
    the hot path of every request the page makes, and a reporting bug must not
    cost a run.
    """
    pending = diagnostics.PendingRequests()

    def on_console(event, session_id):
        diag.console(event.get("type"), diagnostics.console_text(event.get("args")))

    def on_exception(event, session_id):
        diag.exception(diagnostics.exception_text(event.get("exceptionDetails")))

    def on_request(event, session_id):
        pending.started(event.get("requestId"), (event.get("request") or {}).get("url"))

    def on_response(event, session_id):
        response = event.get("response") or {}
        pending.finished(event.get("requestId"))
        diag.request(response.get("url"), status=response.get("status"))

    def on_failed(event, session_id):
        url = pending.finished(event.get("requestId"))
        # A cancelled request is not a failure. Every navigation aborts whatever
        # was still in flight, so counting those would spend the step's whole
        # budget on page transitions and crowd out the 500 we came for.
        error = str(event.get("errorText") or "")
        if event.get("canceled") or "ERR_ABORTED" in error:
            return
        diag.request(url, error=error or "request failed")

    registered = False
    armed = set()

    while not stop_event.is_set():
        try:
            # focus=False so polling never steals focus from the agent.
            cdp_session = await session.get_or_create_cdp_session(target_id=None, focus=False)
        except Exception:
            await asyncio.sleep(0.5)
            continue

        if not registered:
            try:
                register = session.cdp_client.register
                register.Runtime.consoleAPICalled(on_console)
                register.Runtime.exceptionThrown(on_exception)
                register.Network.requestWillBeSent(on_request)
                register.Network.responseReceived(on_response)
                register.Network.loadingFailed(on_failed)
                registered = True
            except Exception as e:
                emit({"type": "warn", "message": f"diagnostics unavailable: {type(e).__name__}: {e}"})
                return

        sid = cdp_session.session_id
        if sid not in armed:
            armed.add(sid)
            try:
                await cdp_session.cdp_client.send.Runtime.enable(session_id=sid)
                await cdp_session.cdp_client.send.Network.enable(
                    params={
                        "maxTotalBufferSize": NETWORK_BUFFER_BYTES,
                        "maxResourceBufferSize": NETWORK_RESOURCE_BUFFER_BYTES,
                    },
                    session_id=sid,
                )
            except Exception as e:
                # A target we could not arm collects nothing; say so once rather
                # than leaving a silently empty diagnostics section.
                emit({"type": "warn", "message": f"diagnostics not armed on a tab: {type(e).__name__}"})

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass  # re-check the focused target each second


async def main() -> int:
    goal = os.environ.get("QA_GOAL", "").strip()
    start_url = os.environ.get("QA_START_URL", "").strip()
    max_steps = int(os.environ.get("QA_MAX_STEPS", "60"))
    model = os.environ.get("BROWSER_USE_MODEL", "gpt-4.1")

    if not goal or not start_url:
        emit({"type": "error", "message": "QA_GOAL and QA_START_URL are required"})
        return 1

    # Where this run may navigate (US-042). Resolved by the server and read here
    # before anything expensive happens: a policy we cannot parse must stop the
    # run, not silently run it unfenced.
    try:
        nav_kwargs = navigation_policy.profile_kwargs(os.environ)
    except ValueError as e:
        emit({"type": "error", "message": str(e), "failure_reason": "invalid_policy"})
        return 1

    llm = ChatOpenAI(model=model)  # api_key read from OPENAI_API_KEY

    task = (
        f"Go to {start_url}\n\n"
        f"Then complete and verify this goal, acting like a real user:\n{goal}\n\n"
        f"When finished, clearly state whether the goal succeeded or failed and why."
    )

    # The files this run may attach (US-048). Everything not on this list is
    # refused by browser-use for both `upload_file` and `read_file`, so an empty
    # list — the case for every run whose test has no project — leaves the agent
    # with no filesystem reach at all, which is the default we want.
    fixture_paths = fixtures.load(os.environ)
    task += fixtures.task_note(fixture_paths)

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
    # Per-run secret variables (US-035) seed `sensitive` before the mailbox
    # password joins it — both use the same browser-use channel and the same
    # scrub, so they merge into one dict rather than compete for it.
    run_secrets = secret_vars.load(os.environ)
    mailbox = ImapMailbox.from_env(os.environ)
    tools = None
    sensitive: dict[str, str] | None = dict(run_secrets) if run_secrets else None
    if mailbox:
        tools = Tools()
        tag = (run_id or pysecrets.token_hex(4)).replace("-", "")[:10]
        test_address = mailbox.generate_address(tag)
        if sensitive is None:
            sensitive = {}
        sensitive["qa_password"] = "Qa1!" + pysecrets.token_urlsafe(9)
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
            subject = scrub(conf.subject, sensitive)
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

    # Network/console evidence (US-044). Created here, after the mailbox block
    # has finished deciding what `sensitive` is, so the buffer holds the *same*
    # dict browser-use does — get_email_code adds the fetched code to it mid-run,
    # and a copy taken earlier would keep scrubbing against the old contents.
    diag = diagnostics.Diagnostics(sensitive=sensitive)

    def flush_diagnostics():
        """Hand the step's findings to Express as one event.

        Batched at step boundaries, never one event per console line: the NDJSON
        pipe is the one thing in this architecture that must not back up (see the
        screencast note above), and a page can emit thousands of lines per step.
        `dropped` is the run total, so the report can say what the cap refused.
        """
        entries = diag.drain()
        if entries:
            emit({"type": "diagnostics", "entries": entries, "dropped": diag.dropped})

    # URLs the fence has already been reported as refusing, so a block that
    # persists across several steps is announced once (US-042).
    reported_blocks = set()

    def report_blocks(step_number=None):
        """Emit a `blocked` event for any navigation the fence has refused.

        SecurityWatchdog refuses inside the navigate action rather than by
        taking the run down, so the evidence arrives in the agent's own error
        history and the run otherwise looks like an ordinary failure. Whoever
        set the allowlist needs to see that it fired, so it is surfaced live.
        Never allowed to raise: a reporting bug must not cost a run.
        """
        found = []
        try:
            errors = safe(agent.history.errors, []) or []
        except Exception:
            return found
        for entry in errors:
            for message in entry if isinstance(entry, (list, tuple)) else [entry]:
                blocked = navigation_policy.blocked_url_in(str(message or ""))
                if not blocked or blocked in reported_blocks:
                    continue
                reported_blocks.add(blocked)
                found.append(blocked)
                event = {"type": "blocked", "url": blocked, "reason": "navigation_blocked"}
                if step_number is not None:
                    event["step"] = step_number
                emit(event)
        return found

    async def on_step(browser_state, agent_output, step_number):
        try:
            report_blocks(step_number)
            # Hand over what the previous step turned up, then move the
            # attribution on: this callback reports the goal the agent is *about*
            # to pursue, so everything the browser says from here belongs to
            # `step_number`. set_step also refreshes the per-step cap budget,
            # which is what stops a chatty first step silencing the one that fails.
            flush_diagnostics()
            diag.set_step(step_number)
            url = scrub(getattr(browser_state, "url", None), sensitive)

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
                "evaluation": scrub(getattr(agent_output, "evaluation_previous_goal", None), sensitive),
                "next_goal": scrub(getattr(agent_output, "next_goal", None), sensitive),
                "thinking": scrub(getattr(agent_output, "thinking", None), sensitive),
                "screenshot_file": screenshot_file,
            })
        except Exception as e:
            emit({"type": "warn", "message": f"step callback error: {e}"})

    # Full HAR (US-044), opt-in. The always-on artifact is the curated summary
    # above; this is the archive, and it is the one thing here `scrub` cannot
    # reach — the browser writes the file, so a secret in a query string lands in
    # it verbatim. Hence opt-in, hence `omit`/`minimal`: no headers (no `Bearer`,
    # no `Cookie`) and no bodies unless someone deliberately asks. It lives in
    # runs/<id>/, so ARTIFACT_RETENTION_DAYS prunes it with everything else.
    har_kwargs = {}
    if run_id and artifacts_dir and os.environ.get("QA_HAR", "0") == "1":
        har_path = os.path.join(artifacts_dir, run_id, HAR_FILENAME)
        os.makedirs(os.path.dirname(har_path), exist_ok=True)
        har_kwargs = {
            "record_har_path": har_path,
            "record_har_content": "omit",
            "record_har_mode": "minimal",
        }

    # US-043: the saved session, as a PATH. browser-use only loads a storage
    # state from a file — a dict passes the type hint and loads nothing at all,
    # which is a cold browser wearing a configured session's clothes.
    session_kwargs = browser_session.profile_kwargs(os.environ)

    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        **har_kwargs,
        **session_kwargs,
        # US-042: SecurityWatchdog enforces these on every navigation, including
        # the ones a redirect chain arrives at — which is the case the server's
        # own pre-check on start_url cannot see.
        **nav_kwargs,
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

    # The project's preamble (US-043 AC #5): deterministic actions executed
    # before the first LLM step, recorded by browser-use as step 0
    # (agent/service.py:3300) so the steps this run is charged for still start
    # at 1. None when the project has none, which leaves browser-use's own
    # URL-from-the-task navigation exactly as it is today.
    preamble = browser_session.initial_actions(os.environ, start_url)

    agent = Agent(
        task=task,
        llm=llm,
        browser_profile=profile,
        initial_actions=preamble,
        register_new_step_callback=on_step,
        tools=tools,
        sensitive_data=sensitive,
        # US-048: the whitelist, and the whole of it. Passing None here is what
        # browser-use defaults to, and it means the same "nothing" — but only
        # this spelling says so on purpose.
        available_file_paths=fixture_paths,
    )

    # US-043 AC #4: is the session we were handed still signed in? Checked in
    # the on_step_start hook, which browser-use awaits at the top of a step and
    # BEFORE that step's LLM call (agent/service.py:2442) — and the preamble has
    # already run by then, so this sees the page the agent would have started
    # reasoning about. Cheaper than the alternative in the only currency that
    # matters: an expired session costs one verdict instead of twenty steps of
    # an agent hunting a checkout button on a login screen.
    session_check = browser_session.verify_config(os.environ)
    expired = None

    async def check_session(agent_ref):
        nonlocal expired, session_check
        if session_check is None:
            return
        check, session_check = session_check, None  # once, on the first step only
        try:
            url = await agent_ref.browser_session.get_current_page_url()
        except Exception:
            return  # a browser we cannot ask is not a session we can judge
        page_text = None
        try:
            cdp = await agent_ref.browser_session.get_or_create_cdp_session(focus=False)
            result = await cdp.cdp_client.send.Runtime.evaluate(
                params={"expression": "document.body ? document.body.innerText : \'\'",
                        "returnByValue": True},
                session_id=cdp.session_id,
            )
            page_text = (result.get("result") or {}).get("value")
        except Exception:
            page_text = None  # unread, which is NOT the same as "text absent"
        reason = browser_session.expiry_reason(check, url, page_text)
        if reason:
            expired = reason
            emit({"type": "progress", "message": reason})
            agent_ref.stop()

    # A login run's capture (US-043), taken at the END OF EVERY STEP rather than
    # after the run.
    #
    # The obvious place is after `agent.run()` returns — and it cannot work:
    # `run()` calls `await self.close()` in its own finally
    # (agent/service.py:2716), which kills the browser session, so by the time
    # our own finally block executes there is nothing left to read cookies from.
    # It fails quietly, which is the third time this story has met that shape.
    #
    # `on_step_end` runs at service.py:2471, BEFORE the is_done() check and
    # while the browser is alive, so it fires on the final step too. Each step
    # overwrites the file; the last write is the state at the end of the last
    # step, which is exactly what a login run means to capture. A handful of
    # cheap CDP reads on login runs only — nothing else sets the variable.
    #
    # Written on every step regardless of how the run ends: the SERVER decides
    # whether to keep it, and keeps it only on a pass. Judging here would rest
    # the decision on the agent's own self-report, which the server already
    # refuses to trust for the verdict (US-047).
    capture_to = browser_session.export_path(os.environ)
    capture_failed = False

    async def capture_session(agent_ref):
        nonlocal capture_failed
        if capture_to is None or capture_failed:
            return
        try:
            os.makedirs(os.path.dirname(capture_to), exist_ok=True)
            session = agent_ref.browser_session
            # `_cdp_get_storage_state`, NOT the public `export_storage_state`.
            # The public one calls the cookie half and then hardcodes
            # `'origins': []` (browser/session.py:1456, "Could add
            # localStorage/sessionStorage extraction if needed"), so a session
            # captured through it silently drops localStorage — and an app that
            # keeps its token there gets a session that looks captured (cookies
            # counted, timestamp fresh) and authenticates nobody. The private
            # one is what StorageStateWatchdog itself uses and returns both.
            #
            # Private, so it may be renamed; the public wrapper is the fallback
            # rather than the default, because cookies-only is worth having and
            # a failed capture is not.
            getter = getattr(session, "_cdp_get_storage_state", None)
            if getter is not None:
                state = browser_session.to_storage_state(await getter())
            else:
                emit({"type": "warn", "message": "session captured without localStorage support"})
                state = await session.export_storage_state()
            with open(capture_to, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception as e:
            # Once, not per step: a login run that cannot be captured should say
            # so, and should not say so twenty times.
            capture_failed = True
            emit({"type": "warn", "message": f"session not captured: {type(e).__name__}: {e}"})

    if preamble:
        # Announce it so the viewer and the report can show that these ran and
        # that none of them was charged as a step.
        emit({
            "type": "preamble",
            "actions": [next(iter(a)) for a in preamble],
            "count": len(preamble),
        })

    emit({"type": "start", "goal": goal, "start_url": start_url, "model": model})
    if mailbox:
        emit({"type": "log", "message": f"email confirmation enabled, test address: {test_address}"})

    stop_event = asyncio.Event()
    watch_event = asyncio.Event()  # set while at least one viewer is attached
    ctl_task = asyncio.create_task(stdin_control(agent, watch_event, stop_event))
    sc_task = asyncio.create_task(screencast(agent.browser_session, watch_event, stop_event, recorder))
    dg_task = asyncio.create_task(diagnostics_watch(agent.browser_session, diag, stop_event))
    # The failure is reported after cleanup, so the recording event always
    # reaches Express before done/error — the report is built off those.
    failure = None
    try:
        history = await agent.run(
            max_steps=max_steps, on_step_start=check_session, on_step_end=capture_session
        )
    except Exception as e:
        failure = f"{type(e).__name__}: {e}"
    finally:
        stop_event.set()
        ctl_task.cancel()
        for task in (sc_task, dg_task):
            try:
                await asyncio.wait_for(task, timeout=5)
            except Exception:
                pass
        # The last step's evidence, and a crashed run's only evidence: whatever
        # the browser said during the final step has no later on_step to flush it,
        # exactly as with the fence's late blocks below. Emitted here so it
        # reaches Express before done/error, which is when the report is built.
        flush_diagnostics()
        if recorder is not None:
            saved = await asyncio.to_thread(recorder.stop)
            if saved:
                emit({"type": "recording", "file": RECORD_FILENAME, "frames": recorder.frames})

    # The fence's last word (US-042). A block that happened on the final step
    # has no later on_step to announce it, and a block that took the run down
    # never reached one at all — so the history is swept once more here, and the
    # reason travels on the terminal event either way. A blocked run is a
    # verdict with a `failure_reason`, not a crash.
    late_blocks = report_blocks()
    blocked_url = navigation_policy.blocked_url_in(failure or "")
    if blocked_url and blocked_url not in reported_blocks:
        reported_blocks.add(blocked_url)
        emit({"type": "blocked", "url": blocked_url, "reason": "navigation_blocked"})
    elif late_blocks:
        blocked_url = late_blocks[-1]

    # An expired session is a FAILED run carrying a reason, not a crash and not
    # a goal that was not met (AC #4). `error` would make it a US-012 alert and
    # a red build for something that is merely stale, and an ordinary `failed`
    # would send whoever reads the report hunting a checkout button that was
    # never the problem. Same shape US-042 gives a fenced run.
    if expired is not None:
        emit({
            "type": "done",
            "success": False,
            "failure_reason": "session_expired",
            "steps": safe(history.number_of_steps) if failure is None else 0,
            "duration_seconds": round(time.monotonic() - run_started, 1),
            "final_result": expired,
            "errors": [expired],
        })
        return 0

    if failure is not None:
        event = {"type": "error", "message": failure}
        if reported_blocks:
            event["failure_reason"] = "navigation_blocked"
            event["blocked_url"] = blocked_url or sorted(reported_blocks)[0]
        emit(event)
        return 1

    emit({
        "type": "done",
        "failure_reason": "navigation_blocked" if reported_blocks else None,
        "blocked_url": blocked_url if reported_blocks else None,
        "success": safe(history.is_successful),
        "steps": safe(history.number_of_steps),
        "duration_seconds": safe(history.total_duration_seconds),
        "final_result": scrub(safe(history.final_result), sensitive),
        "urls": [scrub(str(u), sensitive) for u in safe(history.urls, []) or []],
        "errors": [scrub(str(e), sensitive) for e in safe(history.errors, []) or [] if e],
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(1)
