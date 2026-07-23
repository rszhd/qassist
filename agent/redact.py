"""Secret redaction for emitted events (US-034).

`<secret>name</secret>` substitution keeps real values away from the LLM, but
secrets still reach emitted events through side channels it doesn't cover — the
clearest being that after navigating to a fetched confirmation link the browser
URL *is* the secret. `scrub` removes known secret values from any text we emit.

Kept dependency-free (stdlib only, and it uses none) so it is importable and
unit-testable without run_agent's browser-use / Playwright imports.
"""
from __future__ import annotations


def scrub(text, sensitive):
    """Replace each secret value in `sensitive` with `<redacted:name>`.

    `text` is passed through unchanged when it isn't a string, when there are
    no secrets, or when no secret value appears in it.
    """
    if not isinstance(text, str) or not sensitive:
        return text
    for name, value in sensitive.items():
        if value and value in text:
            text = text.replace(value, f"<redacted:{name}>")
    return text
