# US-081 — A test remembers what worked

**As** someone repeatedly running the same manual QA flow, **I want** the test
to remember the mistakes it made and the approach that eventually worked,
**so that** the next run starts with the useful experience of the last one
instead of rediscovering it from scratch.

- **Status:** 📋 Planned in the current sprint 2026-08-10, queued behind
  US-046. It is an automatic, on-by-default experiment and must remain safe to
  ignore: learning, invalidation and relearning require no human maintenance,
  and the whole feature is withdrawn on the release gate's evidence rather than
  switched off one test at a time.
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
  **Second build done 2026-08-10, except the gate.** The contract was pinned,
  then the assertions, then the code against them. Every acceptance criterion is
  met but the last: migration 021, the two pure modules, the conditional store,
  the spawn, `run_agent.py`'s generator call, the panel and its three controls,
  the run-feed line and `docs/api.md`. 90 assertions over the feature —
  `agent/tests/test_run_memory.py` (51), the three server files (35) and the
  conditional write on real Postgres (4) — plus the frontend suite. Each rule
  that carries the redesign was checked by hand against a mutation that breaks
  it.
  **Four decisions came from using it**, and each is recorded beside the rule it
  changed: there is no off switch, a run that does not pass changes nothing, the
  fingerprint is two inputs rather than eleven, and the budget counts the prompt
  rather than the row.
  **The release gate is the remaining work** and is still blocked on US-046
  tier 2 — see "Open: how the release gate measures without a force-cold".
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

US-081 gives a saved test that same small notebook. Every passing run adds to it
from its own trace; a run that was given no notebook replaces it outright. On a
later unchanged run it is supplied to the agent as historical, fallible advice.

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
preferred alternative — and where the flow ended. Each lesson carries its own
provenance, because a notebook holds lessons from several runs at once: when it
was learned, whether a person hinted the run that found it, and a link to that
run. The next run receives the exact scrubbed content shown there; there is no
hidden memory visible only to the model.

The panel is **absent** on a test that has learned nothing, rather than an empty
heading. A permanent empty drawer in the edit dialog is a thing you open once to
find out it never mattered, and the feature's whole claim is that it is safe to
ignore.

Three controls, all escape hatches rather than routine: **remove a lesson that is
wrong**; **Clear**, which throws the notebook away without touching run history
and lets the next run learn it fresh; and **These still apply**, which re-keys a
notebook an edit set aside. A lesson may be removed and not written — "learned"
means a trace produced it, and hand-written advice must not be able to claim
provenance it does not have.

**Nothing is deleted that was not asked for.** Dismissing a dialog, editing a
test, a run that did not pass, a model change: none of them remove a lesson. The
one automatic loss is the rule the model rests on — a cold run's pass replaces
the notebook — and it is the deliberate cost of letting an independent observer
be the whole truth.

Both dialogs are the app's own `Modal`, not the browser's `confirm`. A native
dialog cannot say what is at stake and does not look like the rest of the
product, which is most of what a confirmation is for.

**There is no off switch** (decided 2026-08-10). Memory cannot be disabled, only
cleared. A per-test disable was in the first build and is cut: it is a permanent
answer to a temporary complaint, and it leaves a test in a state nobody revisits
— quietly excluded from the thing the story exists to measure. Remove the wrong
lesson, or Clear and let the next run learn it fresh. If advice keeps making a
flow worse, that is the release gate's verdict on the feature, not a per-test
preference to store.

## Learning: a run may only rewrite what it observed independently

That one sentence is the whole model, and the two rules under it follow.

**A cold run regenerates the notebook and replaces it.** It was given no advice,
so its view of the flow is complete and current, and it earns the right to be the
whole truth. Cold happens in exactly three situations, and in each the stored
lessons were not being supplied anyway: a test's first run, a fingerprint
mismatch, and a run of a test whose memory was just cleared.

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

Memory is keyed by test identity plus **one** canonical fingerprint over **two**
resolved inputs: the **instructions** and the **start URL**. Resolve,
canonicalize, then hash.

It was eleven — max steps, model, variables, secret names, fixtures, the saved
session, the preamble, the navigation policy and the format version as well
(revised 2026-08-10). That asked the wrong question. The hash answers *is this
still the same flow through the same app?*, and eleven inputs answered *did
anything about this run change?* — so the model swapped on the box, a session
re-captured overnight, a fixture added to the project or `ALLOWED_DOMAINS` edited
in config each wiped every notebook on the instance for a change that left the
app exactly where it was.

Two things survive the cut for free, because the goal is hashed
*post-substitution*: a variable that reaches the instructions still moves the hash
(`log in as {{role}}` is a different flow for admin and for viewer), and a
secret's value still never enters it, because `resolveForRun` leaves the literal
`<secret>name</secret>` marker in the goal rather than the password. What is no
longer caught is a project preamble edited under the test — the accepted cost,
and Clear is the answer to it.

Assert both halves one input at a time: the two that move it, and the nine that
must not. The second is the half that rots — an input added back by a
well-meaning reader costs notebooks silently, and a fleet that keeps forgetting
things has no bar to notice.

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

**A run that does not pass changes nothing** (revised 2026-08-10). An earlier
draft marked the notebook *suspect*, withheld it, and let the next run's pass
clear the doubt — on the reasoning that failure is the corrective signal for a
lesson gone stale.

That was wrong, and the counter-example is the ordinary case: **the commonest
reason a QA test fails is that it found the bug it exists to find.** Under "cold
replaces", withholding after a failure means the next pass throws away every
lesson the notebook holds — to punish a failure none of them caused, at exactly
the moment the test is doing its job. The mechanism was strongest precisely where
it should have been silent.

So a failed, cancelled, errored or inconclusive run is a no-op on the notebook:
nothing is withheld, nothing is stamped, and the next run is still assisted. The
whole apparatus goes with it — the `suspect_run_id` column, `marksSuspect`, the
`clearDoubt` write, the list of three reasons that were not evidence about the
flow, and the panel's link to the accusing run.

What is left for a lesson that really is wrong is the pair of escape hatches the
story already had: remove that lesson, or Clear. Both are visible, both are
somebody's decision, and neither costs the other lessons.

## Storage and containment

Store one disposable `test_memory` record per test, separate from immutable run
history:

- the resolved-input fingerprint and the memory format version;
- bounded learned items in the three sections;
- when it was last written.

**Provenance is per item, not per row.** Under replace, one row and one notebook
were the same object, so `source_run_id`, `learned_at` and `source_hinted` could
sit on the row. Under accumulation a notebook holds lessons from several runs at
once, and a row-level stamp would answer *which run taught this* with the wrong
run for every item but the newest. So each item carries its own step numbers, the
run that taught it, when, and whether a person hinted it — which is also what
lets the backstop evict by age and the panel credit the person rather than the
agent.

There is no `enabled` column, because there is nothing to disable.

**No `state` column and no state machine.** Every state the first build had is
derivable, and one of them no longer exists: "archived" is the fingerprint
comparison, "empty" is an empty notebook, "active" is the absence of both, and
"suspect" is gone entirely.

All generated and user-edited text passes the same secret scrubbing and
containment rules as events and reports before storage and again before prompt
use — the second pass against *today's* secrets, because a value that was
harmless when it was written can be the current password by the time it is read.
Do not persist typed field values or raw page excerpts. URLs are normalized;
query strings and fragments are removed by default because they commonly carry
tokens or unstable identifiers.

## Product behaviour

- Memory is on for every saved test and cannot be turned off. There is no setup,
  approval or review workflow. An ad-hoc run has no test, so it neither reads
  nor writes.
- The escape hatches are **remove a lesson**, **Clear** and **These still
  apply**. There is no per-test disable and no per-run force-cold flag: under
  "cold replaces", forcing cold and clearing were two names for one action, and
  Clear is the one you can see happen.
- **An edit that sets the notebook aside offers to keep it, twice.** Once on save
  — the server says whether the fingerprint moved and how many lessons are at
  stake, and the dialog asks — and again in the panel, for as long as the
  notebook is set aside. The second is not a duplicate: the save-time prompt can
  be dismissed by Escape or a stray click, and without a second route an accident
  strands the notebook until a pass overwrites it.
- **Start fresh deletes now; dismissing does not.** The button says what it does,
  so it should not leave the lessons in the panel afterwards — but the X, Escape
  and the scrim all mean "not now", and throwing a notebook away because somebody
  dismissed a dialog is the wrong kind of surprise.
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
| Instructions | `resolveForRun` → `resolved.goal` | post-substitution, `<secret>` tags intact, trimmed |
| Start URL | `resolved.start_url` | post-substitution, normalized as below |


A secret's **value never enters the hash.** Hashing is one-way, but a password
drawn from a small space is recoverable from a digest, and the fingerprint is a
column a read endpoint may serve. Nothing useful is lost: rotating a password
does not change which menu Billing is under.

**And the person gets the last word.** The hash knows *that* the instructions
changed and never whether that changed the flow — a typo fixed in the goal and
the test repointed at another app are the same event to it. So an edit that moves
the fingerprint on a test that has lessons asks: *do those still apply?* Yes
re-keys the row to the new inputs and the next run is still helped; anything else,
including dismissing it, leaves the automatic behaviour. `PUT /api/tests/:id`
carries the answer (`memory.invalidated`, `memory.lessons`) because the hash is
the server's — a second spelling on the client agrees until it quietly does not —
and `POST /api/tests/:id/memory/keep` is the re-key. It never touches a lesson.

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
- The **state machine** had four states. Three are derivable — `archived` is the
  fingerprint comparison, `empty` is an empty notebook, `active` is the absence
  of both — and `suspect` was removed outright the same day, under "A run that
  does not pass changes nothing". So there is no `state` column and nothing to
  transition.

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

### The generator contract, and the eviction rule

Pinned 2026-08-10, before `agent/run_memory.py` is written the second time.
Drafted as assertions in `agent/tests/test_run_memory.py`; **awaiting review**.

The generator is handed the notebook the run started with and answers against
it: `{"keep": [id], "drop": [{id, steps}], "add": {…the three sections}}`. A cold
run is handed no notebook, so its answer is `add` alone — which is what makes
"cold replaces" fall out of the same shape rather than needing a second path.

Six calls this contract makes, each one a way the accumulate model could be
undone quietly:

- **Omission is keep.** An item named in neither list survives. Reading silence
  as a drop is the replace fault in a new costume: a run given good advice sails
  through, reports nothing, and erases what made it sail through.
- **Keep is by id, and the text comes from storage.** A kept item's words are
  taken from the row, and whatever the model wrote beside that id is discarded.
  Otherwise `keep` writes a new lesson wearing an old lesson's provenance —
  ungrounded, uncaged and stamped with a run that never said it.
- **A carried item is not re-grounded.** Its step numbers belong to another
  run's trace, so checking them against this one empties every notebook on its
  second run — and nothing is red, the notebook simply never grows. It was caged
  when it was written, and it is caged again at prompt time; that is the split
  the acceptance criteria already ask for.
- **A drop needs a failing step of *this* trace behind it.** That is what
  "observed independently" means for an erase: the run followed the advice and
  the steps show it not working. An assisted run's opinion of a lesson it never
  tested is not evidence — its whole trace was shaped by that advice, so "I did
  not need this" cannot be told apart from "this worked so well I stopped
  noticing it".
- **An unusable answer erases nothing.** `None` means no write, never an empty
  notebook. Under replace those were the same outcome; under accumulation, one
  malformed reply would wipe everything a test ever learned.
- **Identity is the item's own words** — a content hash of the section and the
  lesson text, and of nothing else. Re-learning a lesson collides with the one
  already stored and the older item wins, so dedup is free and provenance keeps
  pointing at the run that found it first. Steps and provenance stay *out* of the
  hash: two runs of a flow reach the same lesson at different step numbers almost
  every time, so an id computed over them would collide with nothing and the
  notebook would fill with copies of one sentence until the cap evicted the
  original.

**The budget is 10 lessons a section and 3000 characters** (revised 2026-08-10;
it was 5 and 2000). The character cap counts `to_prompt`'s output — what the model
is handed — not the stored JSON. Provenance costs about 165 characters a lesson
in the row and nothing at all in the prompt, so counting the row charged most of
the budget to bytes no model reads, and the item cap was unreachable: eleven
lessons of pure metadata already filled 2000. On the new basis a full notebook of
30 lessons comes to ~2995 characters, about 514 words, and the two caps bite in
roughly the same place — which is what a backstop should do.

**Eviction: age leads, and this run's contribution goes last.** The cap is a
backstop and the generator's keep/drop is the policy, but a backstop that evicts
the wrong end brings back the exact fault `applyLearned` used to argue for
replace — *the budget evicts the fresh lesson to keep the stale one*. So the
order is oldest `learned_at` first; an item this run added is evicted only when
nothing older remains; and when age cannot separate two items the section
decides — orientation, then successful approach, then `avoid_next_time` last,
because a mistake with its alternative is the densest thing in the notebook and
the part a fresh run is least likely to work out for itself.

**`should_generate(trace, cold)`** is the "silence is the default" rule as a pure
function: cold always generates, an assisted run generates only when its trace
records a failure. It is asserted here rather than left implicit in
`run_agent.py`, because it is the rule that decides whether a settled test costs
a model call on every run forever.

### The module seams

- `agent/run_memory.py` — the prompt and the cage around the answer. The cage is
  where the new work is: a **new** item must cite step numbers that exist in this
  trace and carry no selector, element index, URL query string or entered value,
  while a **carried-forward** item keeps its original run's provenance and is not
  re-validated — it was caged when it was written. That seam is where a stale or
  uncaged lesson could slip through, and it did not exist in the first build.
  Pure stdlib with the LLM call injected, exactly as `email_extract.py` does it.
  Surface: `build_prompt`, `merge`, `to_prompt`, `should_generate`, `item_id`,
  `make_generator`. `merge` replaces the first build's `validate` and the name is
  the change — it no longer turns an answer into a notebook, it applies an answer
  *to* one.
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

What accumulation gives up is protection from a stale lesson nobody removes, and
**failure is not the corrective signal** — that was tried and reversed the same
day, under "A run that does not pass changes nothing" above. The corrective
signals are the two visible ones: remove the lesson, or Clear. A lesson wrong but
harmless costs a few tokens.

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

- [x] A newly saved test participates automatically with no memory setup,
      approval or review step; its first run is cold and a pass teaches the next
- [x] A test whose notebook is empty — never learned, or just cleared — runs with
      no prompt or agent-configuration difference from today's run path
- [x] A passing run with a failed subgoal followed by a successful correction
      produces a grounded **Avoid next time** item with attempt, reason,
      alternative and source-step provenance
- [x] A passing run produces a concise **What worked** summary that is useful on
      a single-URL, multi-action flow and does not merely restate the goal
- [x] A run with no evidenced mistake stores no invented `avoid_next_time` item;
      a vacuous summary is not stored
- [x] The stored memory contains no executable action, selector, element
      identity, raw page excerpt, entered value, credential or chain-of-thought —
      asserted for a **new** item at generation and for a **carried-forward** one
      at prompt time, which is a row that outlived the `validate` that admitted it
- [x] The test detail shows the exact memory supplied to the agent, the run that
      taught it, when, and why it is being withheld if it is
- [x] A user can remove a lesson and clear the notebook without changing run
      history; the prompt receives exactly the content shown
- [x] Nothing is deleted that was not asked for: dismissing the save-time prompt
      writes nothing, and the panel offers **These still apply** for as long as
      an edit has the notebook set aside

**The two rules, which are the story:**

- [x] An **assisted** pass ADDS what it found and does not overwrite a lesson an
      earlier run learned — asserted for a hinted run too, since a hint is
      evidence from outside and must reach the next run
- [x] A **cold** pass REPLACES the notebook, and cold is exactly: a first run, a
      fingerprint mismatch, and a run after Clear
- [x] A passing run that met no incident calls no generator and writes nothing;
      the stored `learned_at` and source run still name the run that contributed
- [x] The item and character cap holds, with the generator's own keep/drop
      deciding what survives it

**Invalidation and containment:**

- [x] The two inputs are asserted to move the fingerprint **independently**, and
      the nine dropped ones are asserted **not** to; a secret's value never
      enters the hash
- [x] An edit that moves the fingerprint on a test with lessons offers to keep
      them; keeping re-keys and rewrites nothing; dismissing leaves the
      automatic behaviour
- [x] A fingerprint mismatch supplies nothing, the run is therefore cold, and its
      pass replaces the notebook — the superseded lessons stay readable until then
- [x] A run that does not pass leaves the notebook untouched and the run after it
      is still assisted — a test that fails because it found a bug does not lose
      what it learned
- [x] A run that started before an edit cannot teach a notebook keyed to inputs
      it never ran with (real Postgres — pg-mem cannot hold the conditional write)
- [x] Secret scrubbing is asserted both when memory is stored and when it is read
      for a prompt, the second against *today's* secrets
- [x] Clear empties the notebook and the next run is cold; run history is
      unchanged and the run that taught the cleared notebook is still readable

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
Verdict agreement is its release gate, and a notebook whose inputs have moved is
never silently supplied to the agent. **This is correctness-critical** and owes a row
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
