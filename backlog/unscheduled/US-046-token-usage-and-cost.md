# US-046 — What did that run cost?

**As** someone funding every run from my own key, **I want** each run to report
its token usage and dollar cost, **so that** I can decide whether a nightly
suite of forty tests is a good idea before the invoice tells me.

- **Status:** 📋 Planned.
- **Priority:** P3 among the unscheduled work. Nothing depends on it; it becomes
  P2 the first time someone asks "why is my OpenAI bill like this".
- **Estimate:** ~2–3 h.
- **Depends on:** US-039 (BYOK-only is what makes this the *user's* number
  rather than the operator's).

## Why now

`Agent.__init__` takes `calculate_cost` (default `False`) and `pricing_url`. Set
it, and `history.usage` is a `UsageSummary`
(`browser_use/tokens/views.py:95`): `total_prompt_tokens`,
`total_completion_tokens`, `total_tokens`, `total_cost`, cached-token and
cache-creation breakdowns, and `by_model` — which matters because a run bills
against more than one model call (the judge, page extraction and message
compaction each register their own LLM with the same cost service,
`agent/service.py:422–427`).

We pass nothing, so `history.usage` is `None` and every run's cost is invisible.
Since US-039 that cost lands entirely on the user, which makes its absence a
gap in the product rather than an internal metric we happen not to collect.

It is also the natural metering hook for the hosted tier — collected here as a
plain per-run fact that any self-hoster wants, which is exactly the shape
`docs/repo-model.md` requires of anything the private repo might later consume.
`self-hosted/` gains a `usage` field; it does not learn that `cloud/` exists.

## Details

- `Agent(calculate_cost=True)`; the `done` event carries the flattened summary;
  `runs` gains `prompt_tokens`, `completion_tokens`, `total_cost` columns (and
  keeps the per-model breakdown in `report_data.json` rather than in columns).
- **Cost is an estimate and must be labelled one.** The number comes from
  browser-use's pricing table fetched from `pricing_url` and cached, not from the
  provider's billing API. It will drift, it will be wrong for negotiated rates,
  and it may be missing entirely for a model it does not know — which the UI must
  render as "unknown", never as `$0.00`. Getting this wrong turns a helpful
  estimate into a number someone reconciles against an invoice and mistrusts the
  whole product over.
- **The network call is the catch.** Pricing is fetched and cached
  (`TokenCost.ensure_pricing_loaded` / `refresh_pricing_data`). A run must not
  fail, stall, or leak an outbound request when the operator did not expect one —
  which directly conflicts with US-045's fully-local claim. Ship it with a stale
  cache and an explicit off switch, and make sure "no pricing data" degrades to
  tokens-only rather than to an error.
- Surfaces: the run detail (History and `/runs/<id>`), a column in the report
  header, and a total across the filtered set in History — the aggregate is what
  actually answers the question people have.

## Acceptance criteria

- [ ] Every completed run records prompt/completion/total tokens and an
      estimated cost, with the per-model breakdown available in the run detail
- [ ] The estimate is labelled as one wherever it appears; an unknown model
      renders as unknown, never as zero
- [ ] History shows a total for the current filter set
- [ ] Pricing lookup failure or an unreachable network degrades to tokens-only —
      the run still completes and the verdict is unaffected
- [ ] Cost collection can be switched off, and off means no outbound request at
      all (the precondition US-045's local tier depends on)
