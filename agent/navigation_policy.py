"""Where this run's browser may navigate (US-042).

The server resolves the policy — instance floor plus the project's allowlist —
and hands it to the child as three env vars. This module turns them into the
three `BrowserProfile` fields browser-use's `SecurityWatchdog` enforces, and
reads a blocked navigation back out of the resulting failure so the run can
report it as a verdict rather than as a crash.

    QA_BLOCK_PRIVATE_NETWORKS  -> block_ip_addresses   (default ON)
    QA_DENIED_HOSTS            -> prohibited_domains   (comma separated)
    QA_ALLOWED_DOMAINS         -> allowed_domains      (JSON array)

Fails CLOSED, which is the opposite of secret_vars' rule and deliberately so: a
broken secret must not half-apply, but a policy that cannot be read must not
resolve to "no policy". An absent QA_BLOCK_PRIVATE_NETWORKS is therefore ON,
and an unparseable QA_ALLOWED_DOMAINS raises rather than returning something.
It cannot fail closed by returning an empty list — browser-use treats an empty
`allowed_domains` as falsy and skips the allowlist check entirely, so `[]` means
"allow everything". There is no in-band value for "allow nothing", which leaves
refusing to start as the only honest answer.

Stdlib only, no run_agent/browser-use imports, so it is unit-testable in
isolation like secret_vars and email_codes.
"""
from __future__ import annotations

import json
import re

# The spellings that turn the floor off, matching the server's parse of the same
# variable. Everything else — including garbage — leaves it on.
_OFF = {"0", "false", "no", "off"}

# SecurityWatchdog raises this out of on_NavigateToUrlEvent when a navigation is
# refused. Anchored on the whole sentence, not on "blocked by security policy"
# alone, so an agent that merely quotes the phrase back at us (a goal about a
# blocked page, an assertion message) never manufactures a fence event.
_BLOCKED = re.compile(r"Navigation to (\S+) blocked by security policy")


def profile_kwargs(environ):
    """The three BrowserProfile fields, always all three.

    A missing key would leave the profile on browser-use's own default, and its
    default for `block_ip_addresses` is False — an agent with no fence and no
    error anywhere to say so.

    Raises ValueError if QA_ALLOWED_DOMAINS is present but unreadable.
    """
    return {
        "block_ip_addresses": _flag_on(environ.get("QA_BLOCK_PRIVATE_NETWORKS")),
        # A list, never a set: browser-use's fast path for a set does exact
        # hostname matching only, so a set would silently stop `*.internal`
        # from matching anything.
        "prohibited_domains": _csv(environ.get("QA_DENIED_HOSTS")),
        "allowed_domains": _allowlist(environ.get("QA_ALLOWED_DOMAINS")),
    }


def failure_reason_for(failure):
    """`navigation_blocked` when `failure` is the fence firing, else None."""
    return "navigation_blocked" if _BLOCKED.search(failure or "") else None


def blocked_url_in(failure):
    """The URL the fence refused, so the step event can name it."""
    match = _BLOCKED.search(failure or "")
    return match.group(1) if match else None


def _flag_on(raw):
    return (raw or "").strip().lower() not in _OFF


def _csv(raw):
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


def _allowlist(raw):
    if not (raw or "").strip():
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError(f"QA_ALLOWED_DOMAINS is not valid JSON: {raw!r}")
    if not isinstance(parsed, list):
        raise ValueError(f"QA_ALLOWED_DOMAINS must be a JSON array, got {type(parsed).__name__}")
    # An empty array is how the server spells "this project set no allowlist";
    # None is the field's own default and the honest way to pass that on.
    if not parsed:
        return None
    entries = [e for e in parsed if isinstance(e, str) and e.strip()]
    if not entries:
        raise ValueError(f"QA_ALLOWED_DOMAINS has no usable entries: {raw!r}")
    return entries
