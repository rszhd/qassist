"""Runs a single browser-use agent and streams NDJSON events to stdout.

Express spawns this as a child process (one per test run) and relays each
line to the browser over a WebSocket. One JSON object per line, flushed
immediately so the UI updates live.

Two kinds of visual events are emitted:
  - {"type":"frame", "data": <jpeg-b64>}   CDP screencast (~6 fps), only while
                                            a viewer is attached (see below)
  - {"type":"step",  ...}                   one per agent reasoning step

Express also writes control commands to our stdin, one JSON object per line:
  {"cmd": "screencast", "on": true|false}   viewer attached / last viewer left
The screencast is only captured while "on" — unwatched runs skip the JPEG
encoding entirely.

Inputs come from environment variables:
  QA_GOAL, QA_START_URL, QA_MAX_STEPS, BROWSER_USE_MODEL, OPENAI_API_KEY
  QA_IMAP_* / QA_MAILBOX_DOMAIN (optional — enables email confirmation, see
  email_codes.py)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets as pysecrets
import sys
import time

from browser_use import Agent, ChatOpenAI, Tools
from browser_use.browser.profile import BrowserProfile

from email_codes import ImapMailbox

# Screencast tuning — keep bandwidth modest so stdout never backs up.
FRAME_FORMAT = "jpeg"
FRAME_QUALITY = 55
FRAME_MAX_W = 1024
FRAME_MAX_H = 720
FRAME_MIN_INTERVAL = 1 / 6  # cap emitted frames to ~6 fps


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


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


async def screencast(session, watch_event: asyncio.Event, stop_event: asyncio.Event) -> None:
    """Stream CDP screencast frames while a viewer is attached (watch_event set).

    Mirrors browser-use's own recording watchdog: register a frame handler,
    start the screencast on the focused target, ack every frame, and re-target
    when the agent switches tabs. While no viewer is attached the screencast
    stays stopped, so Chromium does no frame encoding at all.
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
            if not watch_event.is_set():
                return  # stragglers after stopScreencast
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
        if not watch_event.is_set():
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
            try:
                conf = await asyncio.to_thread(
                    mailbox.wait_for_confirmation, test_address, mail_since, timeout
                )
            except Exception as e:
                return f"Mailbox error ({type(e).__name__}) — cannot fetch the email. Report the goal as blocked."
            if conf is None:
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
            if not got:
                return (
                    f'Email arrived (subject: "{conf.subject}") but no code or confirmation '
                    "link could be extracted from it."
                )
            return f'Confirmation email received (subject: "{conf.subject}"). It contains ' + " and ".join(got) + "."

        task += (
            "\n\nEmail confirmation support: if the flow asks for an email address, use exactly "
            f"{test_address} — do not invent another. If asked to create a password, enter "
            "<secret>qa_password</secret>. After submitting a step that sends a confirmation "
            "email, use the get_email_code action, then enter <secret>email_code</secret> or "
            "open <secret>email_link</secret> as instructed by its result. Never guess codes."
        )

    async def on_step(browser_state, agent_output, step_number):
        try:
            url = getattr(browser_state, "url", None)

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
                "evaluation": getattr(agent_output, "evaluation_previous_goal", None),
                "next_goal": getattr(agent_output, "next_goal", None),
                "thinking": getattr(agent_output, "thinking", None),
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
    sc_task = asyncio.create_task(screencast(agent.browser_session, watch_event, stop_event))
    try:
        history = await agent.run(max_steps=max_steps)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        return 1
    finally:
        stop_event.set()
        ctl_task.cancel()
        try:
            await asyncio.wait_for(sc_task, timeout=5)
        except Exception:
            pass

    emit({
        "type": "done",
        "success": safe(history.is_successful),
        "steps": safe(history.number_of_steps),
        "duration_seconds": safe(history.total_duration_seconds),
        "final_result": safe(history.final_result),
        "urls": safe(history.urls, []),
        "errors": [e for e in safe(history.errors, []) or [] if e],
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(1)
