"""The saved session this run starts with, from the environment (US-043).

The server decrypts a project's stored `storageState`, writes it to a file in a
directory of this run's own, and hands us the path. This module turns that into
the `BrowserProfile` fields browser-use actually loads, assembles the
deterministic preamble that runs before the first LLM step, and decides whether
the session we were given still authenticates anybody.

    QA_STORAGE_STATE      -> BrowserProfile(storage_state=<path>)
    QA_INITIAL_ACTIONS    -> Agent(initial_actions=[…])
    QA_SESSION_VERIFY     -> the pre-LLM "are we still signed in" check
    QA_STORAGE_STATE_OUT  -> where a login run exports what it captured

A PATH, NOT A DICT, and that is the whole reason this module has an opinion.
`BrowserProfile.storage_state` is typed `str | Path | dict`, so passing the
parsed dict looks supported and reads as the tidier option. In this version of
browser-use it silently loads NOTHING: the `load_storage_state_from_file`
validator is commented out (browser/profile.py:519-529) and
`StorageStateWatchdog._load_storage_state` gates on
`os.path.exists(str(load_path))` (watchdogs/storage_state_watchdog.py:236),
which a stringified dict never satisfies. There is no error and no warning — the
browser opens cold, the agent walks into the login page, and the run fails
exactly the way an EXPIRED session fails, which is the other thing this story
exists to be able to tell apart.

Fails CLOSED in fixtures.py's direction and NOT navigation_policy's, and the
difference matters because the three modules look alike:

  * navigation_policy cannot fail closed by returning an empty list, because
    browser-use reads an empty `allowed_domains` as falsy and skips the check —
    so an unreadable policy has to refuse to start.
  * here, and in fixtures.py, "nothing" is a real value: no session means an
    unauthenticated run, and no preamble means the run every project has today.
    An unreadable value resolves to nothing and the run proceeds, unauthenticated
    — a flow that does not work rather than a boundary that is not there.

Stdlib only, no run_agent/browser-use imports, so it is unit-testable in
isolation like secret_vars, fixtures and navigation_policy.
"""
from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

# The deterministic actions a preamble may contain. The server validates this at
# write time; this is the second gate, on a value that may have been written by
# an older version. Everything index-based (`click`, `input`) is incoherent
# before any DOM has been observed, and `upload_file`/`read_file` are US-048's
# boundary — a per-project setting must not be a second door to it.
ALLOWED_ACTIONS = ("navigate", "wait", "send_keys", "scroll")

# A preamble is per-project config that fires before every run in the project,
# so it is bounded here as well as at the door.
MAX_ACTIONS = 12


def profile_kwargs(environ):
    """The BrowserProfile fields for this run's session, or `{}` for none.

    `{}` rather than `storage_state=None`: the two mean the same thing to
    browser-use, but not mentioning the field is the one spelling that changes
    nothing at all about a run with no session.
    """
    path = (environ.get("QA_STORAGE_STATE") or "").strip()
    if not path:
        return {}
    # A path that is not there is not a session. Worse than useless, in fact:
    # StorageStateWatchdog would CREATE that file on its first auto-save, so a
    # missing path turns the server's teardown target into a file nobody is
    # tracking, holding the cookies of whatever the run did log into.
    if not os.path.isfile(path):
        return {}
    return {
        "storage_state": path,
        # browser-use warns that the two conflict and that storage_state
        # "forcibly overwrites" (browser/profile.py:770-780). Our browsers are
        # ephemeral and have no profile worth keeping, so this is only ever a
        # footgun — pinned off rather than left to a default that may move.
        "user_data_dir": None,
    }


def export_path(environ):
    """Where a login run writes the state it captured, or None."""
    return (environ.get("QA_STORAGE_STATE_OUT") or "").strip() or None


def initial_actions(environ, start_url):
    """The preamble, or None when this project has none (AC #5).

    Leads with the navigation to `start_url`, and it has to: browser-use only
    extracts the URL from the task and navigates to it when NO initial_actions
    were supplied (agent/service.py:459-463). Supplying our own takes that over,
    so a preamble that forgot to navigate would fire its Escape keypress at
    about:blank and hand the LLM a blank tab.

    None — not `[{navigate: …}]` — when there is no preamble, so a project
    without one is byte-for-byte the pre-US-043 run.
    """
    raw = (environ.get("QA_INITIAL_ACTIONS") or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, list):
        return None

    actions = []
    for entry in parsed[:MAX_ACTIONS]:
        if not isinstance(entry, dict) or len(entry) != 1:
            continue
        name = next(iter(entry))
        if name not in ALLOWED_ACTIONS:
            continue
        if not isinstance(entry[name], dict):
            continue
        actions.append(entry)
    if not actions:
        return None
    return [{"navigate": {"url": start_url, "new_tab": False}}] + actions


def verify_config(environ):
    """How to tell "still signed in" from "looking at a login page", or None.

    None is legitimate and common: a pasted blob for an SSO app may have no
    stable landing URL to assert on, and a session with nothing configured
    simply behaves the way a run does today.
    """
    raw = (environ.get("QA_SESSION_VERIFY") or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    url_contains = parsed.get("url_contains") or None
    text = parsed.get("text") or None
    if not url_contains and not text:
        return None
    return {"url_contains": url_contains, "text": text}


# The Playwright storageState fields, and only these. Raw CDP cookies carry
# `size`, `session`, `priority`, `sourceScheme` and more, which nothing on the
# load path wants and which would ride into our encrypted column forever.
_COOKIE_FIELDS = ("name", "value", "domain", "path")


def to_storage_state(raw):
    """A raw CDP storage state, narrowed to the Playwright shape we store.

    Kept here, pure, because the interesting half is a dict transformation and
    the alternative is asserting it through a live browser.

    Cookies are mapped rather than passed through: `export_storage_state` does
    the same narrowing (browser/session.py:1442-1455) and it is the shape
    `Network.setCookies` is fed on the way back in. Origins pass through — they
    already arrive as `{origin, localStorage: [{name, value}]}`.
    """
    if not isinstance(raw, dict):
        return {"cookies": [], "origins": []}
    cookies = []
    for c in raw.get("cookies") or []:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        cookie = {k: c.get(k) for k in _COOKIE_FIELDS}
        cookie["expires"] = c.get("expires", -1)
        cookie["httpOnly"] = c.get("httpOnly", False)
        cookie["secure"] = c.get("secure", False)
        # Chromium omits sameSite for cookies set without the attribute; the
        # loader expects the key to exist, and 'Lax' is what the browser itself
        # applies in that case.
        cookie["sameSite"] = c.get("sameSite") or "Lax"
        cookies.append(cookie)
    origins = [
        o for o in (raw.get("origins") or [])
        if isinstance(o, dict) and isinstance(o.get("origin"), str)
    ]
    return {"cookies": cookies, "origins": origins}


def expiry_reason(check, url, page_text):
    """Why this session looks dead, or None when it looks alive (AC #4).

    Checked before the first LLM step, so an expired session costs a verdict
    rather than a wandering twenty-step failure whose report blames the goal.

    Both conditions must hold when both are configured, not either: an app that
    redirects to the right URL and then renders a login modal over it is not a
    signed-in session.
    """
    if not check:
        return None

    wanted_url = check.get("url_contains")
    if wanted_url and not _path_contains(url, wanted_url):
        return (
            "the saved session is no longer signed in — the browser was sent to "
            f"{url or 'nowhere'} instead of a page matching {wanted_url!r}. Refresh the session."
        )

    wanted_text = check.get("text")
    if wanted_text:
        # `None` means the page could not be read, which is not the same as the
        # text being absent. Reporting expiry off a failed read would stamp
        # `session_expired` on runs whose session was fine, and the reason stops
        # meaning anything the moment it is ever wrong.
        if page_text is None:
            return None
        if wanted_text not in page_text:
            return (
                "the saved session is no longer signed in — the page does not show "
                f"{wanted_text!r}. Refresh the session."
            )
    return None


def _path_contains(url, needle):
    """Whether the landing URL's PATH contains `needle`.

    The path, deliberately, and not the whole URL. `/login?next=/dashboard` is
    the single most common shape of a login redirect, and it contains
    "/dashboard" — so a naive substring test over the whole URL reports a dead
    session as live, and every run in the project goes back to failing for the
    wrong reason. That is the exact bug this feature was built to remove, and
    it would be reintroduced by the check meant to detect it.
    """
    if not url:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    # Host included, so a `verify_url_contains` of "app.example.com" works for
    # an app that identifies itself by subdomain rather than by path.
    return needle in (parts.netloc + parts.path)
