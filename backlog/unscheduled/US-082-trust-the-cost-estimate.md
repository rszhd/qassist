# US-082 — Prove the cost estimate, then show it again

**As** the person whose key pays for every run, **I want** the dollar figure on
a run to be one I can check against my provider's bill, **so that** the number
either earns its place on the screen or stays off it.

- **Status:** 📋 Planned. The estimate was taken off the UI on 2026-08-13
  because nobody had checked it against a real bill. This story is what puts it
  back.
- **Priority:** P3. Nothing is broken while the figure is hidden — tokens are
  still reported, and they are a measurement rather than an arithmetic result.
- **Estimate:** ~2 h. Most of it is one deliberate run and a comparison against
  the provider's own usage page; the code to restore is two lines.
- **Depends on:** [US-046](../sprint/current/done/US-046-token-usage-and-cost.md),
  which built the whole path and whose acceptance criteria this partly undoes.

## What was hidden

The frontend only. The number is still collected, still stored and still
returned:

- `RunView.jsx` — the "Est. cost" stat on the live run card. Removed.
- `RunDetail.jsx` — the same stat, and the "Counted, but not priced" note under
  Tokens, which existed only to finish the stat's "Unknown" sentence. Removed.
- `frontend/src/status.js` — `formatCost` stays, with its tests. No view calls
  it.
- Untouched: `agent/run_cost.py`, the `done` event's `usage` object,
  `runs.total_cost` / `cost_known`, `GET /runs` and its `cost` aggregate, and
  the report's **EST. COST** box (`agent/make_report.py:158`).

History's total was already gone before this, for a different reason.

## What has to be proved

`cost_known` answers "did every model this run billed against resolve a price".
It does not answer "is the resulting number right". The three things that could
make it wrong, in order of likelihood:

1. **The rates.** browser-use fetches a pricing table over the network. Nobody
   has compared a row of it against the provider's published price, and a stale
   table is wrong quietly and in one direction.
2. **The cached-token arithmetic.** A per-call cost is uncached prompt + cached
   read + cache creation + completion. Cached reads are priced far below fresh
   ones, and a run that re-sends a long page is mostly cached reads — get the
   split wrong and the error is large, not marginal.
3. **The models we do not see.** The judge, page extraction and message
   compaction each register their own LLM. `by_model` is the check that they all
   appear; that they are all *charged* the same way is not checked.

The proof is one run against a key with no other traffic, then the provider's
own usage page for that window, side by side.

## Acceptance criteria

- [ ] One run on an otherwise idle key, with its reported estimate and the
      provider's billed amount for the same window both recorded in this file
- [ ] The gap between them stated as a percentage, with a verdict: acceptable
      for a figure labelled "Est.", or not
- [ ] A run whose prompt is mostly cached reads compared the same way — the case
      where a wrong cache split shows up
- [ ] The rates in the fetched pricing table checked against the provider's
      published prices on the day of the run
- [ ] If the estimate holds: the stat returns to `RunView` and `RunDetail`, the
      "Counted, but not priced" note returns with it, and the tests removed on
      2026-08-13 come back
- [ ] If it does not hold: the fault is named here, and the report's EST. COST
      box goes too — one surface must not keep a number the other two refused
