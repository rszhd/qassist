# US-081 — A test remembers what worked

**As** someone repeatedly running the same manual QA flow, **I want** the test
to remember the mistakes it made and the approach that eventually worked,
**so that** the next run starts with the useful experience of the last one
instead of rediscovering it from scratch.

- **Status:** 📋 Planned in the current sprint 2026-08-10, queued behind
  US-046. It is an automatic, on-by-default experiment and must remain safe to
  ignore: learning, invalidation and relearning require no human maintenance,
  while an escape hatch can disable it if measurements regress.
  **Spike done and a full implementation built 2026-08-10 — then set aside the
  same day.** It ran end to end and its 56 tests were green, but it regenerated
  the notebook from scratch on every teaching pass, and that loses exactly the
  edge-case lessons the story exists to keep. The redesign is **one principle — a
  run may only rewrite what it observed independently** — and a deliberate
  simplification pass that took out two thirds of the machinery: one hash instead
  of two, no state column, no `force_cold`, no cadence. The build is recoverable
  from `git stash` and much of it still applies. This is a correctness-critical
  surface, so the new generator contract is pinned and reviewed before it is
  written (see the row in
  [`correctness-critical.md`](../../correctness-critical.md)).
- **Priority:** P3 in the current sprint. It is US-050's sibling: US-050 makes
  each reasoning step cheaper; this story tries to avoid reasoning paths that
  a previous successful run already showed were unhelpful.
- **Estimate:** ~6–8 h plus benchmarking. Producing a grounded, useful summary
  is more work than storing URLs; the measurement still decides whether it is
  worth keeping.
- **Depends on:** **US-046**, because the deliverable is cost, step and verdict
  evidence. Uses US-035's resolved variables and complements US-043's saved
  sessions and fixed project preamble.

## The model: a QA notebook, not a route cache

A human tester does not merely remember which URLs they visited. They remember:

- what approach successfully reached the state under test;
- what tempting action led to the wrong place;
- what corrected that mistake;
- any stable observation that will help them orient themselves next time.

US-081 gives a saved test that same small notebook. After a **passing cold
run**, QAssist derives a bounded memory from the run trace. On a later unchanged
run, that memory is supplied to the agent as historical, fallible advice.

Every action remains a current-run LLM decision made against the fresh page.
Memory does not click elements, select targets, bypass steps or alter the
browser before the agent starts. It helps the agent choose; it never acts for
the agent.

## Example memory

The test detail shows the same content that the next run receives:

```json
{
  "successful_approach": [
    "Open Billing from the account menu, not the workspace sidebar",
    "Set the billing period before opening an invoice",
    "Open the invoice row and inspect the payment status in its detail panel"
  ],
  "avoid_next_time": [
    {
      "attempt": "Use the global search for the invoice number",
      "reason": "It searched help articles rather than billing records",
      "instead": "Open Billing and use the invoice table filter"
    },
    {
      "attempt": "Read the status from the invoice list",
      "reason": "The list showed delivery status, not payment status",
      "instead": "Open the invoice detail panel"
    }
  ],
  "orientation": [
    "The flow completed on the account Billing page"
  ]
}
```

This remains useful when every interaction happens at one URL. URLs are only
optional orientation; the memory's primary unit is a lesson.

The memory is descriptive rather than executable. It contains no selector,
element index, DOM identity, click/input action, copied page content, entered
value, credential or model chain-of-thought. It may say *use the invoice table
filter*; it may not encode *click element 14* or a CSS selector.

## What counts as a mistake

A mistake is an attempted subgoal that the run trace marks unsuccessful or
irrelevant, followed later by a different approach that contributes to a
passing run. Ordinary progress is not padded into `avoid_next_time`, and a
failed overall run does not produce learned advice: QAssist does not yet know
which of its attempted corrections was sound.

Memory generation must be grounded only in persisted run evidence: step goals,
evaluations and normalized URLs. It may compress and paraphrase that evidence,
but it must not invent UI facts or infer a lesson unsupported by the trace.
Each learned item retains the source step numbers internally so the UI can link
back to the evidence and tests can assert provenance. Source step numbers are
metadata, not prompt content unless needed for clarity.

If the trace contains no clear mistake, `avoid_next_time` is empty. If it
contains no useful approach beyond restating the test goal, do not store a
vacuous memory merely to fill the panel.

## Automatic by default, inspectable by choice

Memory is learned and used without asking the user to configure, approve or
review it. The ordinary test and run views need only a quiet *used memory* or
*ran cold* indicator; memory must not become another required step in creating
or maintaining a test.

For someone who wants to inspect it, the test detail has a secondary **Run
memory** panel showing what worked, what to avoid — with the reason and the
preferred alternative — where the flow ended, when it was learned and a link to
the run that taught it. The next run receives the exact scrubbed content shown
there; there is no hidden memory visible only to the model.

Two controls, both escape hatches rather than routine: **remove a lesson that is
wrong**, and **Clear**, which throws the notebook away without touching run
history and lets the next run learn it fresh. A lesson may be removed and not
written — "learned" means a trace produced it, and hand-written advice must not
be able to claim provenance it does not have. There is a per-test off switch too,
for a flow where advice makes things worse; the panel should not lead with it.

## Learning: a run may only rewrite what it observed independently

That one sentence is the whole model, and the two rules under it follow.

**A cold run regenerates the notebook and replaces it.** It was given no advice,
so its view of the flow is complete and current, and it earns the right to be the
whole truth. Cold happens in exactly four situations, and in the first three the
stored lessons were not being supplied anyway: a test's first run, a fingerprint
mismatch, the run after a failure marked the notebook suspect, and a run of a
test whose memory was just cleared.

**An assisted run adds to it.** Its trace was shaped by the advice it was given,
so it is not an independent view and must not overwrite one. The generator
returns keep / add / drop against the notebook it was given, and **the write is
skipped entirely when nothing changed** — so `learned_at` and the source run keep
pointing at the run that actually contributed rather than the last one that
happened to pass.

**Silence is the default.** When an assisted run passes and no step in its trace
records a failure, the generator is not called at all: the advice worked and
nothing new happened. This is the steady state of a settled test, and it is what
keeps a notebook from costing a model call on every run forever.

Every passing run contributes, whatever help it had — assisted, hinted or cold.
That replaced an earlier rule that only cold passes may teach, which cost the
system the most valuable thing that can happen to a test: somebody telling it the
one fact it could not find. What stops advice confirming itself is not silence
but the *shape* of the write — an assisted run can add to the record and can
never erase what an independent run observed.

### What makes a notebook stop applying

Memory is keyed by test identity plus **one** canonical fingerprint over every
resolved input that changes what the run means: goal, start URL, max steps, model,
resolved run variables ([US-035](done/US-035-run-variables.md)), secret variable
*names*, project fixtures, saved-session identity and capture time, the US-043
preamble, navigation policy
([US-042](done/US-042-agent-navigation-confinement.md)), typed checks if present,
and the memory format version. Resolve, canonicalize, then hash.

One hash and one rule: **it differs, the notebook does not apply.** The lessons
are not supplied, the run is therefore cold, and its pass replaces them. The old
lessons stay in the row until then, so "recoverable" costs no extra column and no
`archived` state. There is no second hash and no two-group matrix — those existed
only to tell "archive everything" from "archive the learned half, keep the human
half", and there is no human half.

Assert each input independently rather than testing only that "some edit"
invalidates. A fingerprint blind to one resolved input is the story's original
failure mode: advice about an app the test no longer points at, arriving as a
plausible verdict nobody disputes.

A failed, cancelled, errored or inconclusive run marks the notebook **suspect**
and withholds it, recording which run raised the doubt. The next run is therefore
cold by construction and its pass clears it. Nobody reviews or re-enables
anything, and the suspect notebook is kept visible beside the run that caused it
rather than deleted — someone investigating the change needs both.

Three failure reasons are not evidence about the flow and do not mark suspect:
`session_expired`, `navigation_blocked` and `invalid_policy`. A stale credential,
the fence firing, and a policy that stopped the run before it reached the app say
nothing about whether last run's advice still holds. A list of names, never "any
run carrying a reason" — the next reason added to `run_agent.py` must join it on
purpose.

## Storage and containment

Store one disposable `test_memory` record per test, separate from immutable run
history:

- the resolved-input fingerprint and the memory format version;
- bounded learned items in the three sections, each keeping the step numbers it
  was read from;
- the run that taught it, the run that put it in doubt, and when it was learned;
- whether memory is enabled for this test.

**No `state` column and no state machine.** Every state the first build had is
derivable: "archived" is the fingerprint comparison, "suspect" is the doubt run
being set, "empty" is an empty notebook, "active" is the absence of all three.

All generated and user-edited text passes the same secret scrubbing and
containment rules as events and reports before storage and again before prompt
use — the second pass against *today's* secrets, because a value that was
harmless when it was written can be the current password by the time it is read.
Do not persist typed field values or raw page excerpts. URLs are normalized;
query strings and fragments are removed by default because they commonly carry
tokens or unstable identifiers.

## Product behaviour

- Memory is on by default for every saved test. There is no setup, approval or
  review workflow. An ad-hoc run has no test, so it neither reads nor writes.
- The escape hatches are **off** per test and **Clear**. There is no per-run
  force-cold flag: under "cold replaces", forcing cold and clearing were two
  names for one action, and Clear is the one you can see happen.
- Run history records whether learned lessons actually reached the agent, which
  is what disqualifies a run from being an independent observer.
- The run feed says when memory was used or withheld and why.
- Prompt text labels memory as advice from a previous pass, not current UI fact,
  and tells the agent to disregard anything the fresh page contradicts.
- A tight item and character budget. More history is not automatically better
  context, and the generator's own keep/drop is what prunes — the cap is a
  backstop, not a policy.

### Open: how the release gate measures without a force-cold

The last acceptance criterion is a cold-vs-assisted comparison on the same test.
Dropping `force_cold` means the only way to run cold is to Clear, which destroys
the notebook the comparison needs — so the two cannot be alternated as written.

The obvious answer is a diagnostic mode that reads nothing **and writes nothing**,
leaving the row untouched; it does not violate the principle above, because it
never rewrites anything. It is deliberately **not** being built now: the gate is
blocked on [US-046](US-046-token-usage-and-cost.md) and cannot be evaluated yet.
Decide it when the measurement is actually written, not before.


## Spike — what the implementation is written against

Pinned 2026-08-10, before any code. Everything below is a proposal for review;
the assertion-first surfaces it names are drafted but not yet in `server/test/`
or `agent/tests/`.

### Where memory is generated, and by whom

**The agent generates it; the server decides whether to keep it.** That is
US-043's session capture exactly — `run_agent.py` writes the export on every
step and `runs.js` stores it only on a pass — and the reasons carry over intact:

- The step trace is not in the database. `runs` holds a verdict and counts;
  `stepsOf(run)` reads the live `run.events` buffer and `report_data.json` is
  the on-disk copy, which US-011 retention prunes. A design that learns by
  re-reading artifacts would silently stop learning after
  `ARTIFACT_RETENTION_DAYS`.
- `scrub` and the live `sensitive` dict are in the agent. Generating server-side
  would need a second redaction implementation beside the one
  `correctness-critical.md` already lists, and two spellings of a redactor is
  how a secret gets through one of them.
- The BYOK client is already built there, and the trace crosses no new trust
  boundary — the same provider has seen every page screenshot.

So: `startRun` sets `QA_MEMORY` (the merged advice, or absent) and
`QA_LEARN_MEMORY=1` when the run is cold and eligible. The agent emits a
`memory` event before `done`. The `done` handler in `runs.js` stores it only
when `run.status === 'passed'`, `run.cancelling` is false, and the test's
fingerprint still matches the one the run started with.

The grounding input is `stepsOf`'s four fields and nothing else — `step`,
`next_goal`, `evaluation`, `url`. That is what makes "no selector, no element
index, no page excerpt" a property of the *input* rather than a filter someone
has to remember to apply.

### A hinted pass is not a cold pass — **reversed, then made moot**

The spike disqualified a hinted run from teaching, on the same rule that
disqualifies a memory-assisted one. That was wrong: a memory-assisted run's
advice came from this system's own earlier output, so teaching closes a loop with
no new evidence in it, while a **hint is evidence from outside** — a person told
it something the system did not know, and the trace still shows whether it
worked. Refusing there threw away the most valuable thing that can happen to a
test, and made the *next* run rediscover a dead end somebody had already paid to
get past.

Under the accumulate model this stops being a rule at all. Every passing run
contributes, so a hint reaches the next run by construction and there is nothing
to exempt. What is left of the argument is the reason the *shape* of the write
matters: an assisted run may add and may not erase.


### The fingerprint

Resolve, canonicalize, hash — SHA-256 over a canonical JSON encoding with
sorted keys.

| Input | Source | Canonical form |
|---|---|---|
| Goal | `resolveForRun` → `resolved.goal` | post-substitution, `<secret>` tags intact |
| Start URL | `resolved.start_url` | post-substitution, normalized as below |
| Max steps | `run.max_steps` | integer |
| Model | `run.model \|\| MODEL` | the **effective** id, never the null |
| Run variables | `resolved.variables` | non-secret name→value pairs, key-sorted |
| Secret variables | `resolved.secrets` | **names only**, sorted |
| Fixtures | `fixturePathsFor(run.project_id)` | sorted basenames |
| Saved session | `tests.browser_session_id` + that row's `captured_at` | `[id, ISO]`, or null |
| Preamble | `run.preamble` | the array as stored, keys sorted per action |
| Navigation policy | `run.policy` | `blockPrivate`, sorted `deniedHosts`, sorted `allowedDomains` |
| Format version | constant | integer |

A secret's **value never enters the hash.** Hashing is one-way, but a password
drawn from a small space is recoverable from a digest, and the fingerprint is a
column a read endpoint may serve. Nothing useful is lost: rotating a password
does not change which menu Billing is under.

URL normalization is the storage rule applied to the fingerprint too — scheme
and host lowercased, default port dropped, query and fragment removed. A run
pointed at `?utm_source=…` must not read as a different test.

### The invalidation matrix, and the state machine

Both are gone. They collapsed when hand-written notes were cut and did not need
replacing:

- The **matrix** had two groups because an input could archive the learned half
  while keeping the human half. With one half there is one rule — the fingerprint
  differs, the notebook does not apply — so `archive_fingerprint`,
  `archiveFingerprint()` and `classifyChange` all go with it.
- The **state machine** had four states and every one is derivable: `archived` is
  the fingerprint comparison, `suspect` is the doubt run being set, `empty` is an
  empty notebook, `active` is the absence of all three. So there is no `state`
  column and nothing to transition.

What survives from that thinking is the sentence the states were spelling out:
nothing needs a human to move it on. A failure withholds, the next run is cold by
construction, and its pass restores. See "What makes a notebook stop applying".


### The write is conditional, and that is the sharp edge

Two runs of one test can be in flight together, and a test can be edited while a
run is going. The store carries **the fingerprint the run started with** and is
refused when the test's current fingerprint differs. A blind upsert lets a run
that started before an edit teach a memory keyed to the post-edit inputs — the
failure is invisible, because the row looks freshly learned and its advice
describes an app the test no longer points at.

### The module seams

- `agent/run_memory.py` — the prompt and the cage around the answer. The cage is
  where the new work is: a **new** item must cite step numbers that exist in this
  trace and carry no selector, element index, URL query string or entered value,
  while a **carried-forward** item keeps its original run's provenance and is not
  re-validated — it was caged when it was written. That seam is where a stale or
  uncaged lesson could slip through, and it did not exist in the first build.
  Pure stdlib with the LLM call injected, exactly as `email_extract.py` does it.
- `server/src/testMemory.js` — the fingerprint and the text the prompt receives.
  No DB, no spawn, so it is unit-testable whole — `variables.js`'s shape. Much
  smaller than the first build's, which also held the matrix and the state
  machine.
- `db/migrations/021_test_memory.sql` — one disposable row per test.

The generator is the piece that got *harder*, not easier. The system shrank and
the difficulty concentrated in one place, which is the right trade — it is the
place the assertion-first gate is pointed at.

## The first build, set aside 2026-08-10

A complete implementation was written and then **stashed unapplied**, on the
maintainer's call, once a design fault turned up that the code could not absorb.
It is recoverable — `git stash list`, *"US-081 v1: replace-semantics build,
superseded by the accumulate redesign"* — and roughly two thirds of it survives
the redesign untouched. What it contained:

- `agent/run_memory.py` (24 reviewed assertions) and `server/src/testMemory.js`
  (30) — the generator's cage, the fingerprint, the matrix, the state machine.
  The last two no longer exist in the design; the first two largely survive.
- Migration 021, the conditional store, the `QA_MEMORY` / `QA_LEARN_MEMORY`
  spawn, all four trigger paths, the panel, and 56 tests including one against
  real Postgres.

### The fault that stopped it: replace, not accumulate

The build regenerated the whole notebook from one run's trace on every teaching
pass. `applyLearned` argued for that — appending grows a notebook nobody trims,
and the budget then evicts the fresh lesson to keep the stale one.

The maintainer found what it costs, and the example is the one that names it:

> Run 1 hits an edge case, struggles, and learns *click the calendar icon*.
> Run 2 is given that advice and sails through. Its trace shows a clean run with
> no failure, so the generator writes nothing about the calendar — **the fix
> erased the evidence of the problem it fixed**, and a replace wipes the lesson.

The story's own metaphor was already on the other side. *A QA notebook, not a
route cache* — a notebook is added to. Replace was the cache behaviour this story
says it is not building.

### The decision, and the simplification that came out of it

**Memory accumulates, under one principle: a run may only rewrite what it
observed independently.** A cold run had no advice, so its view is complete and
it replaces the notebook. An assisted run's trace was shaped by what it was
given, so it may add and may never erase. The design above is that sentence and
its consequences; what follows is what the sentence *removed*.

Simplifying was a separate pass, prompted by the maintainer — *"we need to
simplify our memory system"* — and most of what went was machinery that had
quietly lost its job when hand-written notes were cut, which nobody had gone back
to check:

- **Two hashes became one.** `archive_fingerprint`, `archiveFingerprint()`,
  `classifyChange` and the two-group matrix existed only to tell "archive
  everything" from "archive the learned half, keep the human half".
- **Four states became none.** Every one is derivable, so the `state` column,
  `nextState` and the `archived` column all go.
- **`force_cold` went.** Once a cold run replaces the notebook, forcing cold and
  clearing were two names for one action — and Clear is the one you can watch
  happen rather than a flag you have to remember you passed.
- **The weekly cadence went.** Its job was noticing the app had moved; a run that
  meets a moved app now either fails, which already forces cold, or passes and
  adds the correction.
- **Evidence-based eviction was proposed and dropped before it was built.** It
  wanted a last-confirmed stamp per item and a re-confirmation pass. Unnecessary:
  the generator already returns keep / add / drop, so it has ranked the lessons —
  it prunes, and the cap is only a backstop.

Two further refinements came from the same conversation and are in the rules
above: **a run that met no incident writes nothing** (and does not call the
generator at all), and **cold always regenerates**, which is what gives the model
a deliberate purge path for when the app under test has changed a lot.

What accumulation gives up is protection from a stale lesson nobody removes. That
is acceptable, because **failure is the corrective signal**: a lesson wrong enough
to matter makes runs fail, which marks the notebook suspect, which forces a cold
run, which replaces it. A lesson wrong but harmless costs a few tokens.

`eligibleToLearn` collapses to *a successful run contributes*. Self-confirmation
— what the old exemptions were protecting against — is handled by the shape of
the write rather than by silence: an assisted run can add to the record and can
never erase what an independent run observed.


### Two decisions from the first build that carry forward

- **A hinted pass teaches** (reversed mid-build; the argument is under "A hinted
  pass is not a cold pass" above). Under accumulation this stops being a special
  case at all — every passing run contributes, so a hint reaches the next run by
  construction. `source_hinted` per item is still owed, so the panel credits the
  person rather than the agent.
- **No hand-written half.** Manual items were cut after being built: writing one
  made the next run cold, they forced a whole deadlock rule of their own, and the
  case they served — *this lesson is wrong* — is served by removing it. Durable
  instructions belong in the test's Instructions field. If non-judged per-test
  context is wanted, it deserves its own field, not a lane in the notebook.

### Two bugs the next build must not repeat

Both were found by hand, days after the code was green, and both are recorded
because the second build will pass through the same two places.

- **Nothing wrote `runs.memory_used` / `memory_fingerprint`.** The migration
  added the columns and `runState.js` typed them; `persistInsert` never named
  them. Every persisted run read back as cold, which is the column that decides
  whether a run may teach.
- **The generator never ran, on any run, silently.** It reached the model through
  `asyncio.run` from inside `run_agent.main`, which is already on a loop, so it
  raised every time — and `make_generator`'s `except Exception: return None`
  caught it. Nothing was red and no notebook was ever written. The parts were all
  asserted; the composition was not. The general lesson is in
  [`docs/testing.md`](../../../docs/testing.md) → *A swallow-all `except` hides a
  programming error behind a promise*.

### Before the second build

This is a correctness-critical surface, so the same gate applies: the **new
generator contract and the eviction rule are pinned and reviewed before either is
written**. The fingerprint, the invalidation matrix, the state machine and the
conditional write are unaffected by this decision and their assertions stand.

## Acceptance criteria

- [ ] A newly saved test participates automatically with no memory setup,
      approval or review step; its first run is cold and a pass teaches the next
- [ ] With memory disabled for a test, nothing is read or generated and there is
      no prompt or agent-configuration difference from today's run path
- [ ] A passing run with a failed subgoal followed by a successful correction
      produces a grounded **Avoid next time** item with attempt, reason,
      alternative and source-step provenance
- [ ] A passing run produces a concise **What worked** summary that is useful on
      a single-URL, multi-action flow and does not merely restate the goal
- [ ] A run with no evidenced mistake stores no invented `avoid_next_time` item;
      a vacuous summary is not stored
- [ ] The stored memory contains no executable action, selector, element
      identity, raw page excerpt, entered value, credential or chain-of-thought —
      asserted for a **new** item at generation and for a **carried-forward** one
      at prompt time, which is a row that outlived the `validate` that admitted it
- [ ] The test detail shows the exact memory supplied to the agent, the run that
      taught it, when, and why it is being withheld if it is
- [ ] A user can remove a lesson and clear the notebook without changing run
      history; the prompt receives exactly the content shown

**The two rules, which are the story:**

- [ ] An **assisted** pass ADDS what it found and does not overwrite a lesson an
      earlier run learned — asserted for a hinted run too, since a hint is
      evidence from outside and must reach the next run
- [ ] A **cold** pass REPLACES the notebook, and cold is exactly: a first run, a
      fingerprint mismatch, the run after a failure, and a run after Clear
- [ ] A passing run that met no incident calls no generator and writes nothing;
      the stored `learned_at` and source run still name the run that contributed
- [ ] The item and character cap holds, with the generator's own keep/drop
      deciding what survives it

**Invalidation and containment:**

- [ ] Every resolved input is asserted to move the fingerprint **independently**,
      never as "some edit invalidates"; a secret's value never enters the hash
- [ ] A fingerprint mismatch supplies nothing, the run is therefore cold, and its
      pass replaces the notebook — the superseded lessons stay readable until then
- [ ] Non-passing runs mark the notebook suspect and withhold it; the next run is
      cold by construction and a pass clears the doubt with no human action; the
      UI links both runs. The three reasons that are not evidence about the flow
      do not mark suspect
- [ ] A run that started before an edit cannot teach a notebook keyed to inputs
      it never ran with (real Postgres — pg-mem cannot hold the conditional write)
- [ ] Secret scrubbing is asserted both when memory is stored and when it is read
      for a prompt, the second against *today's* secrets
- [ ] Per-test opt-out is asserted

**The gate:**

- [ ] Cold vs memory-assisted fixture measurements record duration, steps, cost
      and **verdict agreement**, with differing verdicts inspected and a stated
      recommendation recorded in this file. Needs a way to run cold without
      destroying the notebook — see "Open: how the release gate measures without
      a force-cold"


## Deliberately not in scope

- Deterministic prefix or full-route replay
- Matching fresh DOM elements to previous targets
- Storing or replaying browser-use actions
- Learning or repeating credential-entry sequences
- Skipping part of the flow because a previous run passed it
- Generating Playwright code; stable deterministic flows should be explicit
  Playwright tests, and a product path for that deserves its own story

## Correctness posture

Memory changes prompt context and can therefore change behavior and verdicts.
Verdict agreement is its release gate, and suspect/archived memory is never
silently supplied to the agent. **This is correctness-critical** and owes a row
in [`correctness-critical.md`](../../correctness-critical.md) when work starts.

Assertions for grounded provenance, canonical fingerprinting, cold-only
learning, human-vs-learned precedence, state transitions, secret containment
and the no-executable-actions boundary are written before implementation. If
the design grows an executor, DOM matcher or step-skipping mechanism, stop: the
work has crossed into browser automation and belongs in Playwright or a
different story.

## Notes

- Run US-050 and US-081 over the same fixture suite so their savings and
  verdict effects are comparable.
- Memory generation itself may require an LLM call. Its input tokens, output
  tokens, latency and price are included in the comparison; a notebook that
  costs more to write than it saves is not an optimization.
- The experiment may show that models already recover adequately from their
  trace and that cross-run memory mostly anchors them. Closing the story on
  that evidence is preferable to keeping an unhelpful cache.
