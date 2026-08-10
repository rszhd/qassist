"""US-081 — written before the second `agent/run_memory.py` exists, and the
implementation written against it (`CLAUDE.md` → Workflow rules).

The generator is a cage around a model call, for `email_extract.py`'s reason:
the model *chooses* what the lesson is, and validation stops it inventing one.
There a returned code must appear verbatim in the email; here a **new** lesson
must cite step numbers that exist in this trace.

What is new in the second build is that the notebook **accumulates**. The
generator is handed the notebook it was given at the start of the run and
returns keep / add / drop against it, under one principle:

    a run may only rewrite what it observed independently.

A cold run was given no notebook, so its answer is the whole truth and replaces
what was there. An assisted run's trace was shaped by the advice it was given,
so it may add, and it may erase only a lesson its own steps show failing. Three
things follow, and they are the assertions this file exists for:

  * **omission is keep.** An item the model mentions in neither list survives.
    Silence must never erase; that is the first build's fault in its purest
    form — a run sailed through on good advice, wrote a clean trace, and the
    rewrite dropped the lesson that made the trace clean.
  * **keep is by id, and the text comes from storage.** The model's words for a
    kept item are discarded. Otherwise `keep` is a way to write a new lesson
    while wearing an old lesson's provenance.
  * **a carried item is not re-grounded.** Its steps belong to another run's
    trace. Checking them here would empty every notebook on its second run, and
    nothing would be red — the notebook would simply never grow.

Containment runs at both ends and the two are not duplicates. `merge` guards
what a generated answer may become; `to_prompt` guards what an already-stored
notebook may say to the next run, against *today's* secrets. A carried item is
caged at the second end precisely because it is not caged at the first — it is
a row that outlived the `merge` that admitted it.

The line that decides all of it: a lesson is descriptive. It may say *use the
invoice table filter*; it may not say *click element 14*. An item carrying a
selector or an element index is a replay instruction wearing advice's clothes,
and the story stops being about prompting the moment one gets through.
"""
import asyncio
import json

import pytest

from run_memory import (
    ITEM_LIMIT,
    CHAR_LIMIT,
    build_prompt,
    item_id,
    make_generator,
    merge,
    should_generate,
    to_prompt,
)

TRACE = [
    {"step": 1, "next_goal": "Find the March invoice", "evaluation": None,
     "url": "https://app.example.com/"},
    {"step": 2, "next_goal": "Search for the invoice number", "evaluation": "Success",
     "url": "https://app.example.com/search?q=INV-3312"},
    {"step": 3, "next_goal": "Read the results",
     "evaluation": "Failure - the results are help articles, not billing records",
     "url": "https://app.example.com/search?q=INV-3312"},
    {"step": 4, "next_goal": "Open Billing from the account menu", "evaluation": "Success",
     "url": "https://app.example.com/account/billing"},
    {"step": 5, "next_goal": "Open the invoice row and read the payment status",
     "evaluation": "Success", "url": "https://app.example.com/account/billing"},
]

CLEAN_TRACE = [step for step in TRACE if "Failure" not in (step["evaluation"] or "")]

# Stamped onto whatever this run adds. Injected rather than read from a clock,
# so provenance is asserted rather than approximated.
STAMP = {"run_id": "run-2", "learned_at": "2026-08-10T09:00:00Z", "hinted": False}


def approach(text, steps, **extra):
    item = {"text": text, "steps": list(steps), **extra}
    return {"id": item_id("successful_approach", item), **item}


def orientation(text, steps, **extra):
    item = {"text": text, "steps": list(steps), **extra}
    return {"id": item_id("orientation", item), **item}


def mistake(attempt, reason, instead, steps, **extra):
    item = {"attempt": attempt, "reason": reason, "instead": instead,
            "steps": list(steps), **extra}
    return {"id": item_id("avoid_next_time", item), **item}


def notebook(successful_approach=(), avoid_next_time=(), orientation=()):
    return {
        "successful_approach": list(successful_approach),
        "avoid_next_time": list(avoid_next_time),
        "orientation": list(orientation),
    }


def answer(keep=(), drop=(), **add):
    """The model's reply, in the shape `merge` takes."""
    return json.dumps({"keep": list(keep), "drop": list(drop), "add": add})


# A notebook an earlier run left behind. `learned_at` is older than STAMP's, so
# every ordering assertion below has a real oldest item to point at.
BILLING = approach("Open Billing from the account menu, not the workspace sidebar",
                   [4], run_id="run-1", learned_at="2026-08-01T09:00:00Z", hinted=False)
CALENDAR = approach("Set the billing period with the calendar icon before opening an invoice",
                    [2], run_id="run-1", learned_at="2026-08-01T09:00:00Z", hinted=True)
STORED = notebook(successful_approach=[BILLING, CALENDAR])


# --- accumulation: what an assisted run may do to what it was given ----------

def test_a_lesson_the_answer_does_not_mention_survives():
    # The first build's fault, in its purest form. Run 1 hits an edge case and
    # learns *set the billing period first*. Run 2 is given that, sails through,
    # and never mentions it — there was nothing to report, the advice worked.
    # An answer that only adds must not be read as an answer that dropped the
    # rest: silence is the steady state of a settled test, not a retraction.
    out = merge(answer(successful_approach=[
        {"text": "Open the invoice row and read the status in its detail panel", "steps": [5]},
    ]), TRACE, notebook=STORED, stamp=STAMP)
    kept = [item["text"] for item in out["successful_approach"]]
    assert BILLING["text"] in kept
    assert CALENDAR["text"] in kept


def test_a_carried_item_keeps_the_run_that_taught_it():
    # `learned_at` and the source run name the run that *contributed*, not the
    # last one that happened to pass. A notebook whose provenance is restamped
    # on every pass cannot answer the only question the panel is asked: which
    # run should I go and read.
    out = merge(answer(keep=[BILLING["id"]]), TRACE, notebook=STORED, stamp=STAMP)
    carried = next(i for i in out["successful_approach"] if i["id"] == BILLING["id"])
    assert carried["run_id"] == "run-1"
    assert carried["learned_at"] == "2026-08-01T09:00:00Z"


def test_a_carried_item_is_not_re_grounded_against_this_run():
    # BILLING cites step 4 of *run 1*. That its number also exists here is a
    # coincidence of two five-step runs, so the assertion uses a trace where it
    # cannot be: grounding a carried item against the current trace would empty
    # every notebook on its second run, and nothing would be red — the notebook
    # would simply never grow past one run.
    short = TRACE[:2]
    out = merge(answer(keep=[BILLING["id"]]), short, notebook=STORED, stamp=STAMP)
    assert [i["id"] for i in out["successful_approach"]] == [BILLING["id"], CALENDAR["id"]]


def test_keep_takes_the_stored_text_and_not_the_models():
    # Otherwise `keep` is a way to write a new lesson wearing an old lesson's
    # provenance: stamped with a run that never said it. The rewrite here is
    # deliberately plausible and deliberately contradicts the lesson it claims
    # to be — that is the shape this rule refuses, and an executable rewrite
    # would be refused by the cage anyway, for a different reason.
    out = merge(answer(keep=[BILLING["id"]], successful_approach=[
        {"id": BILLING["id"], "text": "Open Billing from the workspace sidebar", "steps": [4]},
    ]), TRACE, notebook=STORED, stamp=STAMP)
    carried = next(i for i in out["successful_approach"] if i["id"] == BILLING["id"])
    assert carried["text"] == BILLING["text"]
    assert carried["run_id"] == "run-1"


def test_keep_is_not_a_way_past_the_cage():
    # The same move with an executable rewrite. It is refused as an *add*, and
    # the id it borrowed still resolves to what is stored.
    out = merge(answer(keep=[BILLING["id"]], successful_approach=[
        {"id": BILLING["id"], "text": "Click element 14 to open Billing", "steps": [4]},
    ]), TRACE, notebook=STORED, stamp=STAMP)
    assert [i["text"] for i in out["successful_approach"]] == [BILLING["text"], CALENDAR["text"]]


def test_keeping_an_id_that_is_not_in_the_notebook_conjures_nothing():
    out = merge(answer(keep=["not-an-id"]), TRACE, notebook=STORED, stamp=STAMP)
    assert [i["id"] for i in out["successful_approach"]] == [BILLING["id"], CALENDAR["id"]]


def test_an_added_item_is_stamped_with_this_run():
    out = merge(answer(successful_approach=[
        {"text": "Open the invoice row and read the status in its detail panel", "steps": [5]},
    ]), TRACE, notebook=STORED, stamp=STAMP)
    added = next(i for i in out["successful_approach"] if i["run_id"] == "run-2")
    assert added["learned_at"] == "2026-08-10T09:00:00Z"
    assert added["steps"] == [5]


def test_a_hint_is_credited_to_the_person_and_not_the_agent():
    # A hinted pass teaches — a hint is evidence from outside, not the system's
    # own advice coming back round. What it owes is honest provenance: the panel
    # must not report a discovery somebody handed it.
    out = merge(answer(successful_approach=[
        {"text": "Open the invoice row and read the status in its detail panel", "steps": [5]},
    ]), TRACE, notebook=STORED, stamp={**STAMP, "hinted": True})
    added = next(i for i in out["successful_approach"] if i["run_id"] == "run-2")
    assert added["hinted"] is True


def test_adding_a_lesson_the_notebook_already_holds_does_not_duplicate_it():
    # Identity is the item's own words and nothing else, so a re-learned lesson
    # collides with the one already there. The older item wins: it has the
    # earlier provenance, and re-learning something is not evidence that this run
    # discovered it.
    #
    # The cited step is deliberately not BILLING's. Two runs of a flow reach the
    # same lesson at different step numbers almost every time, so an id computed
    # over steps or provenance would collide with nothing and the notebook would
    # fill with copies of one sentence until the cap evicted the original.
    repeat = {"text": BILLING["text"], "steps": [5]}
    out = merge(answer(successful_approach=[repeat]), TRACE, notebook=STORED, stamp=STAMP)
    matching = [i for i in out["successful_approach"] if i["text"] == BILLING["text"]]
    assert len(matching) == 1
    assert matching[0]["run_id"] == "run-1"


# --- erasure: the one thing an assisted run may not do on its own word -------

def test_a_drop_the_run_watched_fail_is_honoured():
    # This is what "observed independently" means for an erase. The run followed
    # the advice, the step it produced was evaluated a failure, and the drop
    # cites that step. Nothing about the notebook is being taken on trust.
    out = merge(answer(drop=[{"id": BILLING["id"], "steps": [3]}]),
                TRACE, notebook=STORED, stamp=STAMP)
    assert [i["id"] for i in out["successful_approach"]] == [CALENDAR["id"]]


def test_a_drop_with_no_failing_step_behind_it_leaves_the_lesson_alone():
    # An assisted run's opinion of a lesson it never tested is not evidence: its
    # whole trace was shaped by the advice it was given, so "I did not need this"
    # is indistinguishable from "this worked so well I stopped noticing it". The
    # cited step exists and succeeded, which is exactly the plausible-looking
    # erase this rule is here to refuse.
    out = merge(answer(drop=[{"id": BILLING["id"], "steps": [4]}]),
                TRACE, notebook=STORED, stamp=STAMP)
    assert BILLING["id"] in [i["id"] for i in out["successful_approach"]]


def test_a_drop_citing_no_step_at_all_leaves_the_lesson_alone():
    out = merge(answer(drop=[{"id": BILLING["id"], "steps": []}]),
                TRACE, notebook=STORED, stamp=STAMP)
    assert BILLING["id"] in [i["id"] for i in out["successful_approach"]]


def test_a_drop_of_an_id_that_is_not_in_the_notebook_is_ignored():
    out = merge(answer(drop=[{"id": "not-an-id", "steps": [3]}]),
                TRACE, notebook=STORED, stamp=STAMP)
    assert len(out["successful_approach"]) == 2


def test_an_unusable_answer_erases_nothing():
    # None is "no write", not "an empty notebook". Under replace semantics the
    # two were the same outcome and the distinction cost nothing; under
    # accumulation, reading a failed parse as an empty answer would wipe every
    # lesson a test ever learned on one bad reply.
    assert merge("I could not summarise this run.", TRACE, notebook=STORED, stamp=STAMP) is None
    assert merge("", TRACE, notebook=STORED, stamp=STAMP) is None


def test_an_answer_that_changes_nothing_returns_the_notebook_unchanged():
    # The caller compares and skips the write, which is what keeps `learned_at`
    # and the source run pointing at the run that actually contributed rather
    # than the last one that happened to pass.
    out = merge(answer(keep=[BILLING["id"], CALENDAR["id"]]),
                TRACE, notebook=STORED, stamp=STAMP)
    assert out == STORED


# --- cold: the run that earned the right to be the whole truth ---------------

def test_a_cold_run_starts_from_nothing_and_replaces():
    # No notebook was supplied, so its view of the flow is complete and current.
    # There is no keep and no drop to honour — the answer *is* the notebook.
    out = merge(answer(successful_approach=[
        {"text": "Open Billing from the account menu", "steps": [4]},
    ]), TRACE, notebook=None, stamp=STAMP)
    assert [i["text"] for i in out["successful_approach"]] == ["Open Billing from the account menu"]


def test_a_cold_run_cannot_keep_what_it_was_never_given():
    # The reverse of the laundering guard. A cold run naming an id it never saw
    # is either confused or reconstructing a notebook from something outside its
    # trace, and either way the id resolves to nothing.
    out = merge(answer(keep=[BILLING["id"]]), TRACE, notebook=None, stamp=STAMP)
    assert out["successful_approach"] == []


# --- when the generator is called at all -------------------------------------

def test_a_settled_test_does_not_pay_for_a_model_call():
    # An assisted pass whose trace records no failure has nothing to report: the
    # advice worked. This is the steady state of a settled test, and it is what
    # stops a notebook costing a model call on every run forever.
    assert should_generate(CLEAN_TRACE, cold=False) is False


def test_an_assisted_run_that_met_an_incident_does_generate():
    assert should_generate(TRACE, cold=False) is True


def test_a_cold_run_always_generates_even_when_nothing_went_wrong():
    # It has no notebook, so a clean cold run is the one that writes the first
    # one. Silence here would mean a test that never fails never learns.
    assert should_generate(CLEAN_TRACE, cold=True) is True


# --- grounding: what a new item must be read out of --------------------------

def test_a_new_item_citing_a_step_that_does_not_exist_is_dropped():
    # The whole guarantee is that memory paraphrases the trace. An item citing
    # step 9 of a five-step run was not read out of anything.
    out = merge(answer(successful_approach=[
        {"text": "Open Billing from the account menu", "steps": [4]},
        {"text": "Approve the invoice from the audit log", "steps": [9]},
    ]), TRACE, notebook=None, stamp=STAMP)
    assert [i["text"] for i in out["successful_approach"]] == ["Open Billing from the account menu"]


def test_a_new_item_citing_no_step_at_all_is_dropped():
    out = merge(answer(successful_approach=[
        {"text": "Open Billing from the account menu", "steps": []},
    ]), TRACE, notebook=None, stamp=STAMP)
    assert out["successful_approach"] == []


def test_a_mistake_keeps_its_attempt_reason_and_alternative():
    out = merge(answer(avoid_next_time=[{
        "attempt": "Use the global search for the invoice number",
        "reason": "It searched help articles rather than billing records",
        "instead": "Open Billing and use the invoice table filter",
        "steps": [2, 3],
    }]), TRACE, notebook=None, stamp=STAMP)
    item, = out["avoid_next_time"]
    assert item["attempt"] and item["reason"] and item["instead"]
    assert item["steps"] == [2, 3]


def test_a_mistake_missing_its_alternative_is_not_a_lesson():
    # "Do not do X" with nothing in its place spends prompt on a dead end and
    # tells the next run nothing about where to go instead.
    out = merge(answer(avoid_next_time=[{
        "attempt": "Use the global search",
        "reason": "It searched help articles",
        "instead": "",
        "steps": [2, 3],
    }]), TRACE, notebook=None, stamp=STAMP)
    assert out["avoid_next_time"] == []


def test_no_evidenced_mistake_means_no_invented_one():
    out = merge(answer(avoid_next_time=[{
        "attempt": "Use the global search for the invoice number",
        "reason": "It searched help articles rather than billing records",
        "instead": "Open Billing and use the invoice table filter",
        "steps": [2, 3],
    }]), CLEAN_TRACE, notebook=None, stamp=STAMP)
    assert out["avoid_next_time"] == [], "nothing in this trace failed"


def test_a_summary_that_restates_the_goal_is_not_stored():
    out = merge(
        answer(successful_approach=[
            {"text": "Confirm the March invoice reads as paid", "steps": [5]},
        ]),
        TRACE, notebook=None, goal="Confirm the March invoice reads as paid", stamp=STAMP,
    )
    assert out["successful_approach"] == []


# --- containment -------------------------------------------------------------

EXECUTABLE = [
    "Click element 14 to open the invoice",
    "Use the selector #invoice-table > tr:nth-child(2)",
    'Press the button with xpath //*[@id="billing"]/button',
    "Type Qa1!s3cret into the password field",
    "input_text(index=7, text='INV-3312')",
]


@pytest.mark.parametrize("text", EXECUTABLE)
def test_an_executable_instruction_is_not_advice(text):
    # An item carrying a selector or an element index is a replay instruction
    # wearing advice's clothes. The story's own stop condition: if this class
    # gets through, the work has crossed into browser automation.
    out = merge(answer(successful_approach=[{"text": text, "steps": [4]}]),
                TRACE, notebook=None, stamp=STAMP)
    assert out["successful_approach"] == []


def test_a_url_is_kept_only_as_normalized_orientation():
    # The trace's URLs carry the query string; the stored memory must not.
    out = merge(answer(orientation=[
        {"text": "The flow completed on https://app.example.com/search?q=INV-3312", "steps": [3]},
    ]), TRACE, notebook=None, stamp=STAMP)
    assert "q=INV-3312" not in json.dumps(out)


def test_a_secret_is_scrubbed_on_the_way_in():
    # Same `sensitive` dict browser-use holds, same `scrub` every event goes
    # through. Memory is stored text like any other, and it is read back into a
    # prompt later — so it is scrubbed at both ends, not only at the second.
    out = merge(
        answer(successful_approach=[{"text": "Sign in as admin with hunter2", "steps": [1]}]),
        TRACE, notebook=None, sensitive={"account_password": "hunter2"}, stamp=STAMP,
    )
    assert "hunter2" not in json.dumps(out)


def test_the_model_reasoning_is_not_carried_across():
    # `thinking` is on the step event and deliberately not in the generator's
    # input. Chain-of-thought from a run that is over is not an observation
    # about the app, and a trace the model never saw is a DOM it cannot
    # paraphrase — which is what makes containment a property of the input.
    system, user = build_prompt(TRACE, notebook=STORED,
                                goal="Confirm the March invoice reads as paid")
    for step in TRACE:
        assert step["next_goal"] in user
    assert "thinking" not in user


def test_the_generators_prompt_names_the_notebook_it_may_keep_or_drop():
    # keep and drop are by id, so the ids have to be in front of the model. A
    # prompt that shows the lessons without their handles gets back text, and
    # matching text to a stored item is the fuzzy step this design exists to
    # avoid.
    _, user = build_prompt(TRACE, notebook=STORED)
    assert BILLING["id"] in user
    assert BILLING["text"] in user


# --- the other end: what any stored notebook may say to the next run ---------

def test_a_secret_is_scrubbed_again_on_the_way_out():
    # The row was written under one set of secrets and is read under another. A
    # value that was safe to store in March can be the current password in
    # August, and the row is older than the rotation that made it dangerous.
    stored = notebook(successful_approach=[BILLING],
                      orientation=[{"text": "Sign in as admin with hunter2"}])
    text = to_prompt(stored, sensitive={"account_password": "hunter2"})
    assert "hunter2" not in text
    assert "Open Billing" in text, "the rest of the notebook still goes"


@pytest.mark.parametrize("text", EXECUTABLE)
def test_a_stored_item_is_caged_again_on_the_way_out(text):
    # The read end is not a duplicate of the write end, and under accumulation
    # it carries more weight than it did: a carried item is admitted at
    # generation without being re-checked, so this is the only cage a lesson
    # from an older format version, a loosened pattern or a hand edit straight
    # into the database ever passes through again.
    out = to_prompt(notebook(successful_approach=[BILLING],
                             orientation=[{"text": text}]), sensitive={})
    assert text not in out


def test_the_prompt_calls_memory_a_previous_pass_and_not_a_current_fact():
    # Memory is fallible advice about an app that may have changed since. Handed
    # over unlabelled it reads as ground truth, and the agent then trusts a menu
    # that moved over the page in front of it.
    text = to_prompt(STORED, sensitive={})
    assert "previous" in text.lower()
    assert "may" in text.lower() or "might" in text.lower()


def test_nothing_worth_saying_is_no_section_at_all():
    # An empty notebook must not become an empty heading. It costs tokens on
    # every run and tells the agent a memory exists that does not.
    assert to_prompt(notebook(), sensitive={}) is None


# --- the eviction rule -------------------------------------------------------
#
# Under accumulation the cap is a backstop, not a policy: the generator's own
# keep and drop are what prune. But a backstop that evicts the wrong end is the
# replace fault returning by another route — `applyLearned` argued for replace
# precisely because "the budget then evicts the fresh lesson to keep the stale
# one". So age leads, and this run's own contribution goes last.

def test_the_notebook_stays_small():
    many = [{"text": f"Lesson {i} about the billing table", "steps": [4]} for i in range(50)]
    out = merge(answer(successful_approach=many), TRACE, notebook=None, stamp=STAMP)
    assert len(out["successful_approach"]) <= ITEM_LIMIT
    assert len(to_prompt(out, sensitive={}) or "") <= CHAR_LIMIT


def test_the_budget_counts_what_the_model_is_given_not_what_is_stored():
    # The cap exists to bound what a notebook costs on every run of every test
    # forever, and provenance costs nothing there — `to_prompt` sends the prose
    # and nothing else. Counting the stored JSON charges each lesson ~165
    # characters of id, run, timestamp and step numbers before a single word,
    # which is most of the budget spent on bytes the model never sees.
    aged = {"run_id": "2267f58a-ebed-4c94-b7d2-cfcc0420a970",
            "learned_at": "2026-08-01T09:00:00.000000+00:00", "hinted": False}
    lessons = [approach(f"A short lesson about page {i}", [4], **aged) for i in range(ITEM_LIMIT)]
    places = [orientation(f"The flow ended on page {i}", [5], **aged) for i in range(ITEM_LIMIT)]
    stored = notebook(successful_approach=lessons, orientation=places)

    # A full notebook of *short* lessons, where the provenance outweighs the
    # prose. Measured the old way it is over budget and loses lessons; measured
    # on what the model is handed it is nowhere near.
    assert len(json.dumps(stored)) > CHAR_LIMIT, "provenance alone would blow the old cap"
    assert len(to_prompt(stored, sensitive={})) < CHAR_LIMIT

    out = merge(answer(keep=[i["id"] for i in lessons + places]),
                TRACE, notebook=stored, stamp=STAMP)
    assert len(out["successful_approach"]) == ITEM_LIMIT, "and none of it costs a lesson"
    assert len(out["orientation"]) == ITEM_LIMIT


def test_the_backstop_evicts_the_oldest_lesson_first():
    # Zero-padded: "2026-08-010" would sort *before* "2026-08-01" as a string,
    # and the oldest item is the whole subject of this assertion.
    old = [approach(f"An old lesson about page {i}", [4], run_id="run-1",
                    learned_at=f"2026-08-{i:02d}T09:00:00Z", hinted=False)
           for i in range(1, ITEM_LIMIT + 1)]
    out = merge(answer(keep=[i["id"] for i in old], successful_approach=[
        {"text": "Open the invoice row and read the status in its detail panel", "steps": [5]},
    ]), TRACE, notebook=notebook(successful_approach=old), stamp=STAMP)
    kept = [i["text"] for i in out["successful_approach"]]
    assert old[0]["text"] not in kept, "2026-08-01 is the oldest and goes first"
    assert old[-1]["text"] in kept


def test_this_runs_lesson_is_never_evicted_to_keep_an_older_one():
    # The exact failure the first build's author predicted and solved the wrong
    # way. A full notebook must not be able to refuse what this run just learned.
    old = [approach(f"An old lesson about page {i}", [4], run_id="run-1",
                    learned_at="2026-08-01T09:00:00Z", hinted=False)
           for i in range(1, ITEM_LIMIT + 1)]
    fresh = "Open the invoice row and read the status in its detail panel"
    out = merge(answer(keep=[i["id"] for i in old], successful_approach=[
        {"text": fresh, "steps": [5]},
    ]), TRACE, notebook=notebook(successful_approach=old), stamp=STAMP)
    assert fresh in [i["text"] for i in out["successful_approach"]]


def test_a_mistake_outlives_a_summary_under_the_character_cap():
    # A mistake with its alternative is the densest thing in the notebook and
    # the part a fresh run is least likely to work out for itself, so when age
    # cannot separate two items the section decides.
    same_age = {"run_id": "run-1", "learned_at": "2026-08-01T09:00:00Z", "hinted": False}
    padding = "x" * 300
    lesson = mistake("Use the global search", "It searched help articles",
                     "Open Billing and use the invoice table filter", [2, 3], **same_age)
    summaries = [approach(f"{padding} {i}", [4], **same_age) for i in range(ITEM_LIMIT)]
    orientations = [orientation(f"{padding} at {i}", [5], **same_age) for i in range(ITEM_LIMIT)]
    stored = notebook(successful_approach=summaries, avoid_next_time=[lesson],
                      orientation=orientations)
    out = merge(answer(keep=[i["id"] for i in summaries + orientations + [lesson]]),
                TRACE, notebook=stored, stamp=STAMP)
    assert len(to_prompt(out, sensitive={})) <= CHAR_LIMIT
    assert [i["id"] for i in out["avoid_next_time"]] == [lesson["id"]]


# --- the composition ---------------------------------------------------------
#
# The gap that shipped in the first build: every assertion above tests a part,
# and `make_generator` — the only thing run_agent actually calls — had none. Its
# `except Exception: return None` is a promise that a failed model call costs
# nothing, and under that promise a *programming* error is indistinguishable
# from a quiet provider timeout. The first version reached the model through
# `asyncio.run` from inside `run_agent.main`, which is already on a loop, so it
# raised on every run and every notebook was silently empty. Nothing was red.
#
# So these run the generator the way run_agent does: inside a running loop.

def test_the_generator_reaches_the_model_from_inside_a_running_loop():
    reply = answer(successful_approach=[
        {"text": "Open the invoice row and read the status in its detail panel", "steps": [5]},
    ])

    async def invoke(system, user):
        assert system and user, "the prompt is built before the call, not after"
        return reply

    async def drive():
        return await make_generator(invoke)(TRACE, notebook=STORED, goal="check the invoice",
                                            stamp=STAMP)

    out = asyncio.run(drive())
    assert len(out["successful_approach"]) == 3


def test_a_model_call_that_raises_is_no_memory_and_not_a_failed_run():
    async def invoke(system, user):
        raise TimeoutError("provider is slow")

    async def drive():
        return await make_generator(invoke)(TRACE, notebook=STORED, stamp=STAMP)

    # The promise this `except` exists for, kept — a notebook that did not write
    # is a run that learns next time, never a run that ends badly. Under
    # accumulation it must also be a notebook that did not *shrink*.
    assert asyncio.run(drive()) is None


def test_the_generator_still_cages_what_the_model_answers():
    # The composition must not be a way around `merge`: an item that is both
    # ungrounded and executable is rejected through this path exactly as it is
    # through the direct one, and the notebook it was given comes back intact.
    async def invoke(system, user):
        return answer(successful_approach=[{"text": "Click element 14", "steps": [99]}])

    async def drive():
        return await make_generator(invoke)(TRACE, notebook=STORED, stamp=STAMP)

    assert asyncio.run(drive()) == STORED
