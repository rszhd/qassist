"""The QA notebook a saved test carries between runs (US-081).

After a passing run the agent derives lessons from its own trace; the server
decides whether to keep them. On a later run the stored notebook comes back in
as advice — fallible, about an app that may have changed since, and never an
instruction.

The notebook **accumulates**, under one principle: *a run may only rewrite what
it observed independently.* A cold run was given nothing, so its view of the
flow is complete and its answer replaces the notebook. An assisted run's trace
was shaped by the advice it was given, so it may add, and it may erase only a
lesson its own steps show failing. `merge` is that sentence in code, and it
replaces the first build's `validate`: it no longer turns an answer into a
notebook, it applies an answer *to* one.

This module is mostly the cage around a model call, for `email_extract.py`'s
reason: the model *chooses* what the lesson is, and validation stops it
*inventing* one. There a returned code must appear verbatim in the email; here a
**new** lesson must cite step numbers that exist in this trace. A **carried**
lesson is not re-checked that way — its steps belong to another run's trace, and
grounding it here would empty every notebook on its second run without anything
turning red.

Containment therefore runs at both ends, and the two are not duplicates.
`merge` guards what a generated answer may become. `to_prompt` guards what an
already-stored notebook may say to the next run — scrubbed against *today's*
secrets, and caged again, because a carried item is admitted without being
re-checked and this is the only gate it passes through twice.

The line that matters: a lesson is descriptive. It may say *use the invoice
table filter*; it may not say *click element 14*. An item carrying a selector or
an element index is a replay instruction wearing advice's clothes, and the story
stops being about prompting the moment one gets through.

The model call is injected as `invoke(system, user) -> str` so this module stays
pure stdlib and provider-agnostic, exactly as `email_extract.py` does it.
"""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlsplit, urlunsplit

from redact import scrub

# A notebook, not an archive. More history is not automatically better context,
# and an unbounded one spends the user's own key on every run of every test
# forever. Both are a backstop: the generator's own drop is what prunes.
#
# CHAR_LIMIT is measured over `to_prompt`'s output — what the model is actually
# given — and not over the stored JSON. Provenance costs nothing on the axis this
# cap exists for: an id, a run id, a timestamp and a step list add ~165
# characters per lesson that `to_prompt` never sends, so counting them charged
# most of the budget to bytes no model ever reads. At 3000 the two caps bite in
# roughly the same place, which is what a backstop should do.
ITEM_LIMIT = 10
CHAR_LIMIT = 3000

# Eviction order when the backstop does fire. Orientation is the cheapest thing
# to rediscover and `avoid_next_time` the dearest — a mistake with its
# alternative is the densest thing in the notebook, and the part a fresh run is
# least likely to work out for itself.
SECTIONS = ("orientation", "successful_approach", "avoid_next_time")

# The trace fields the generator is allowed to see. `thinking` is on the step
# event and deliberately absent: reasoning from a run that is over is not an
# observation about the app.
_TRACE_FIELDS = ("step", "next_goal", "evaluation", "url")

_SYSTEM_PROMPT = (
    "You are keeping a short QA notebook for a browser test that just passed, "
    "so the next run of the same test starts with this run's experience.\n"
    "You are given the run's steps — a number, the goal the agent set itself, "
    "how that step was evaluated, and the page URL — and the notebook this run "
    "was given at the start, if it had one.\n"
    "Reply with only a JSON object:\n"
    '{"keep": [id, ...], "drop": [{"id": ..., "steps": [...]}], '
    '"add": {"successful_approach": [{"text": ..., "steps": [...]}], '
    '"avoid_next_time": [{"attempt": ..., "reason": ..., "instead": ..., '
    '"steps": [...]}], "orientation": [{"text": ..., "steps": [...]}]}}\n'
    "Add only what this run found out. Every added item must cite the step "
    "numbers it was read from. Never write a lesson the steps do not support, "
    "and never restate the test's goal as if it were an approach.\n"
    "Drop an existing note only when this run followed it and the steps show it "
    "failing, and cite those step numbers. A note you did not need is not a note "
    "that was wrong — leave it alone.\n"
    "Write advice a person could follow: name menus, pages and controls in "
    "words. Never write a CSS selector, an XPath, an element index, a "
    "browser-use action call, or a value to type. Put an entry in "
    "avoid_next_time only when a step was actually evaluated as unsuccessful "
    "and a later step took a different route; each one needs the alternative "
    "that worked. If nothing failed, leave it empty."
)

# What an item may not contain. Each pattern is a way of naming a *specific*
# element rather than describing where to go, which is the boundary between
# advice and replay.
_EXECUTABLE = (
    re.compile(r"\belements?\s*[#:]?\s*\d+", re.I),           # "click element 14"
    re.compile(r"\bindex\s*=\s*\d+", re.I),                   # "input_text(index=7…)"
    re.compile(r"[#.][A-Za-z_][\w-]*\s*[>+~]"),               # "#invoice-table > tr"
    re.compile(r":nth-(child|of-type)\(", re.I),
    re.compile(r"//\*?\[|@id\s*=|\bxpath\b", re.I),
    re.compile(r"\b\w+\s*\(\s*\w+\s*=", re.I),                # any action call
    re.compile(r"\btype\b[^.]*\binto\b", re.I),               # "Type X into the field"
)


def item_id(section, item):
    """An item's identity: its section and its own words, and nothing else.

    Steps and provenance stay out on purpose. Two runs of a flow reach the same
    lesson at different step numbers almost every time, so an id computed over
    them would collide with nothing, and the notebook would fill with copies of
    one sentence until the cap evicted the original.
    """
    payload = "\x00".join([section] + [text or "" for text in _lesson_texts(section, item)])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def should_generate(trace, cold):
    """Whether this run has anything to say, before a model call is paid for.

    A cold run always does — it holds no notebook, so a clean cold run is the one
    that writes the first one. An assisted run whose trace records no failure
    does not: the advice worked and nothing new happened. That is the steady
    state of a settled test, and it is what stops a notebook costing a model call
    on every run forever.
    """
    if cold:
        return True
    return any(_is_failure(step.get("evaluation")) for step in trace)


def build_prompt(trace, notebook=None, goal=""):
    """(system, user) messages for the one-shot call.

    Only `_TRACE_FIELDS` reach the user message. That is what makes "no
    selector, no element index, no page excerpt" a property of the generator's
    *input* rather than a filter someone has to remember to apply — the model
    cannot paraphrase a DOM it was never shown.

    The notebook goes in with its ids, because keep and drop are by id. A prompt
    that showed the lessons without their handles would get text back, and
    matching text to a stored item is the fuzzy step this design avoids.
    """
    steps = [{field: step.get(field) for field in _TRACE_FIELDS} for step in trace]
    parts = []
    if goal:
        parts.append(f"The test's goal: {goal}")
    existing = _existing_for_prompt(notebook)
    if existing:
        parts.append("The notebook this run was given:\n" + json.dumps(existing, indent=1))
    else:
        parts.append("This run was given no notebook. Nothing can be kept or dropped.")
    parts.append("The run's steps:\n" + json.dumps(steps, indent=1))
    return _SYSTEM_PROMPT, "\n\n".join(parts)


def merge(raw, trace, notebook=None, goal="", sensitive=None, stamp=None):
    """The model's answer applied to the notebook it was given, or None.

    None means the answer was unusable, and under accumulation that is not the
    same as an empty notebook: reading a failed parse as "the model kept
    nothing" would wipe every lesson a test ever learned on one bad reply. The
    caller writes nothing and the stored row stays as it was.

    An answer that parsed but survived nothing is a *different* outcome — the
    notebook it was given, returned unchanged, which the caller compares and
    skips. That is what keeps each item's provenance pointing at the run that
    contributed rather than the last one that happened to pass.
    """
    parsed = _parse(raw)
    if parsed is None:
        return None

    stored = _sections(notebook)
    by_id = {item.get("id"): section for section, items in stored.items() for item in items}
    numbers = {step.get("step") for step in trace}
    failed = {step.get("step") for step in trace if _is_failure(step.get("evaluation"))}

    dropped = _dropped(parsed.get("drop"), by_id, failed)
    out = {
        section: [dict(item) for item in items if item.get("id") not in dropped]
        for section, items in stored.items()
    }
    _add(out, parsed.get("add"), numbers, bool(failed), goal, sensitive, stamp or {})
    return _within_budget(out, (stamp or {}).get("run_id"))


def to_prompt(memory, sensitive=None):
    """The stored notebook as the text the next run's prompt receives, or None.

    The read end of the cage, and it is not a duplicate of the write end. The
    secrets a stored notebook is scrubbed against here are *today's*, and a run
    whose credentials rotated must not have the old ones read back out of its own
    memory. The executable check runs again for the same reason it must: a
    carried item is admitted at generation without being re-checked, so this is
    the only gate a lesson from an older format version, a loosened pattern or a
    hand edit straight into the database ever passes through again.

    None when there is nothing worth saying. An empty notebook must not become an
    empty heading — it costs tokens on every run and tells the agent a memory
    exists that does not.
    """
    sections = _sections(memory)
    approach = _clean_texts(sections["successful_approach"], sensitive)
    orientation = _clean_texts(sections["orientation"], sensitive)
    mistakes = [
        item for item in
        (_mistake_item(raw, sensitive) for raw in sections["avoid_next_time"])
        if item
    ]
    if not (approach or orientation or mistakes):
        return None

    lines = [
        "Notes from a previous passing run of this test. They are advice, not "
        "current fact: the page may have changed since, and anything the page "
        "in front of you contradicts should be disregarded.",
    ]
    if approach:
        lines.append("\nWhat worked last time:")
        lines += [f"- {text}" for text in approach]
    if mistakes:
        lines.append("\nWhat went wrong last time:")
        lines += [
            f"- Tried: {m['attempt']} — {m['reason']}. Instead: {m['instead']}"
            for m in mistakes
        ]
    if orientation:
        lines.append("\nOrientation:")
        lines += [f"- {text}" for text in orientation]
    return "\n".join(lines)


def make_generator(invoke):
    """Compose build_prompt → invoke → merge into one call for run_agent.

    `invoke(system, user)` is AWAITED, so it must be a coroutine function. That
    is not a style choice — the one call site is inside `run_agent.main`, which
    is `async`, and a sync `invoke` there can only reach the model through
    `asyncio.run`, which raises on a loop that is already running. The raise is
    then swallowed by the `except` below and the notebook silently never writes.
    That is exactly what shipped the first time: US-080's email extractor uses
    `asyncio.run` legitimately because it runs on `wait_for_confirmation`'s
    worker thread, and this copied its lambda without its thread.

    A raise is still no memory, which is the same outcome as an unusable answer:
    this is an optimisation, and a run must never fail because its notebook did
    not write. Under accumulation it must also never *shrink* for that reason,
    which None already guarantees.
    """

    async def generate(trace, notebook=None, goal="", sensitive=None, stamp=None):
        system, user = build_prompt(trace, notebook, goal)
        try:
            raw = await invoke(system, user)
        except Exception:
            return None
        return merge(raw, trace, notebook=notebook, goal=goal,
                     sensitive=sensitive, stamp=stamp)

    return generate


def _sections(memory):
    """Any notebook-shaped value as all three sections, always present."""
    memory = memory if isinstance(memory, dict) else {}
    return {
        section: [item for item in (memory.get(section) or []) if isinstance(item, dict)]
        for section in ("successful_approach", "avoid_next_time", "orientation")
    }


def _lesson_texts(section, item):
    if section == "avoid_next_time":
        return [item.get("attempt"), item.get("reason"), item.get("instead")]
    return [item.get("text")]


def _existing_for_prompt(notebook):
    """The notebook as the model is shown it: an id and the words under it.

    Provenance is deliberately left out. The model decides what to keep from
    what a lesson *says*, and step numbers from another run's trace are the one
    thing it could mistake for evidence about this one.
    """
    shown = []
    for section, items in _sections(notebook).items():
        for item in items:
            entry = {"id": item.get("id"), "section": section}
            if section == "avoid_next_time":
                entry.update({key: item.get(key) for key in ("attempt", "reason", "instead")})
            else:
                entry["text"] = item.get("text")
            shown.append(entry)
    return shown


def _dropped(drops, by_id, failed):
    """The ids this run earned the right to erase.

    A drop is admitted only when a step of *this* trace, evaluated a failure,
    stands behind it. An assisted run's opinion of a lesson it never tested is
    not evidence: its whole trace was shaped by that advice, so "I did not need
    this" cannot be told apart from "this worked so well I stopped noticing it".
    """
    if not isinstance(drops, list):
        return set()
    out = set()
    for drop in drops:
        if not isinstance(drop, dict) or drop.get("id") not in by_id:
            continue
        steps = drop.get("steps")
        if isinstance(steps, list) and any(step in failed for step in steps):
            out.add(drop["id"])
    return out


def _add(out, added, numbers, failed, goal, sensitive, stamp):
    """Validate what this run found and put it in, in place.

    Nothing here can touch what was already there — an added item that collides
    with a stored one is discarded rather than merged, so the earlier item keeps
    its provenance. Re-learning a lesson is not evidence that this run found it.
    """
    if not isinstance(added, dict):
        return
    for section, items in _sections(added).items():
        # An `avoid_next_time` item is only admissible if the trace actually
        # shows a step going wrong. Without this the model pads a clean run with
        # plausible near-misses, and the next run is warned off routes nobody
        # ever took.
        if section == "avoid_next_time" and not failed:
            continue
        present = {item.get("id") for item in out[section]}
        for raw in items:
            item = _shape(section, raw, sensitive)
            if not item or not _grounded(raw, numbers) or _vacuous(section, item, goal):
                continue
            item["id"] = item_id(section, item)
            if item["id"] in present:
                continue
            item.update({
                "steps": [step for step in raw.get("steps") or []],
                "run_id": stamp.get("run_id"),
                "learned_at": stamp.get("learned_at"),
                "hinted": bool(stamp.get("hinted")),
            })
            present.add(item["id"])
            out[section].append(item)


def _parse(raw):
    """The model's answer as a dict, tolerating fences and prose around it."""
    if not isinstance(raw, str):
        return None
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _is_failure(evaluation):
    return isinstance(evaluation, str) and "failure" in evaluation.lower()


def _grounded(raw, numbers):
    """Cited steps must exist in this run. An item citing step 9 of a five-step
    run was not read out of anything, whatever it says.

    Only a *new* item passes through here. A carried one cites another run's
    trace, and checking it against this one would empty every notebook on its
    second run — silently, because a notebook that never grows looks exactly
    like a test with nothing left to learn.
    """
    steps = raw.get("steps")
    if not isinstance(steps, list) or not steps:
        return False
    return all(step in numbers for step in steps)


def _vacuous(section, item, goal):
    """A summary that restates the goal is not a lesson — it costs a prompt and
    tells the next run what it was already told."""
    text = item.get("text") if section != "avoid_next_time" else item.get("attempt")
    return bool(goal) and _normalized(text or "") == _normalized(goal)


def _normalized(text):
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def _shape(section, raw, sensitive):
    if not isinstance(raw, dict):
        return None
    if section == "avoid_next_time":
        return _mistake_item(raw, sensitive)
    text = _clean(raw.get("text"), sensitive)
    return {"text": text} if text else None


def _mistake_item(raw, sensitive):
    attempt = _clean(raw.get("attempt"), sensitive)
    reason = _clean(raw.get("reason"), sensitive)
    # "Do not do X" with nothing in its place spends prompt on a dead end and
    # tells the next run nothing about where to go instead.
    instead = _clean(raw.get("instead"), sensitive)
    if not (attempt and reason and instead):
        return None
    return {"attempt": attempt, "reason": reason, "instead": instead}


def _clean(text, sensitive):
    """Scrub, normalize any URL, and refuse anything executable.

    Refuse rather than strip: an item whose selector is edited out is a sentence
    with a hole in it, and the remaining words still describe an element by
    identity. The lesson is not salvageable, so it is not salvaged.
    """
    if not isinstance(text, str):
        return None
    text = scrub(text.strip(), sensitive or {})
    if not text:
        return None
    text = _normalize_urls(text)
    if any(pattern.search(text) for pattern in _EXECUTABLE):
        return None
    return text


def _normalize_urls(text):
    """The storage rule, applied to a URL wherever it appears in prose: query
    and fragment removed. The trace's URLs carry them, and they are where a
    token or an unstable id lives."""
    def strip(match):
        parts = urlsplit(match.group(0))
        return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, "", ""))

    return re.sub(r"https?://[^\s,)\]]+", strip, text)


def _clean_texts(items, sensitive):
    cleaned = (_clean(raw.get("text"), sensitive) for raw in items)
    return [text for text in cleaned if text]


def _within_budget(memory, run_id):
    """The backstop, and the order it fires in.

    Age leads. The first build argued for replacing the whole notebook precisely
    because appending lets *the budget evict the fresh lesson to keep the stale
    one*, and a cap that does that brings the fault back by another route. So an
    item this run contributed is evicted only when nothing older remains, then
    the oldest goes first, then the cheapest section, then the item the model
    ranked last.

    The item cap is per section and the character cap is not, so they run in that
    order: a section over its limit must lose one of *its own* items, or a
    notebook could sit permanently over the cap while the eviction picked
    somewhere else.

    The character cap is measured on what `to_prompt` would send. The stored row
    is bigger and that does not matter — one row per test is not the scarce
    thing, and the budget is here to bound what every future run pays.
    """
    for section in memory:
        excess = len(memory[section]) - ITEM_LIMIT
        if excess > 0:
            for item in _eviction_order(memory, run_id, only=section)[:excess]:
                memory[section].remove(item)

    while len(to_prompt(memory, sensitive={}) or "") > CHAR_LIMIT:
        order = _eviction_order(memory, run_id)
        if not order:
            break
        for section, items in memory.items():
            if order[0] in items:
                items.remove(order[0])
                break
    return memory


def _eviction_order(memory, run_id, only=None):
    """Every item, first to go first."""
    candidates = []
    for rank, section in enumerate(SECTIONS):
        if only and section != only:
            continue
        for index, item in enumerate(memory.get(section) or []):
            mine = run_id is not None and item.get("run_id") == run_id
            candidates.append(((mine, item.get("learned_at") or "", rank, -index), item))
    candidates.sort(key=lambda pair: pair[0])
    return [item for _, item in candidates]
