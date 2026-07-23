"""Pure formatters for the PDF report (US-034).

Split out of make_report.py so they're unit-testable without importing
Playwright (which make_report pulls in to render). Stdlib only.
"""
from __future__ import annotations

import html
from datetime import datetime, timezone


def esc(v) -> str:
    return html.escape(str(v)) if v is not None else ""


def fmt_duration(secs) -> str:
    if not secs:
        return "—"
    secs = round(secs)
    if secs < 60:
        return f"{secs}s"
    return f"{secs // 60}m {secs % 60}s"


def fmt_elapsed(secs) -> str:
    if secs is None:
        return "—:—"
    secs = int(secs)
    return f"{secs // 60:02d}:{secs % 60:02d}"


def fmt_date(iso) -> str:
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%d · %H:%M UTC")
    except Exception:
        return esc(iso)


def step_ok(evaluation) -> bool | None:
    """Heuristic pass/fail marker per step from the agent's own evaluation text."""
    if not evaluation:
        return None
    text = str(evaluation).lower()
    if any(w in text for w in ("fail", "error", "block", "unable", "could not")):
        return False
    if "success" in text:
        return True
    return None
