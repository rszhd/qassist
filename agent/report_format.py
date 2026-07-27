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


def group_diagnostics(diagnostics):
    """Group US-044's flat evidence list into `[(step, [entry, …]), …]`.

    Ordered by step, with the findings that predate the first step leading — a
    page whose own assets failed to load broke before the agent did anything,
    and that is the first thing worth reading, not a trailing footnote. Order
    within a step is the order it was captured in.
    """
    groups: dict = {}
    for entry in diagnostics or []:
        if not isinstance(entry, dict):
            continue
        step = entry.get("step")
        groups.setdefault(step if isinstance(step, int) else None, []).append(entry)
    # None sorts before every step number; -1 stands in for it as a sort key
    # only, since None and int aren't comparable.
    return sorted(groups.items(), key=lambda kv: -1 if kv[0] is None else kv[0])


def diagnostic_label(entry) -> str:
    """The short tag a finding reads under: its status code, or its kind."""
    kind = (entry or {}).get("kind")
    if kind == "request":
        status = entry.get("status")
        return str(status) if isinstance(status, int) else "FAILED"
    if kind == "console":
        return "WARN" if entry.get("level") == "warning" else "ERROR"
    if kind == "exception":
        return "UNCAUGHT"
    return "—"


def diagnostic_detail(entry) -> str:
    """The finding itself, on one line: the URL that failed, or the message.

    A failed request's transport error is appended to its URL — "the request
    that never came back" is the URL *plus* the reason, and neither half is
    worth much alone.
    """
    entry = entry or {}
    if entry.get("kind") == "request":
        url = str(entry.get("url") or "")
        error = entry.get("error")
        return f"{url} — {error}" if error else url
    return str(entry.get("text") or "")


def fmt_occurrences(count) -> str:
    """`3×` for a finding that repeated, nothing for one that didn't."""
    return f"{count}×" if isinstance(count, int) and count > 1 else ""


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
