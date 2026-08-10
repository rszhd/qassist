# US-046 — What did that run cost?

**As** someone funding every run from my own key, **I want** each run to report
its token usage and dollar cost, **so that** I can decide whether a nightly
suite of forty tests is a good idea before the invoice tells me.

- **Status:** 🔨 **Tier 1 done 2026-08-10**, 4/7. Pulled into the current sprint
  ahead of [US-081](US-081-a-test-remembers-what-worked.md), whose release gate
  is a cold-vs-memory-assisted cost comparison that cannot be evaluated without
  this. The spike that preceded it was read against the installed `browser_use`
  and turned up a correctness-critical shape the original write-up did not have;
  it is recorded below because it is the reason `cost_known` exists.
  **Tier 2 — the three surfaces — is the remaining work.**
- **Priority:** P3 when nothing depended on it. Now P2 by dependency: US-081
  and US-050 both deliver a measurement, and neither can be judged until a run
  reports what it cost.
- **Estimate:** ~2–3 h as written; **~4–5 h** with the discriminator and the
  bounded pre-warm the spike below adds, split into two tiers.
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

## Spike — read against the installed library, 2026-08-10

Line numbers below are `browser_use` as installed in `qassist:latest`.

### `total_cost: 0.0` means three different things, and they are not
distinguishable from the summary

`UsageSummary.total_cost` is a plain `float` with no "known" flag
(`tokens/views.py:95`). It is `0.0` when:

1. **Cost collection is off.** `get_usage_summary` guards the whole cost
   calculation with `if self.include_cost:` (`tokens/service.py:472`); the
   token totals above it are still summed, so the object looks fully populated.
2. **Pricing was never loaded.** A failed fetch sets `self._pricing_data = {}`
   and swallows the exception (`tokens/service.py:174`). `get_model_pricing`
   then returns `None`, `calculate_cost` returns `None`, and `if cost:` skips
   the accumulation. Tokens are still correct.
3. **The model is genuinely unpriced.** LiteLLM's file does not know it, and it
   is not an OpenRouter id, so the same `None` path is taken.

Only the third is a fact about the run. **This is the correctness-critical
piece**, and it fails the way that is hardest to catch: `$0.00` on a run that
cost forty cents is a plausible number, not a broken one. Nobody reports it.
The History aggregate makes it worse — a total across a filtered set silently
omits every unpriced run and reads as an authoritative sum, which is exactly
the number someone reconciles against an invoice before deciding the product
lies to them.

So the `done` event carries **`cost_known`** alongside the figures, decided
before the summary is flattened, and every reader downstream renders unknown
rather than zero. Tokens and cost are separately trustworthy: `entry_count > 0`
is enough for tokens, and never enough for cost.

### The off switch has to be closed from both ends

`TokenCost.__init__` (`tokens/service.py:57`) is

```python
self.include_cost = include_cost or os.getenv('BROWSER_USE_CALCULATE_COST', 'false').lower() == 'true'
```

An `or`, so passing `calculate_cost=False` does **not** turn cost off — an
operator whose environment happens to hold that variable gets the fetch anyway,
and AC #5's "off means no outbound request at all" is quietly false. The
environment variable is assigned from our own switch before the import, beside
the two telemetry defaults already at the top of `run_agent.py`.

### The network call is on the run's own critical path

`self.history.usage = await self.token_cost_service.get_usage_summary()` sits on
`agent.run()`'s return path (`agent/service.py:2644`, again at `:2657` for the
interrupt path), and `log_usage_summary()` in the `finally` (`:2672`) computes
the whole thing a **second time**. Neither is anywhere we can wrap.

Inside that loop, `get_model_pricing` falls through to
`get_openrouter_model_pricing` for any unknown model. That helper returns `None`
without a request when the name has no `/` (`_normalize_openrouter_model_id`,
`tokens/openrouter_pricing.py:45`) — so `gpt-4.1` is safe. A slash-bearing id is
not: `get_openrouter_models_metadata` leaves its cache unset on failure
(`:92`), so it retries per entry, at a 30 s timeout each. A refused connection
or a failed DNS lookup comes back fast and costs almost nothing; a network that
*hangs* — the captive portal, the egress filter that drops rather than rejects —
pays the full timeout per entry, twice over, and a sixty-step run then sits
there for half an hour after its last step, holding a concurrency slot with its
verdict already decided.

The fix is to move the network to somewhere we can bound it: **pre-warm
`token_cost_service` before `agent.run()`**, under our own `wait_for`, and prime
the pricing for the run's own model so every in-run lookup is a dictionary read.

The public entry point is `ensure_pricing_loaded` (`tokens/service.py:643`) —
whose docstring says it "will run in the background and won't block" and which
plainly `await`s `initialize()`, so the bound is ours to impose either way.
On timeout we then have to force `_initialized = True` and `_pricing_data = {}`
ourselves: cancelling it mid-flight leaves `_initialized` false, and the retry
then happens inside the run, which is the thing we were avoiding. Private
attributes, so US-043's `_cdp_get_storage_state` rule applies — reach for the
public path first, and say in a comment why it is not enough on its own.

### Where the pricing cache lives

`xdg_cache_home() / 'browser_use/token_cost'`, one JSON file per fetch, valid
for a day (`CACHE_DIR_NAME`, `CACHE_DURATION`). Inside the container that is
`$HOME/.cache`, which no volume holds — so the fetch happens once per container
boot rather than once per day, and every deploy pays for it again. Worth a
named volume, and worth *not* pretending the cache is the off switch.

### Tiers

- **Tier 1** — the number exists and is honest: `calculate_cost` wired with the
  env closed, the bounded pre-warm, `agent/run_cost.py` (pure: flatten the
  summary, decide `cost_known`), the `done` event fields, migration `020`
  adding `prompt_tokens` / `completion_tokens` / `total_cost` / `cost_known`,
  the per-model breakdown into `report_data.json`, and the API.
- **Tier 2** — the surfaces: run detail, the report header column, and the
  History total across the filtered set. The aggregate is the one that actually
  answers the question, and also the one that must refuse to sum a set holding
  an unpriced run without saying so.

## Acceptance criteria

- [x] Every completed run records prompt/completion/total tokens and an
      estimated cost, with the per-model breakdown available in the run detail
      (row + `usage.by_model` in `report_data.json`)
- [ ] The estimate is labelled as one wherever it appears; an unknown model
      renders as unknown, never as zero
- [x] "Cost unknown" and "cost was zero" are distinguishable end to end — in the
      `done` event, the row, the API and every surface — for all three causes
      the spike names: collection off, pricing unavailable, model unpriced
- [x] Tokens survive a cost failure: a run whose pricing never loaded still
      reports prompt/completion/total tokens, and reports no cost at all
- [ ] History shows a total for the current filter set
- [ ] Pricing lookup failure or an unreachable network degrades to tokens-only —
      the run still completes and the verdict is unaffected
- [x] Cost collection can be switched off, and off means no outbound request at
      all (the precondition US-045's local tier depends on) — `CALCULATE_COST=0`,
      closed at both ends because the library ORs its kwarg with the environment

## Tier 1, as built (2026-08-10)

`agent/run_cost.py` — `summarize(usage, *, enabled, priced_models)`. Pure
stdlib, and deliberately never asked to read the number to decide whether the
number is real: the caller supplies whether collection ran and which models the
pricing table answered for, because those are the two things `UsageSummary`
cannot be asked. An unknown cost is `None`, never `0`. A genuinely free model
still reports a measured zero, which is what stops the flag degenerating into
"is the total non-zero".

`run_agent.py` — three additions. `QA_CALCULATE_COST` becomes
`BROWSER_USE_CALCULATE_COST` *before* the browser-use import, so the library's
`or` cannot reopen a switch the operator closed. `warm_pricing` pays for the
pricing table before step 1, under a 15 s bound, and on timeout marks the
service loaded-and-empty by hand — cancelling `ensure_pricing_loaded` mid-flight
leaves `_initialized` false and puts the retry back inside `agent.run()`'s
teardown, which is the one place we cannot wrap. `priced_models` then asks,
per model and through the same alias map `calculate_cost` uses, whether a price
exists at all.

Storage: migration `020`, four columns and a check constraint —
`(cost_known and total_cost is not null) or (not cost_known and total_cost is
null)`. The constraint is the point. A later writer that reads
`usage.total_cost` and forgets `usage.cost_known` fails loudly at the insert
instead of quietly putting `$0.00` into someone's history. `numeric(12,6)`, not
`float8`: this gets summed across a filter set.

`shapeRun` converts on the way out, and **that conversion is load-bearing**:
`pg` returns `numeric` as a *string*, so an untouched cost would leave the API
as `"0.041000"` from the row and `0.041` from the live relay — the same run
changing type when it stopped being live. pg-mem returns a number and hides
this completely, which is why `run-cost-postgres.test.js` exists and pins the
driver's behaviour directly.

Verified: `agent/tests/test_run_cost.py` 11/11 (assertion-first, reviewed before
the module existed), the agent suite 397/397, `run-cost.test.js` 8/8,
`run-cost-postgres.test.js` 5/5 against the compose `db`, the server suite
759/759, and `npm run check` clean. `run_agent.py` import-checked inside
`qassist:latest`, with the switch proven both ways.

### Tier 2, and what it must not do

The three surfaces: run detail, the report header column, the History total.
The aggregate is the one with a trap in it — a total over a page holding one
unpriced run must say so rather than sum what it could price. Wrong downwards
is the direction nobody questions.
