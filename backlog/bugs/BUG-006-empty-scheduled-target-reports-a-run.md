# BUG-006 — A schedule whose target has no tests reports that it ran

- **Status:** 🐛 Open — found 2026-07-28 while answering "what happens to a
  schedule if we edit the test it runs?". The answer there is reassuring — a
  schedule stores a foreign key, never a copy, so every fire re-reads the live
  row (`scheduler.js:30`) and an edit lands on the next slot. This is the case
  where that same indirection goes quiet instead.
- **Lives in:** `server/src/scheduler.js` (`claim`, and the empty-target
  `continue` at `:210`) + `frontend/src/SchedulesView.jsx:225`
- **Severity:** a schedule that has silently stopped testing anything is
  indistinguishable, on the only screen that shows schedules, from one that ran
  minutes ago and passed. Sibling of
  [BUG-005](../sprint/current/done/BUG-005-scheduler-counts-unstarted-members-as-runs.md): that one
  overstates a batch that partly started, this one reports a batch that never
  existed.

## What happens

A schedule points at a module, suite or project — not at a list of tests. So
the membership is resolved at fire time, and it can resolve to nothing: move
every test out of a scheduled module, delete the last test in a suite, or
schedule a project before filling it, and the target still exists while being
empty.

The tick then does this, in this order:

```js
if (!(await claim(schedule, now))) { ... }   // :159 — writes last_run_at = now
...
const { label, tests } = await testsOf(schedule);
if (!tests.length) {                          // :210
  console.log(`schedule ...: ${label} has no tests — nothing to run`);
  continue;                                   // before fired++ at :218
}
```

`claim` advances `next_run_at` **and** stamps `last_run_at = now` in one
statement (`:110-115`), because both are part of taking the slot. But whether
anything is there to run is only discovered afterwards. So the row now says it
ran, and `SchedulesView` prints exactly that:

```
Tonight at 2:00 AM · in 6 hours · last 2:00 AM
```

Nothing contradicts it. There is no run row, so History, Activity and the
failure email have nothing to report — and every one of those channels is
silent on a good night too, which is what makes the silence unreadable. The
single `console.log` is server-side, and the operator reading the UI is not
reading Docker logs.

Two things are deliberately **not** wrong here, and a fix must not "correct"
them:

- **`fired` is honest.** The `continue` precedes `fired++`, so the tick's
  returned `{fired, runs, ...}` already excludes empty targets. The lie is in
  the persisted `last_run_at`, not in the tally.
- **Claiming before checking is correct.** The claim-then-decide order is what
  makes a crash skip one slot instead of re-firing forever (`:92-104`), and a
  run costs real tokens. The bug is that one field rode along with the claim
  that describes an outcome, not the claim.

Note that the same stamp is written on the `blocked`, `pending` and `keyless`
skips too. Those at least have counters and their own log lines, so they are
legible from the server; they share the misleading `last …` in the UI.

## Why it survived

US-010 shipped when a schedule was something you made right after making the
tests, so an empty target was a state you had to work to reach. US-023's
grouping is what made it routine: reorganising tests between modules is normal
housekeeping, and it can empty a scheduled target without ever touching the
schedule. `last_run_at` was already meaningful by then — `SchedulesView`'s own
comment says the target is fixed at creation "so that `last_run_at` keeps
meaning what it says" (`:276`) — so the field was being defended for exactly
the property this breaks.

## Fix

Two parts, and the first is most of the value:

1. **Stamp `last_run_at` when something actually starts, not when the slot is
   taken.** `claim` keeps writing `next_run_at` alone — that is the field the
   re-fire guard reads (`where ... next_run_at <= $3`), so the claim stays
   atomic and the crash-skip property is untouched. `last_run_at` becomes a
   second write after `runTests` returns at least one `{runId}`. Then the page
   reads `last 4 months ago` next to `next 2:00 AM`, and the gap is the tell.
2. **Say so on the schedules page.** `LIST_QUERY`
   (`routes/schedules.js:29-42`) already left-joins all four target tables to
   resolve `target_name`; a test count per target joins in the same place. A
   schedule whose target holds zero tests gets a warning affordance on its row
   — it is a misconfiguration, not a failure, so it wants the tone of a notice
   rather than an error.

An `empty` counter in the tick's returned shape is worth adding alongside
BUG-005's `unstarted` counter (fixed 2026-07-28 — it landed as one counter, not
the `error`/`rejected` pair this proposal assumed, because a cap refusal cannot
reach a schedule), for whoever is watching the logs. Do
**not** self-disable the schedule: the target is usually empty by accident and
for a few minutes, and a schedule that switched itself off would be a second
silent failure on top of the first.

## Guarded by

`server/test/scheduler.test.js` — pg-mem is adequate for the tally and the
skip; the `last_run_at` write wants
`server/test/scheduler-postgres.test.js`, since it is the claim statement being
split and that row is on the correctness-critical register.

Cases: a schedule on an empty module leaves `last_run_at` unchanged while
`next_run_at` still advances (both halves — the second is what proves the slot
was consumed and no backlog accrues); a schedule that does start a run stamps
it; a target emptied between two ticks stops advancing `last_run_at` from the
tick it was emptied on; and the list endpoint reports zero tests for that
target.

⚠️ **Assertion-first** (`CLAUDE.md`): part 1 edits `claim`, which is the
"Scheduler claim" row in
[`correctness-critical.md`](../correctness-critical.md). Splitting a
single-statement claim is precisely the shape of change that register exists
for — the assertion gets written and reviewed before the implementation.
Part 2 is ordinary view work and goes test-alongside.
