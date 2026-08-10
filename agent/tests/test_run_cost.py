"""US-046 — DRAFT ASSERTIONS, for review before any implementation exists.

Destination once reviewed: agent/tests/test_run_cost.py, against
agent/run_cost.py.

One question, asked over and over: **is this zero a measurement, or the absence
of one?** `UsageSummary.total_cost` cannot answer it. The field is `0.0` when
collection was off, when the pricing file never loaded, and when the model is
genuinely unpriced — and the token totals beside it are correct in all three,
so the object looks fully populated every time.

That is why this is asserted at a pure function and not through the UI. The
failure renders as `$0.00`, which is a plausible number nobody reports; the
aggregate over a filtered History set renders as an authoritative total that
silently omits every run it could not price. Neither produces a red build, a
stack trace, or a second opinion.

`summarize` takes what `history.usage` gives (as plain dicts, so no browser and
no pydantic in the test) plus the two things the summary cannot tell us: whether
collection was on at all, and which models resolved a price.
"""
import pytest

from run_cost import summarize

# One model, one call, priced. The ordinary run.
PRICED = {
    "total_prompt_tokens": 12000,
    "total_completion_tokens": 800,
    "total_tokens": 12800,
    "total_cost": 0.041,
    "entry_count": 6,
    "by_model": {
        "gpt-4.1": {
            "model": "gpt-4.1", "prompt_tokens": 12000, "completion_tokens": 800,
            "total_tokens": 12800, "cost": 0.041, "invocations": 6,
        }
    },
}


def unpriced(usage):
    """The same run with every cost field left at the library's default."""
    out = {**usage, "total_cost": 0.0}
    out["by_model"] = {m: {**s, "cost": 0.0} for m, s in usage["by_model"].items()}
    return out


# --- the one question -------------------------------------------------------

def test_a_priced_run_reports_its_cost():
    out = summarize(PRICED, enabled=True, priced_models={"gpt-4.1"})
    assert out["cost_known"] is True
    assert out["total_cost"] == pytest.approx(0.041)


def test_collection_off_is_not_a_run_that_cost_nothing():
    # The library sums tokens whether or not include_cost is set, so this
    # summary is populated and its total_cost is 0.0. Reading that as a
    # measurement puts $0.00 against every run on an instance with cost off.
    out = summarize(unpriced(PRICED), enabled=False, priced_models=set())
    assert out["cost_known"] is False
    assert out["total_cost"] is None, "no number at all, rather than a wrong one"
    assert out["total_tokens"] == 12800, "tokens are still a measurement"


def test_pricing_that_never_loaded_is_not_a_run_that_cost_nothing():
    # A failed fetch swallows its exception and leaves _pricing_data empty, so
    # every lookup misses and every cost is skipped. Collection was ON — which
    # is exactly why this case cannot be told from a real zero by the flag
    # alone, and why the priced-model set has to be asked for separately.
    out = summarize(unpriced(PRICED), enabled=True, priced_models=set())
    assert out["cost_known"] is False
    assert out["total_cost"] is None
    assert out["total_tokens"] == 12800


def test_an_unpriced_model_is_not_a_run_that_cost_nothing():
    out = summarize(unpriced(PRICED), enabled=True, priced_models={"some-other-model"})
    assert out["cost_known"] is False
    assert out["total_cost"] is None


def test_a_model_that_really_is_free_reports_a_measured_zero():
    # The one case where 0.0 is the answer. It has to survive, or the flag is
    # just "is the total non-zero" wearing a better name.
    free = unpriced(PRICED)
    out = summarize(free, enabled=True, priced_models={"gpt-4.1"})
    assert out["cost_known"] is True
    assert out["total_cost"] == 0.0


# --- a run bills against more than one model --------------------------------

MIXED = {
    "total_prompt_tokens": 20000,
    "total_completion_tokens": 1500,
    "total_tokens": 21500,
    "total_cost": 0.041,
    "entry_count": 9,
    "by_model": {
        "gpt-4.1": {
            "model": "gpt-4.1", "prompt_tokens": 12000, "completion_tokens": 800,
            "total_tokens": 12800, "cost": 0.041, "invocations": 6,
        },
        "local/qwen-vl": {
            "model": "local/qwen-vl", "prompt_tokens": 8000, "completion_tokens": 700,
            "total_tokens": 8700, "cost": 0.0, "invocations": 3,
        },
    },
}


def test_one_unpriced_model_makes_the_run_total_unknown():
    # The judge, page extraction and message compaction each register their own
    # LLM (agent/service.py:422–427), so a run can be part-priced. A total that
    # counts the half it could price is not a smaller estimate — it is a wrong
    # one, and it is wrong downwards, which is the direction nobody questions.
    out = summarize(MIXED, enabled=True, priced_models={"gpt-4.1"})
    assert out["cost_known"] is False
    assert out["total_cost"] is None


def test_the_breakdown_says_which_model_was_the_problem():
    # Whoever sees "cost unknown" needs to be able to act on it, and the answer
    # is always the name of a model.
    out = summarize(MIXED, enabled=True, priced_models={"gpt-4.1"})
    by_model = {m["model"]: m for m in out["by_model"]}
    assert by_model["gpt-4.1"]["cost"] == pytest.approx(0.041)
    assert by_model["gpt-4.1"]["cost_known"] is True
    assert by_model["local/qwen-vl"]["cost"] is None
    assert by_model["local/qwen-vl"]["cost_known"] is False
    # Tokens are per-model measurements either way.
    assert by_model["local/qwen-vl"]["total_tokens"] == 8700


def test_every_model_priced_gives_a_known_total():
    out = summarize(MIXED, enabled=True, priced_models={"gpt-4.1", "local/qwen-vl"})
    assert out["cost_known"] is True
    assert out["total_cost"] == pytest.approx(0.041)


# --- degradation ------------------------------------------------------------

def test_no_summary_at_all_is_no_usage_at_all():
    # history.usage is None when the run crashed before the summary was built.
    # Not zero tokens — no measurement.
    assert summarize(None, enabled=True, priced_models={"gpt-4.1"}) is None


def test_a_run_that_never_called_a_model_reports_zero_tokens():
    empty = {
        "total_prompt_tokens": 0, "total_completion_tokens": 0, "total_tokens": 0,
        "total_cost": 0.0, "entry_count": 0, "by_model": {},
    }
    out = summarize(empty, enabled=True, priced_models=set())
    assert out["total_tokens"] == 0
    assert out["cost_known"] is False, "nothing was priced because nothing was spent"
    assert out["total_cost"] is None


def test_a_malformed_summary_costs_the_numbers_and_not_the_run():
    # This runs on the way out of a finished run whose verdict is already
    # decided. A reporting bug must never be the reason a run has no result.
    assert summarize({"by_model": "not a dict"}, enabled=True, priced_models=set()) is None
    assert summarize("nonsense", enabled=True, priced_models=set()) is None
