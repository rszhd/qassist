"""Per-run secret variables from the QA_VARS env (US-035).

Secret variables never reach QA_GOAL — the server routes their real values here
as a JSON `{name: value}` env, and substitutes a `<secret>name</secret>`
placeholder into the goal instead. `load` parses QA_VARS into the same
`sensitive` dict browser-use already uses for US-034, so the browser substitutes
the value at type-time and `redact.scrub` strips it from every emitted event.

Fails closed: a missing, empty, malformed, or non-object QA_VARS yields `{}`
rather than raising — a broken env must never take the run down or half-apply a
secret. Empty and non-string values are dropped (an empty value in `sensitive`
would make scrub redact nothing useful — see test_redact).

Stdlib only, no run_agent/browser-use imports, so it is unit-testable in
isolation like email_codes.
"""
from __future__ import annotations

import json


def load(environ):
    """Parse QA_VARS into a `{name: value}` dict of non-empty string secrets."""
    raw = environ.get("QA_VARS", "")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        name: value
        for name, value in parsed.items()
        if isinstance(name, str) and isinstance(value, str) and value
    }
