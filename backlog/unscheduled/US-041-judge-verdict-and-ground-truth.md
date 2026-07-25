# US-041 — The judge decides the verdict, and a test can state what it must prove

**As** someone who trusts a green run, **I want** the pass/fail to come from an
independent judge grading the trace against criteria I wrote, **so that** a red
build means the app broke rather than meaning the agent was pessimistic about
itself.

- **Status:** 📋 Planned. **Correctness-critical** — the verdict is the product's
  output; owes a row in [`correctness-critical.md`](../correctness-critical.md)
  and assertion-first treatment when scheduled.
- **Priority:** P1. Not because it is urgent plumbing, but because it is the one
  sentence the README leads with (*"judges pass/fail"*) being untrue today, and
  because the fix stops an LLM call that is already being paid for from being
  discarded.
- **Estimate:** ~3–4 h for the verdict swap; ~2–3 h more for ground truth
  (column, API, UI field, report line).
- **Depends on:** nothing. Touches US-009's saved tests and US-020's report.

## Why now — we are already buying this and throwing it away

`browser_use.Agent.__init__` takes `use_judge` (**default `True`**),
`ground_truth` and `judge_llm` (which defaults to the run's own `llm`).
`run_agent.py` passes none of them, so `use_judge` is on. At the end of every
QAssist run, `Agent._judge_trace()` (`browser_use/agent/service.py:1585`) sends
the task, the final result, every step description and the **last 10
screenshots** to the model and gets back a structured `JudgementResult`:

| Field | Meaning |
|---|---|
| `verdict: bool` | whether the trace actually succeeded |
| `reasoning: str \| None` | why |
| `failure_reason: str \| None` | ≤5 sentences, on failure |
| `impossible_task: bool` | the goal was unachievable — vague instructions, broken site, missing credentials |

`run_agent.py` then reports `history.is_successful()`, which is a *different
value*. Its docstring: *"the agent decides in the last step if it was successful
or not."* browser-use is explicit that the two do not merge — from
`_judge_and_log`:

> The judge verdict is attached to the action result but does NOT override
> `last_result.success` — that stays as the agent's self-report.

So today: every user's BYOK key funds a vision-heavy judge call whose answer is
dropped on the floor, and the verdict in the PDF is the agent grading its own
homework. The two failure directions are both real — an agent that gives up and
self-reports failure on a page that was actually correct, and (worse for a
testing product) an agent that declares success having never reached the
success state.

## Details

**Tier 1 — read the judgement.** `history.judgement()` returns the dict;
`history.is_judged()` and `history.judge_verdict()` are the accessors
(`browser_use/agent/views.py:744–764`). The `done` event gains `judge_verdict`,
`judge_reasoning`, `failure_reason` and `impossible_task` alongside the existing
`success`, and the *judge* verdict becomes what sets the terminal status in
`server/src/runs.js` (`applyDone`, ~line 570).

Keep emitting the self-report. It costs nothing, and disagreement between the
two is the single most useful signal we could put in front of a maintainer —
"the agent thought it passed, the judge disagrees" is exactly the run a human
should watch the recording of.

Decide and write down what happens when the judge fails to answer.
`_judge_trace` returns `None` on exception rather than raising. Falling back to
the self-report is defensible; falling back *silently* is not. The event should
say which source the verdict came from, and the report should print it.

**Tier 2 — `impossible_task` becomes its own status.** Today a run whose goal
could not be expressed and a run whose app is broken are both red. They demand
opposite responses from the person reading the history. This wants a third
terminal status (`blocked`?) in `status.js`'s colour map and the History filter
— which is a schema and UI decision, not just plumbing, so it may want to split
out.

**Tier 3 — `ground_truth` on a saved test.** A nullable `acceptance_criteria`
text column on `tests`, passed to `Agent(ground_truth=…)`, threaded through the
Test dialog (`RunDialogs.jsx`) and printed in the report next to the goal. This
is what turns a goal ("check out with a test card") into a specification ("an
order confirmation number is visible and the cart badge reads 0"). It is also
the cheapest possible answer to "why did this pass?" — the criteria are on the
page.

## Assertion-first notes (for when this is scheduled)

The subtle failures here are all *silent green*, which is the worst kind for a
testing product:

- The verdict source is swapped but a `None` judgement falls through to the
  self-report with no marker, so the instance quietly reverts to old behaviour
  for exactly the runs where the judge choked — and every test still passes.
- `judge_verdict()` reads `history[-1].result[-1]`. A run that errored out or
  hit `max_steps` may have no `is_done` result at all, so the accessor returns
  `None` — the timeout path must not become "passed".
- `ground_truth` is user-authored text reaching an LLM prompt; it needs the same
  `scrub` treatment as the goal if variables can be substituted into it
  (US-035), or a secret lands in the judge's context.

The spec should pin: a stubbed judgement of `verdict=false` turns a
self-reported success red; a `None` judgement is labelled, not silently
inherited; a no-`is_done` history is never green.

## Acceptance criteria

- [ ] The terminal status of a run is the **judge's** verdict; the agent's
      self-report is still emitted and persisted, and the two are visibly
      distinct in the run detail
- [ ] A run where the judge and the agent disagree is identifiable in History
      without opening the PDF
- [ ] `failure_reason` appears in the run detail and the report for every red
      run, replacing the current prose-only `final_result`
- [ ] A judge that fails to answer is reported as such — the run does not
      silently fall back to the self-report with no marker, and never turns green
      on a history with no completed `done` action
- [ ] A saved test can carry acceptance criteria; they reach `ground_truth`,
      appear in the report, and a run that meets the goal's letter but not the
      criteria is red
- [ ] `agent/tests/` covers the verdict-selection helper as a pure function
      (no browser, no LLM), assertion reviewed before implementation
