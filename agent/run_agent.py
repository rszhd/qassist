"""Runs a single browser-use agent and streams NDJSON events to stdout.

Express spawns this as a child process (one per test run) and relays each
line to the browser over a WebSocket. One JSON object per line, flushed
immediately so the UI updates live.

Two kinds of visual events are emitted:
  - {"type":"frame", "data": <jpeg-b64>}   continuous CDP screencast (~6 fps)
  - {"type":"step",  ...}                   one per agent reasoning step

Inputs come from environment variables:
  QA_GOAL, QA_START_URL, QA_MAX_STEPS, BROWSER_USE_MODEL, OPENAI_API_KEY
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from browser_use import Agent, ChatOpenAI
from browser_use.browser.profile import BrowserProfile

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


async def screencast(session, stop_event: asyncio.Event) -> None:
    """Continuously stream CDP screencast frames until stop_event is set.

    Mirrors browser-use's own recording watchdog: register a frame handler,
    start the screencast on the focused target, ack every frame, and re-target
    when the agent switches tabs.
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

    while not stop_event.is_set():
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
            if current_sid:
                try:
                    await session.cdp_client.send.Page.stopScreencast(session_id=current_sid)
                except Exception:
                    pass
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
            pass  # re-check focused target each second

    if current_sid:
        try:
            await session.cdp_client.send.Page.stopScreencast(session_id=current_sid)
        except Exception:
            pass


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

    async def on_step(browser_state, agent_output, step_number):
        try:
            page_info = getattr(browser_state, "page_info", None)
            url = getattr(page_info, "url", None) if page_info is not None else None
            emit({
                "type": "step",
                "step": step_number,
                "url": url,
                "evaluation": getattr(agent_output, "evaluation_previous_goal", None),
                "next_goal": getattr(agent_output, "next_goal", None),
                "thinking": getattr(agent_output, "thinking", None),
            })
        except Exception as e:
            emit({"type": "warn", "message": f"step callback error: {e}"})

    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )

    agent = Agent(
        task=task,
        llm=llm,
        browser_profile=profile,
        register_new_step_callback=on_step,
    )

    emit({"type": "start", "goal": goal, "start_url": start_url, "model": model})

    stop_event = asyncio.Event()
    sc_task = asyncio.create_task(screencast(agent.browser_session, stop_event))
    try:
        history = await agent.run(max_steps=max_steps)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        return 1
    finally:
        stop_event.set()
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
