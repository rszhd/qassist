"""Files this run may attach, from the QA_FIXTURES env (US-048).

The server resolves a run's project fixtures — reading the project's fixture
directory, which is the only thing that decides what may be attached — and hands
the absolute paths to the child as a JSON array. `load` turns that into the list
passed to `Agent(available_file_paths=…)`.

browser-use gates `upload_file` on exact membership of that list, and gates
`read_file`'s external reads on the same list. So this is a security boundary,
not a convenience: an entry nobody meant to put there is a file the agent can be
argued into reading back into its own context.

Fails CLOSED by returning `[]`, which is the same rule as secret_vars and the
OPPOSITE of navigation_policy — and the difference is worth holding on to,
because the two modules look alike and behave differently on purpose:

  * navigation_policy cannot fail closed by returning an empty list. browser-use
    treats an empty `allowed_domains` as falsy and skips the allowlist check
    entirely, so `[]` there means "allow everything" and the only honest answer
    to an unreadable policy is to refuse to start.
  * here `[]` genuinely IS "allow nothing": the membership test is `path not in
    list`, which no path passes against an empty one.

So an unreadable QA_FIXTURES resolves to `[]` and the run proceeds. The agent is
then merely unable to attach anything — a flow that does not work, rather than a
boundary that is not there. Raising would take a run down over a feature most
runs never touch.

Stdlib only, no run_agent/browser-use imports, so it is unit-testable in
isolation like secret_vars, navigation_policy and email_codes.
"""
from __future__ import annotations

import json
import os


def load(environ):
    """The absolute paths of files this run may attach. `[]` when unreadable."""
    raw = environ.get("QA_FIXTURES", "")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []

    paths = []
    seen = set()
    for entry in parsed:
        if not isinstance(entry, str) or not entry.strip():
            continue
        # Relative entries are dropped rather than resolved. browser-use compares
        # the agent's requested path to this list as an exact string, so a
        # relative entry could never match the file it was meant to permit — and
        # resolving one here would resolve it against the agent's working
        # directory, which is not where fixtures live.
        if not os.path.isabs(entry):
            continue
        # A path that is not a readable file is dropped: the whitelist must never
        # advertise something the agent cannot open. A directory in particular
        # permits nothing (membership is exact, so no child of it matches) while
        # still inviting `read_file` to try, and an entry that can only ever fail
        # has no business on a security list.
        if not os.path.isfile(entry):
            continue
        if entry in seen:
            continue
        seen.add(entry)
        paths.append(entry)
    return paths


def task_note(paths):
    """The sentence appended to the task naming what may be attached.

    browser-use already injects the raw paths into the prompt as
    `<available_file_paths>`, but that block is absolute paths and nothing else —
    so a goal that says "upload my CV" leaves the model to guess which path under
    a uuid-named directory is a CV. This pairs each filename with its path and
    does no more than that. US-048: "Deliberately keep this dumb — no templating,
    no generation."

    Empty for no fixtures: a run that is not using the feature must not pay for
    extra instructions about it.
    """
    if not paths:
        return ""
    listed = "\n".join(f"- {os.path.basename(p)}: {p}" for p in paths)
    return (
        "\n\nFiles available to attach, if the goal calls for uploading one "
        "(use the upload_file action with the exact path):\n" + listed
    )
