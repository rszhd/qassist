"""What a step boundary produces, and the order it produces it in.

browser-use calls `run_agent.py`'s registered callback once per step, before
that step's actions. Everything the callback decides between being called and
emitting is here, because none of it needs a browser: the durable screenshot,
the assembled `step` event, and the sequence the two are wrapped in.

`browser_state` and `agent_output` are read with `getattr` and nothing else, so
a test hands in any object carrying the fields — which is what makes the
sequence assertable without a Chromium. Its collaborators (report the fence's
blocks, flush the previous step's diagnostics, advance the attribution) arrive
as plain callables for the same reason.

THE EVENT SHAPE LIVES IN `server/src/runEvents.js`. `step_event` below is its
author; a field added or renamed here lands there in the same commit.
"""
from __future__ import annotations

import base64
import os
import time

from redact import scrub


def screenshot_name(step_number) -> str:
    return f"step_{step_number}.png"


def save_screenshot(run_dir, step_number, frame_b64):
    """Write the step's durable PNG and return its filename, or None.

    Separate from the ephemeral screencast frames: these are what the PDF
    report reads off disk afterwards. Every failure resolves to None — a
    screenshot that cannot be written is a null field in the step event, never
    a lost step.
    """
    if not frame_b64 or not run_dir:
        return None
    try:
        os.makedirs(run_dir, exist_ok=True)
        name = screenshot_name(step_number)
        with open(os.path.join(run_dir, name), "wb") as f:
            f.write(base64.b64decode(frame_b64))
        return name
    except Exception:
        return None


def step_event(browser_state, agent_output, step_number, elapsed, screenshot_file, sensitive):
    """The `step` event, with every page- and model-authored field scrubbed.

    `sensitive` is the LIVE dict browser-use holds, not a copy: `get_email_code`
    adds the fetched code to it mid-run, and a copy taken when the callback was
    built would keep scrubbing against the old contents.
    """
    return {
        "type": "step",
        "step": step_number,
        "elapsed": round(elapsed, 1),
        "url": scrub(getattr(browser_state, "url", None), sensitive),
        "evaluation": scrub(getattr(agent_output, "evaluation_previous_goal", None), sensitive),
        "next_goal": scrub(getattr(agent_output, "next_goal", None), sensitive),
        "thinking": scrub(getattr(agent_output, "thinking", None), sensitive),
        "screenshot_file": screenshot_file,
    }


def callback(
    *,
    emit,
    report_blocks,
    flush_diagnostics,
    set_step,
    run_dir,
    sensitive,
    run_started,
    clock=time.monotonic,
):
    """browser-use's `register_new_step_callback`, and the boundary it draws.

    Report the fence's refusals, hand over what the PREVIOUS step turned up,
    then move the attribution on. This callback announces the goal the agent is
    *about* to pursue, so everything above belongs to the step that is ending
    and `set_step` goes last because it belongs to the one starting.

    That `set_step` runs at every boundary is the load-bearing part: it refreshes
    the per-step cap budget, which is what stops a chatty first step spending the
    run's diagnostics allowance and silencing the step that fails. Its position
    is not — `flush_diagnostics` and `set_step` commute as `Diagnostics` stands,
    because a finding is stamped and charged when it is CAPTURED and nothing is
    captured between these two lines. Kept in this order because an attribution
    read at drain time would make it matter, and this is the order that survives
    that. `tests/test_step_events.py::TestStepBoundary` pins the properties, not
    the sequence.

    Never allowed to raise. A reporting bug here would take the run down at a
    step boundary, so the whole body is wrapped and a failure costs one warning
    — and, because it is one wrapper, that step's event.
    """

    async def on_step(browser_state, agent_output, step_number):
        try:
            report_blocks(step_number)
            flush_diagnostics()
            set_step(step_number)
            screenshot_file = save_screenshot(
                run_dir, step_number, getattr(browser_state, "screenshot", None)
            )
            emit(step_event(
                browser_state,
                agent_output,
                step_number,
                clock() - run_started,
                screenshot_file,
                sensitive,
            ))
        except Exception as e:
            emit({"type": "warn", "message": f"step callback error: {e}"})

    return on_step
