"""What a run spent, and whether we actually know it (US-046).

browser-use hands back a `UsageSummary` whose `total_cost` is a plain float. It
is `0.0` when cost collection was off, when the pricing table never loaded, and
when the model has no published price — and the token totals beside it are
correct in all three, so the object looks fully populated every time. Only the
third of those is a fact about the run, and none of them is distinguishable
from a run that genuinely cost nothing.

So this module never reads the number to decide whether the number is real. It
is told, by the caller, the two things the summary cannot say: whether
collection was enabled at all, and which models resolved a price. A cost that
is not known is `None` — never a zero. Downstream renders "unknown", and the
History aggregate refuses to quietly sum a set it could not price.

Pure stdlib and no browser, so `tests/test_run_cost.py` pins it directly. The
impure halves stay in `run_agent.py`: reading `history.usage`, and asking
`token_cost_service` which models it could price.

THE EVENT SHAPE LIVES IN `server/src/runEvents.js`. `summarize` is the author of
the `usage` object on the `done` event; a field added or renamed here lands
there in the same commit.
"""
from __future__ import annotations


def _int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _model_entry(name: str, stats: dict, known: bool) -> dict:
    """One model's line. Tokens are a measurement whatever the pricing did."""
    return {
        "model": name,
        "prompt_tokens": _int(stats.get("prompt_tokens")),
        "completion_tokens": _int(stats.get("completion_tokens")),
        "total_tokens": _int(stats.get("total_tokens")),
        "invocations": _int(stats.get("invocations")),
        "cost": _float(stats.get("cost")) if known else None,
        "cost_known": known,
    }


def summarize(usage, *, enabled: bool, priced_models) -> dict | None:
    """Flatten `history.usage` into the `done` event's `usage` object, or None.

    `enabled` is whether cost collection ran; `priced_models` is the set of
    model names the pricing table actually answered for. Both come from the
    caller because the summary cannot be asked.

    None means "no measurement", which is not the same as zero: the run crashed
    before browser-use built a summary, or what it built cannot be read. This
    runs on the way out of a run whose verdict is already decided, so a
    reporting fault must cost the numbers and never the result.
    """
    if not isinstance(usage, dict):
        return None
    models = usage.get("by_model")
    if not isinstance(models, dict):
        return None
    if any(not isinstance(stats, dict) for stats in models.values()):
        return None

    priced = set(priced_models or ())
    # Every model the run billed against has to be priced for the run's own
    # total to mean anything. A run bills against more than one — the judge,
    # page extraction and message compaction each register their own LLM — so
    # totalling the half that had prices is not a smaller estimate, it is a
    # wrong one, and it is wrong downwards, which is the direction nobody
    # questions.
    #
    # An empty `by_model` is not "all of them are priced": nothing was spent, so
    # nothing was priced, and there is no cost to report.
    known = enabled and bool(models) and all(name in priced for name in models)

    return {
        "prompt_tokens": _int(usage.get("total_prompt_tokens")),
        "completion_tokens": _int(usage.get("total_completion_tokens")),
        "total_tokens": _int(usage.get("total_tokens")),
        "entry_count": _int(usage.get("entry_count")),
        # Read straight from the summary when it is real, and withheld entirely
        # when it is not. Deliberately NOT recomputed from the per-model lines:
        # browser-use accumulates cached-read and cache-creation costs into the
        # total that the per-model `cost` field does not carry, so a sum of the
        # breakdown would be quietly low.
        "total_cost": _float(usage.get("total_cost")) if known else None,
        "cost_known": known,
        "by_model": [
            _model_entry(name, models[name], enabled and name in priced)
            for name in sorted(models)
        ],
    }
