# US-081 — A test remembers what worked

**As** someone repeatedly running the same manual QA flow, **I want** the test
to remember the mistakes it made and the approach that eventually worked,
**so that** the next run starts with the useful experience of the last one
instead of rediscovering it from scratch.

- **Status:** 📋 Planned in the current sprint 2026-08-10, queued behind
  US-046. It is an automatic, on-by-default experiment and must remain safe to
  ignore: learning, invalidation and relearning require no human maintenance,
  while an escape hatch can disable it if measurements regress.
  **Spike done 2026-08-10** — the invalidation matrix, the state machine, the
  fingerprint and the module seams are pinned below, and the assertions they
  describe are drafted and waiting on review. No implementation yet: this is a
  correctness-critical surface, so the assertion comes first (see the row in
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
memory** panel showing:

- **What worked**;
- **Avoid next time**, including the reason and preferred alternative;
- **Orientation**;
- when it was learned and a link to the passing cold source run.

The user may edit the wording, add a manual lesson, remove an incorrect lesson,
disable memory for this test, or clear it without changing run history. These
are optional controls, not tasks required to keep memory healthy. A human
correction outranks an automatic summary while it remains applicable.

Learned items and manual items are labelled separately. A later cold pass may
replace the automatically learned portion but must preserve manual items until
the user removes them. The next run receives the exact merged, scrubbed content
shown in the panel—there is no hidden memory visible only to the model.

## Learning and invalidation

Automatic memory is keyed by test identity plus a canonical fingerprint of
every resolved input that changes what the run means: goal, start URL, max
steps, model and mode, resolved run variables
([US-035](done/US-035-run-variables.md)), project fixtures,
saved-session identity/state version, the US-043 preamble, navigation policy
([US-042](done/US-042-agent-navigation-confinement.md)), typed
checks if present, and the memory format version.

Resolve, canonicalize, then hash. Assert each dependency independently rather
than testing only that "some edit" invalidates memory. Store the fingerprint
and format version so a deployment can discard an old learned shape
deliberately.

Only a passing **cold** run may create or replace automatically learned memory.
A memory-assisted run must not train its successor: that would allow its own
advice to become self-confirming and gradually drift away from independently
discovered evidence.

A failed, inconclusive, cancelled or errored run marks automatic memory
**suspect** and withholds it. The next eligible run automatically runs cold; a
pass replaces the suspect learned memory and resumes normal memory-assisted
runs. No one has to review or re-enable it. Do not silently delete the suspect
version: the secondary UI keeps it available with the run that made it suspect
for someone investigating the change.

Changes to goal, start URL, fixtures, navigation policy or test checks archive
both automatic and manual lessons and make the next run cold. A passing cold
run learns a fresh automatic memory without waiting for review. Archived human
writing remains inspectable and recoverable but is never silently put back into
the prompt. Changes to ephemeral resolved values, model or mode invalidate
automatic provenance without erasing human writing. The spike must pin this
matrix before implementation; no transition may require human intervention for
the next run to proceed safely.

## Storage and containment

Store one disposable `test_memory` record per test, separate from immutable run
history. It contains:

- the resolved-input fingerprint and memory format version;
- bounded learned and manual items in the three visible sections;
- source run ID, source step references and creation/update times;
- state: `active`, `suspect`, `archived` or `empty`.

All generated and user-edited text passes the same secret scrubbing and
containment rules as events and reports before storage and again before prompt
use. Do not persist typed field values or raw page excerpts as memory. URLs are
normalized; query strings and fragments are removed by default because they
commonly contain tokens or unstable identifiers. Retaining selected query keys
requires an explicit allowlist.

## Product behaviour

- Memory is on by default for saved tests. Learning and prompt use happen
  automatically when eligible; there is no setup or approval workflow.
- A test can opt out, and an individual run can force cold behavior, as escape
  hatches rather than expected routine controls.
- Run history records `cold` or `memory-assisted`, the source memory version,
  and whether memory was actually supplied to the agent.
- The run feed says when memory was used or withheld and why.
- Scheduled tests run cold on a recorded cadence. Start the experiment
  at weekly and revisit it from data.
- Prompt text labels memory as advice from a previous pass, not current UI fact,
  and tells the agent to disregard anything contradicted by the fresh page.
- The memory has a tight item and character budget. More history is not
  automatically better context.

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

### A hinted pass is not a cold pass

US-079 lets a person tell a live run what to do. A run that passed after a hint
did not discover its approach — someone handed it over. `hintsOf(run).length > 0`
disqualifies a run from teaching, on the same rule that disqualifies a
memory-assisted one: only an independently discovered pass may become advice.
The hint text is the user's writing, so its honest home is a manual item they
choose to keep, never a learned lesson attributed to the trace.

### Manual items are an input, not a previous run's conclusion

Cold means *no learned items were supplied*. Manual items ride along on every
run, cold or not, and never make one memory-assisted. Without this the story
deadlocks: after a model change the learned half is invalidated, the manual half
survives and is prompted, every subsequent run is therefore memory-assisted, and
no run may ever teach again — which the story's own "no transition may require
human intervention" rule forbids.

The cost is that a manual item's wording is part of what a learned item was
derived under, so **manual text joins the fingerprint** and editing it archives
the learned half. One cold run per wording tweak, and the alternative is a
learned memory whose provenance quietly lies.

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
| Manual items | the `test_memory` row | the item texts, in order |
| Format version | constant | integer |

A secret's **value never enters the hash.** Hashing is one-way, but a password
drawn from a small space is recoverable from a digest, and the fingerprint is a
column a read endpoint may serve. Nothing useful is lost: rotating a password
does not change which menu Billing is under.

URL normalization is the storage rule applied to the fingerprint too — scheme
and host lowercased, default port dropped, query and fragment removed. A run
pointed at `?utm_source=…` must not read as a different test.

### The invalidation matrix

| Input changes | Learned | Manual | Next run |
|---|---|---|---|
| Goal | archived | archived | cold |
| Start URL | archived | archived | cold |
| Fixtures | archived | archived | cold |
| Navigation policy | archived | archived | cold |
| Typed checks (when they exist) | archived | archived | cold |
| Format version | archived | archived | cold |
| Max steps | archived | kept | cold |
| Model | archived | kept | cold |
| Run variables | archived | kept | cold |
| Secret variable *names* | archived | kept | cold |
| Saved session id or `captured_at` | archived | kept | cold |
| Preamble | archived | kept | cold |
| Manual item text | archived | kept | cold |
| Secret variable *values* | kept | kept | memory-assisted |

Every archive makes the next run cold, because cold is defined as "no learned
items supplied" and there are none. Asserted per input, not as "some edit
invalidates".

### The state machine

`empty` → no learned items. Next run cold; manual items still supplied.

`active` → learned items supplied. Reached from a passing cold eligible run
whose generation produced at least one non-vacuous item. A generation that
produced nothing usable leaves the state `empty` rather than storing a vacuous
memory to fill the panel.

`suspect` → learned items withheld, kept visible beside the run that caused it.
Reached when a run of the test ends `failed`, `error`, `cancelled`, or
`completed` with a null verdict. The next run is therefore cold by
construction, and a pass returns the state to `active`, replacing the learned
items. Nobody reviews or re-enables anything.

**Two failure reasons do not mark suspect:** `session_expired` and
`navigation_blocked`. Neither is evidence about the flow — the first is a stale
credential and the second is the fence firing — and treating them as evidence
would throw away good memory every time a nightly session lapsed.

`archived` → learned and manual moved out of the prompt, recoverable, never
silently put back. Reached from the first group of the matrix above.

### The write is conditional, and that is the sharp edge

Two runs of one test can be in flight together, and a test can be edited while a
run is going. The store carries **the fingerprint the run started with** and is
refused when the test's current fingerprint differs. A blind upsert lets a run
that started before an edit teach a memory keyed to the post-edit inputs — the
failure is invisible, because the row looks freshly learned and its advice
describes an app the test no longer points at.

### The module seams

- `agent/run_memory.py` — the prompt, and the cage around the answer: every item
  must cite step numbers that exist in the trace, no item may contain a selector,
  element index, URL query string or entered value, and the item and character
  budgets are enforced here. Pure stdlib with the LLM call injected as
  `invoke(system, user) -> str`, exactly as `email_extract.py` does it.
- `server/src/testMemory.js` — the fingerprint, the matrix classification, the
  state machine, and the merge of learned + manual into the text the prompt
  receives. No DB, no spawn, so it is unit-testable whole — `variables.js`'s
  shape.
- `db/migrations/021_test_memory.sql` — one disposable row per test.

### Not closable this sprint

The last acceptance criterion is a cold-vs-memory-assisted measurement of
duration, steps, **cost** and verdict agreement. Cost does not exist yet:
`Agent(calculate_cost=…)` is unset, `history.usage` is `None`, and that is
[US-046](US-046-token-usage-and-cost.md) — unscheduled, ~2–3 h.
Until it lands the story can ship its behaviour and assert everything else, but
its release gate cannot be evaluated, and a notebook that costs more to write
than it saves is the outcome this story most needs to be able to detect.

## Acceptance criteria

- [ ] A newly saved test participates automatically with no memory setup,
      approval or review step; its first eligible run is cold and a pass can
      teach the next run
- [ ] With memory explicitly disabled, no memory is read or generated and there
      is no prompt or agent-configuration difference from today's run path
- [ ] A passing cold run with a failed subgoal followed by a successful
      correction produces a grounded **Avoid next time** item with attempt,
      reason, alternative and source-step provenance
- [ ] A passing cold run produces a concise **What worked** summary that is
      useful on a single-URL, multi-action flow and does not merely restate the
      goal
- [ ] A run with no evidenced mistake stores no invented `avoid_next_time`
      item; a vacuous summary is not stored
- [ ] The stored memory contains no executable action, selector, element
      identity, raw page excerpt, entered value, credential or chain-of-thought
- [ ] The test detail shows the exact memory supplied to the agent, learned vs
      manual labels, source run/evidence, learned-at time and current state
- [ ] A user can edit, add and remove lessons and clear memory without changing
      run history; the prompt receives exactly the merged content shown
- [ ] A later cold pass replaces learned items without overwriting manual items
- [ ] A memory-assisted run never trains successor memory
- [ ] Non-passing runs mark learned memory suspect and withhold it; the next
      eligible run automatically runs cold and a pass relearns memory without
      human action; the UI links both relevant runs
- [ ] The resolved-input invalidation matrix is documented and asserted per
      input; stale human writing is archived and recoverable but not prompted,
      and the system automatically proceeds through a fresh cold run
- [ ] Secret scrubbing is asserted both when memory is stored and when it is
      read for a prompt
- [ ] Per-test opt-out, per-run force-cold and the scheduled weekly cold
      transition are asserted
- [ ] Cold vs memory-assisted fixture measurements record duration, steps, cost
      and **verdict agreement**, with differing verdicts inspected and a stated
      recommendation recorded in this file

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
