"""Network and console evidence for a run, capped and redacted (US-044).

A failing QAssist run used to say the goal was not achieved and show you
screenshots — a symptom report. The cause is usually right there in the browser
at the moment of failure: a 500 from the API, a CORS rejection, an uncaught
`TypeError` that killed the submit handler. `Diagnostics` is the buffer those
land in on their way to the step feed, `report_data.json` and the PDF.

Two properties this file exists to hold, both of which fail silently:

**Everything in here is page-authored text**, and it ends up in an artifact that
US-012 emails. So a captured line is scrubbed against the run's `sensitive` dict
(US-035 secret variables, US-013's fetched codes) *before* anything else touches
it — before truncation, which would otherwise split a long secret so `scrub` no
longer matches the whole value and the surviving prefix ships, and before the
dedupe key, which would otherwise hold the raw value in memory and treat two
lines differing only inside a secret as two separate findings.

**A chatty single-page app emits thousands of console lines per step.** The cap
is per kind, per step, and the per-step budget resets on every step: the run's
last step is the one this whole story exists to explain, and a cap that is
really per-run would have spent itself on step 1. That also bounds the whole run
without a second ceiling anywhere else — `MAX_PER_KIND_PER_STEP` × 3 kinds ×
`QA_MAX_STEPS` is the ceiling, which is what keeps the NDJSON pipe into Express
from backing up. What the cap refuses is counted, never silently dropped.

Stdlib only (`redact` aside), no browser-use/Playwright/CDP imports, so it is
unit-testable in isolation like `redact` and `secret_vars`. The CDP subscriptions
that feed it live in run_agent.py; the two `*_text` helpers below are the shapes
those events arrive in.
"""
from __future__ import annotations

from collections import OrderedDict

from redact import scrub

# Distinct findings kept per kind per step. Small on purpose: this is an
# always-on artifact that has to stay a summary, and 5 × 3 kinds × a 60-step run
# is the whole bound. The full archive is the opt-in HAR.
MAX_PER_KIND_PER_STEP = 5
# Per line, after scrubbing. Long enough for a stack frame or a URL with a query
# string, short enough that a page printing minified JS can't bloat the report.
MAX_TEXT = 300

# CDP's Runtime.consoleAPICalled says "warning"; everyone writing the calling
# code says "warn". Accept both spellings, store one. Anything not in here —
# log, info, debug, trace, table — is chatter, not evidence.
CONSOLE_LEVELS = {"error": "error", "warning": "warning", "warn": "warning"}

# How many in-flight requests `PendingRequests` will remember at once.
MAX_TRACKED_REQUESTS = 500


class Diagnostics:
    """A bounded, deduplicated, redacted buffer of one run's browser evidence.

    `set_step` marks which step is in flight; every finding captured after it is
    attributed to that step. `drain` hands over everything buffered since the
    last call — run_agent flushes once per step boundary rather than emitting
    per console line, which is what keeps stdout from backing up.
    """

    def __init__(
        self,
        sensitive=None,
        max_per_kind_per_step=MAX_PER_KIND_PER_STEP,
        max_text=MAX_TEXT,
    ) -> None:
        self.sensitive = sensitive
        self.max_per_kind_per_step = max_per_kind_per_step
        self.max_text = max_text
        # Distinct findings the cap turned away, over the whole run. Monotonic:
        # it is what lets the report say "+143 more" rather than implying a page
        # that had nothing to say.
        self.dropped = 0
        self._step = None
        # Doubles as the dedupe map: a key already here takes a count instead of
        # a second entry. Cleared by `drain`, so a finding's count is fixed once
        # it has crossed stdout.
        self._pending: dict[tuple, dict] = {}
        # Distinct findings kept this step, per kind. Reset by `set_step`.
        self._kept: dict[str, int] = {}

    # --- attribution ---

    def set_step(self, step) -> None:
        """Attribute everything captured from now on to `step`, and refresh the
        per-step budget. A step marker we can't read attributes to nothing
        rather than to the wrong step."""
        self._step = step if isinstance(step, int) else None
        self._kept = {}

    # --- capture ---

    def request(self, url, status=None, error=None) -> None:
        """A response worth reporting: status >= 400, or a request that failed
        in transport (no status at all — the CORS rejection and the DNS failure
        both arrive this way, and neither is visible in a screenshot)."""
        try:
            code = status if isinstance(status, int) and not isinstance(status, bool) else None
            failed = (code is not None and code >= 400) or bool(error)
            if not failed:
                return
            clean_url = self._text(url)
            if not clean_url:
                return
            clean_error = self._text(error) or None
            self._add(
                "request",
                ("request", self._step, code, clean_url, clean_error),
                {
                    "kind": "request",
                    "step": self._step,
                    "url": clean_url,
                    "status": code,
                    "error": clean_error,
                },
            )
        except Exception:
            pass  # a reporting bug must never cost a run

    def console(self, level, text) -> None:
        """A console `error` or `warning`. Anything chattier is dropped here, so
        the filter lives in one place rather than at each CDP handler."""
        try:
            name = CONSOLE_LEVELS.get(str(level).strip().lower())
            if not name:
                return
            clean = self._text(text)
            if not clean:
                return
            self._add(
                "console",
                ("console", self._step, name, clean),
                {"kind": "console", "step": self._step, "level": name, "text": clean},
            )
        except Exception:
            pass

    def exception(self, text) -> None:
        """An uncaught exception — the one that killed the submit handler."""
        try:
            clean = self._text(text)
            if not clean:
                return
            self._add(
                "exception",
                ("exception", self._step, clean),
                {"kind": "exception", "step": self._step, "text": clean},
            )
        except Exception:
            pass

    # --- handover ---

    def drain(self) -> list[dict]:
        """Everything buffered since the last call, and empty the buffer."""
        entries = list(self._pending.values())
        self._pending = {}
        return entries

    # --- internals ---

    def _text(self, value) -> str:
        """Scrub, then truncate — in that order, and that order is the point.

        Truncating first splits a secret longer than the limit, leaving a prefix
        `scrub` can no longer match against the full value; the fragment then
        travels all the way into the emailed PDF.
        """
        if value is None:
            return ""
        text = value if isinstance(value, str) else str(value)
        text = scrub(text, self.sensitive)
        if self.max_text > 0 and len(text) > self.max_text:
            text = text[: self.max_text - 1] + "…"
        return text

    def _add(self, kind: str, key: tuple, entry: dict) -> None:
        seen = self._pending.get(key)
        if seen is not None:
            seen["count"] += 1
            return
        # At cap the buffer stops accepting new *findings*, not new occurrences
        # of one it already holds — counting those costs nothing and is what
        # keeps "2000×" honest.
        if self._kept.get(kind, 0) >= self.max_per_kind_per_step:
            self.dropped += 1
            return
        self._kept[kind] = self._kept.get(kind, 0) + 1
        entry["count"] = 1
        self._pending[key] = entry


# --- the shapes CDP delivers, flattened to a line of text ---------------------
# Ordinary formatters, kept here beside the buffer they feed rather than in
# run_agent.py, so they can be tested without importing browser-use.


def console_text(args) -> str:
    """Flatten `Runtime.consoleAPICalled`'s RemoteObject args into one line.

    A primitive arrives as `value`; an Error or object arrives as `description`
    (`"TypeError: x is not a function"`), which is the part worth having.
    """
    parts = []
    for arg in args or []:
        if not isinstance(arg, dict):
            continue
        if "value" in arg:
            parts.append(str(arg["value"]))
        elif arg.get("description"):
            parts.append(str(arg["description"]))
        elif arg.get("className"):
            parts.append(str(arg["className"]))
        elif arg.get("type"):
            parts.append("<%s>" % arg["type"])
    return " ".join(p for p in parts if p).strip()


class PendingRequests:
    """`requestId` -> url, so a failed request can be named.

    `Network.loadingFailed` carries a requestId and an errorText and *not* the
    URL — that only ever arrives on `Network.requestWillBeSent`. Correlating the
    two is the whole job, and "the request that never came back" is one of the
    two failures this story exists to surface, so guessing is not an option.

    Bounded, oldest evicted first: this sits on the hot path of every request a
    page makes, and a single-page app makes thousands. The URLs here are raw —
    the map is CDP plumbing that is never emitted, and `Diagnostics.request`
    scrubs at the moment one becomes a finding.
    """

    def __init__(self, limit=MAX_TRACKED_REQUESTS) -> None:
        self.limit = limit
        self._urls: OrderedDict[str, str] = OrderedDict()

    def started(self, request_id, url) -> None:
        if not request_id or not url:
            return
        self._urls[request_id] = url
        self._urls.move_to_end(request_id)
        while len(self._urls) > self.limit:
            self._urls.popitem(last=False)

    def finished(self, request_id):
        """This request's URL, forgotten as it is handed over. None if the map
        never saw it, or has since evicted it."""
        return self._urls.pop(request_id, None)


def exception_text(details) -> str:
    """Pull the readable line out of `Runtime.exceptionThrown`'s exceptionDetails.

    `exception.description` carries the message *and* the stack when there is
    one; `text` is the bare "Uncaught" wrapper, so it is the fallback.
    """
    if not isinstance(details, dict):
        return ""
    exception = details.get("exception")
    if isinstance(exception, dict):
        described = exception.get("description") or exception.get("value")
        if described:
            return str(described)
    return str(details.get("text") or "")
