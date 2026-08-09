# US-081 — A test remembers the route that worked

**As** someone whose nightly suite re-solves the same login, cookie banner and
three navigations forty times a night, **I want** a re-run to start from what
the last passing run learned, **so that** the boring prefix costs no reasoning
and the tokens go to the part of the flow that is actually under test.

- **Status:** 📋 Planned.
- **Priority:** P3 among the unscheduled work. It is the same argument as
  US-050 — cheaper routine runs — from the other side: US-050 makes each step
  cheaper, this one removes steps.
- **Estimate:** ~6–8 h for tier 1+2, and the split is not where it looks. The
  plumbing is small; invalidation and the replay match are the work.
- **Depends on:** **US-046** (hard, for the same reason US-050 depends on it:
  the deliverable is a measurement, and without cost per run there is no way to
  say whether memory paid for itself). Uses US-043's preamble path and US-035's
  variable resolution, neither as a blocker.

## Why this is cheap to build

Three of the four pieces already exist, which is most of the case for doing it.

- **A stable identity across runs.** `tests.id` is it. `runs` denormalizes
  goal, start_url and max_steps at enqueue time
  ([US-011](../sprint/current/done/US-011-run-history.md)), so "the same test,
  run again" is already a fact the schema can state.
- **A deterministic action prelude, already wired.**
  `agent/browser_session.py:89` `initial_actions()` turns `QA_INITIAL_ACTIONS`
  into actions browser-use executes before the first LLM step, recorded as step
  0 ([US-043](../sprint/current/done/US-043-reusable-authenticated-sessions.md)
  AC #5). A learned route has exactly that shape. The source of the list is new;
  the mechanism is not.
- **A trace worth learning from.** `agent/step_events.py` emits url, evaluation
  and next_goal per step, and browser-use's `AgentHistoryList.model_actions()`
  (`agent/views.py:823`) returns each action *with* its `interacted_element`.
- **The missing piece** is storage: a place to put one route per test, and the
  rules that throw it away.

## Replay must not match on the element index

`DOMInteractedElement` (browser-use `dom/views.py:976`) carries `x_path`,
`stable_hash`, `ax_name`, `attributes` and `bounds` alongside `node_id`. Only
the first three survive a re-render. browser-use's own indexes are per-snapshot
positions in that step's selector map, so replaying *click element 14* against
a page that grew a banner clicks a different element **and nothing anywhere
reports it** — the action succeeds, the run goes somewhere else, and the verdict
blames the goal.

So the match order is `stable_hash` → `x_path` → `ax_name`, and **no match is a
mismatch, never a guess**. This is the single rule that decides whether the
story is worth shipping.

## The rule the whole story serves

**Memory must never turn a failing run into a passing one.** Everything below is
downstream of that sentence, and it is why this is deliberately not a
record-and-replay feature.

Two failure shapes, and neither is hypothetical:

1. **Stale route, false red.** The app moved the button. The memory sends the
   agent at where it was. The agent burns steps and gives up on a build that is
   fine. Mitigation: any mismatch discards the memory and hands control back to
   the LLM *from that step*, and the run continues cold. A memory that misses is
   deleted, not repaired.
2. **Skipped path, false green.** The memory replays past the step that would
   have caught the regression. Mitigation: replay stops at the prefix (see
   tiers), the judge still grades the end state, and a scheduled test runs cold
   on a cadence so the discovery path is itself exercised.

The second is the dangerous one. A tool that goes red when it should be green
gets debugged; a tool that goes green when it should be red gets trusted.

## Tiers

**Tier 1 — the route as a hint.** After a passed run, store a short summary:
the URLs visited and each step's `next_goal`. On the next run of that test,
append it to the task as *last time, this worked; here is the route*. Every step
is still a real LLM decision, so no step can be skipped and neither failure
shape above is reachable. The gain is fewer wrong turns, not fewer steps —
smaller than tier 2 and almost free to build.

**Tier 2 — the prefix as a preamble.** Take the leading actions of the last
passed run that are stable and side-effect-shaped — the navigation, the cookie
banner, the login — and feed them through `initial_actions`. Those steps cost
zero tokens. This is where the saving actually is: on a real suite the boring
prefix is most of the run. Stop the replay at the first action the match rules
cannot place, and at the first step whose `next_goal` is part of what the test
is asserting.

**Not in scope: full step-by-step replay.** At that point the test no longer
exercises the path it claims to test, and what you have is a brittle Selenium
script with an LLM bill attached. If the measurement from tier 2 argues for it,
that is a new story with its own case to make.

## Invalidation is the actual work

The memory is keyed by test identity **plus everything that changes what the
run means**: goal, start_url, max_steps, model, run variables
([US-035](../sprint/current/done/US-035-run-variables.md)), project fixtures,
the US-043 preamble, and the navigation policy
([US-042](../sprint/current/done/US-042-agent-navigation-confinement.md)). Any edit
to any of them drops the route. Learn only from the most recent **passed** run;
a failed run teaches nothing that is safe to repeat.

The trap is that this list is a *dependency source* problem, not a diffing
problem: a variable's value lives outside the test row, so a key built from the
test row alone goes stale silently and the failure is a wrong click three
sprints later. Resolve then key.

## Details

- **Storage.** One route per test, so a column or a small `test_memory` table
  keyed by `test_id` — not a row per run. It is a cache, and it must be
  droppable without touching history. The blob rule holds: metadata in the DB,
  nothing that belongs on disk.
- **Visible, and refusable.** The run feed says *4 steps replayed from memory*,
  and there is a way to force a cold run — per run, and as a test setting. A
  cache the user cannot see or turn off is a cache they will blame for
  everything.
- **Cold cadence for schedules.** A scheduled test runs cold on a fixed cadence
  (weekly is the shape to start from), so the discovery path is tested too. The
  cadence is a decision to record here with its reasoning, not a constant to
  bury.
- **Off by default until measured.** Same posture as US-061: ship behind a flag,
  measure, then argue for the default with the numbers in hand.

## Acceptance criteria

- [ ] With memory off, runs are byte-for-byte today's behaviour — no stored
      route read, no prompt difference, no preamble
- [ ] A second run of an unchanged, passing test replays a prefix and reports
      how many steps it replayed
- [ ] Editing goal, start_url, model, a variable, a fixture, the preamble or the
      navigation policy drops the route — asserted per input, against the
      *resolved* values rather than the test row
- [ ] A route whose element cannot be matched on the fresh page falls back to
      the LLM from that step and the run still finishes; the route is dropped
- [ ] Replay never matches on the browser-use element index — asserted with a
      fixture whose DOM shifts the index while keeping the target
- [ ] A regression introduced *inside* the replayed prefix still fails the run —
      the hostile case, asserted, not reasoned about
- [ ] Over the fixture suite, cold vs warm: duration, steps, cost and **verdict
      agreement**, recorded in this file with a stated recommendation
- [ ] `cd agent && .venv/bin/python -m pytest` covers the match rules and the
      prefix cut as pure functions

## Correctness-critical

**Yes**, and it owes a row in
[`correctness-critical.md`](../correctness-critical.md) when the work starts.
The failure shape is new to the register: not a leak outward and not a wrong
verdict from a bad judge, but a *cached decision from a previous run* deciding
what the current run does. It is silent by construction — a wrong replay
produces a plausible run, not an error — and it is exactly the assertion-first
class. The invalidation key and the match order get reviewed assertions before
either implementation exists, per the Workflow rule in `CLAUDE.md`.

## Notes

- US-050 is the sibling, not a competitor: it makes each step cheaper, this one
  removes steps, and both are only defensible once US-046 makes the bill
  visible. Run their measurements over the same fixture suite so the two
  savings are additive on paper as well as in argument.
- If [US-049](US-049-typed-assertions.md) lands first, "the step this test is
  asserting" stops being a guess from `next_goal` text and becomes a structured
  fact, which makes the tier 2 cut-off honest rather than heuristic.
