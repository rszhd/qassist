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


def _money(cost) -> str:
    """A cost that runs from dollars to fractions of a cent, printed honestly.

    A fixed two decimals would round a real charge down to `$0.00`, which is
    this story's failure mode reached by formatting instead of by a missing
    flag. Three decimals under a dollar, and an amount smaller than those can
    hold says so rather than collapsing. A zero reaching here has already been
    established as measured, and a free model may read as free.
    """
    try:
        n = float(cost)
    except (TypeError, ValueError):
        return "—"
    if n != n or n in (float("inf"), float("-inf")):
        return "—"
    if n == 0:
        return "$0.00"
    if n >= 1:
        return f"${n:.2f}"
    return "< $0.001" if n < 0.001 else f"${n:.3f}"


def fmt_cost(usage) -> str:
    """What the run spent (US-046), decided by `cost_known` and never the number.

    browser-use reports `0.0` when costing was off, when the pricing table never
    loaded, and when the model has no published price, so only a *known* zero
    means the run was free. 'Unknown' is a run that was measured and could not
    be priced; '—' is a run nothing measured. Neither is ever `$0.00`.

    The web app renders the same three answers in `frontend/src/status.js`
    (`formatCost`) — two renderers, one rule, and a change to the rule belongs
    in both.
    """
    u = usage if isinstance(usage, dict) else {}
    if u.get("cost_known") is True and u.get("total_cost") is not None:
        return _money(u.get("total_cost"))
    return "—" if u.get("total_tokens") is None else "Unknown"


def fmt_tokens(n) -> str:
    """A token count, grouped; '—' when nobody counted."""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "—"


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


# The cover fits about ten lines of instruction under the verdict before the
# recording hero is pushed onto a page of its own. Errors and a long summary
# share that space, so the band gets well under half of it.
GOAL_COVER_LIMIT = 280


def clamp_goal(goal, limit: int = GOAL_COVER_LIMIT) -> tuple[str, bool]:
    """Cut the cover's copy of the instruction to `limit` characters.

    Returns `(cover_text, clamped)`. A clamped instruction is printed in full
    in the body, so the cut only has to read as a sentence, not carry the
    whole test: it breaks on a space and ends in an ellipsis.
    """
    text = " ".join(str(goal or "").split())
    if len(text) <= limit:
        return text, False
    head = text[:limit]
    # Only drop the trailing token when the limit fell inside it. A cut that
    # already landed on a boundary keeps the word it just completed.
    if text[limit] != " ":
        head = head.rsplit(" ", 1)[0]
    cut = head.rstrip(".,;:—- ")
    # A single word longer than the limit has no space to break on; the raw cut
    # is better than an empty band.
    return (cut or head) + "…", True
