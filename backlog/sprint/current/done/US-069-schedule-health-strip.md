# US-069 — The last few nights, at a glance

**As** someone with a nightly `checkout` schedule and an hourly smoke test,
**I want** each row on the Schedules page to carry a strip of its recent
results, **so that** "is my unattended testing healthy?" is answered by opening
one page instead of filtering History four times.

- **Status:** ✅ **Done** 2026-08-04 — raised into `unscheduled/`, scheduled,
  built and closed the same day. 11 of 12 criteria; the twelfth is met
  server-side rather than where it was written, for the reason under it.
- **Priority:** P3
- **Estimate:** ~a day (migration + one column threaded through the tick + a
  second query on the list route + the existing `Timeline` made reusable +
  tests). Actual: one day, and the estimate held.
- **Depends on:** [US-010](US-010-scheduled-runs.md) (schedules exist),
  [US-011](US-011-run-history.md) (the runs table and the strip it already
  draws)

## What exists today

Two halves that have never met.

The strip itself is **already written**: `Timeline` in
`frontend/src/HistoryView.jsx:270` draws one `.tl-bar` per run, oldest left,
coloured from `statusColor` (`status.js`), with a pass-rate line above it. It is
scoped to one test, charts the runs already in the list rather than fetching its
own window, and is reachable only from History after picking a test.

The Schedules row (`SchedulesView.jsx:207`) shows what a schedule *will* do —
the preset in words, `next_run_at`, "in 4h" — plus one thing that already
happened: `· last <when>`. That is a timestamp, not a verdict. A schedule that
has failed every night for a week and one that has passed every night render
identically.

Closing the gap needs something neither half has: **a run does not know which
schedule started it.** `runs` carries `trigger in ('ui','api','schedule','ci')`
and `test_id`, and nothing else (`001_init.sql:99`). So today:

- An hourly smoke schedule and a nightly regression schedule pointing at the
  same test produce runs that are indistinguishable from each other.
- A schedule on a suite fires N runs in one slot with nothing tying them into
  one slot.
- Resolving the target's tests *now* and matching `trigger='schedule'` runs
  against them mis-attributes every run made before a member joined or left the
  target — and the whole point of the strip is the older end of it.

So the story's real work is attribution, and the drawing is the easy part.

## The decisions this story has to make

**`runs` gains `schedule_id`, and the slot it fired for.** Two columns, not
one. `schedule_id` answers *which schedule*; `scheduled_for` answers *which
firing*, so a suite's ten runs collapse into one mark by grouping on an exact
timestamp rather than on a time window. The tick already holds both values —
`schedule.id` and its injectable `now` (`scheduler.js:tick`) — so this is
threading a value that exists, not deriving one. Bucketing on `created_at`
instead would work until a slow enqueue straddles a second boundary, which is
the kind of bug that appears once a month on a busy box and never in a test.

**One bar is one slot, and its verdict is the worst member.** A ten-test suite
must not out-weigh a one-test schedule in a strip the same width, and "last
night went fine" is false if one of ten failed. That makes the collapse a
precedence order over seven statuses, which is the part of this story most
likely to be wrong in a way nobody notices — see *Correctness* below.

**A slot that started nothing is not a gap.** This is the part a naive strip
built on `runs` gets wrong, and it matters more than the happy path. The tick
has five distinct ways to consume a slot and write **no run row at all** —
`empty` (target has no tests), `unstarted` (a member refused: unresolvable
secret, undecryptable session, navigation fence), `blocked` (no subscription),
`pending` (activation window), `keyless` (owner has no OpenAI key). Each is
currently a line in a log read by nobody at 3am. A strip that renders these as
absence tells the reader their schedule is fine when it has not run for a week.

The honest fix is out of proportion to this story — it means a `schedule_slots`
table, or the tick writing skip rows. **So this story states the limitation
rather than papering over it**: the strip charts slots that produced runs, and
the row keeps carrying `last_run_at`, which is exactly the tell `docs/api.md`
already documents ("a schedule whose `next_run_at` keeps moving while
`last_run_at` stays put is one that is firing into nothing"). Make that tell
*visible* — a `row-tag warn` when `last_run_at` is older than the last slot the
preset should have hit — and leave the full slot ledger to a follow-up. The
existing `target_tests === 0` → "no tests" tag is the precedent for exactly this
shape of warning.

Two things that only showed up in the writing. `schedule.js` had no
previous-slot function — `nextSlot` walks one way only — so `prevSlot` is new,
and it is the same local-calendar walk reversed rather than a subtraction, for
the DST reason its sibling already carries. And the slot to measure against is
the one before **`next_run_at`**, not the one before *now*: the claim has
certainly been through it, so no grace period is needed for the seconds between
a slot arriving and the tick reaching it. `firesIntoNothing` also has to
exclude a slot older than the schedule's own `created_at`, or every schedule
wears the tag on the day it is made.

## Details

- `019_schedule_run_attribution.sql`:
  - `runs.schedule_id uuid references schedules(id) on delete set null` —
    **set null, not cascade**. Deleting a schedule must not delete the history
    of what it found, the same call `runs.test_id` already makes.
  - `runs.scheduled_for timestamptz` — null for every non-scheduled run.
  - `create index runs_schedule_idx on runs (schedule_id, scheduled_for desc)
    where schedule_id is not null` — the strip's only query. Partial, so it
    stays small next to a table that is mostly UI runs. **Verify this one
    against real Postgres**: pg-mem returns wrong rows from partial indexes
    (`docs/testing.md`), so a test that only ever ran there proves nothing
    about it.
  - Both columns are inert on the day they land — existing rows get null and
    the strip shows nothing until the first tick after deploy. Say so in the
    migration comment; a feature that looks broken for one night otherwise
    reads as a bug.
- `scheduler.js`: pass `schedule_id: schedule.id, scheduled_for:
  schedule.next_run_at` into the `runTests` opts already carrying
  `trigger: 'schedule'`. **`next_run_at`, not `now`** — corrected while
  implementing: `claim` advances the row but not the in-memory copy, so this
  still holds the boundary the schedule was due at. `now` is when the tick got
  round to it, which labels a slot 02:00:07 and puts a whole backlog of missed
  nights under the morning a downed box came back
  (`scheduler.js`, the `runTests(ready, {...})` call). `runs.js:runTests` hands
  them to `createRun`, which adds them to its insert
  (`runs.js:209`). Nothing else calls this path, so no other trigger can set
  them by accident.
- `GET /api/schedules` gains `recent`: an array of at most N slots per schedule,
  newest first, each `{ scheduled_for, status, runs, failed }`.
  - A **second query in the same handler**, not a join into `LIST_QUERY`. That
    query is already carrying four grouped derived tables to work around
    pg-mem's inability to see an outer alias from a subquery
    (`routes/schedules.js`), and a per-row top-N is a lateral join, which is
    the same trap one step further in.
  - `where schedule_id in ($1, $2, …)` with generated placeholders, **not
    `= any($1)`** — pg-mem does not bind array parameters, and `activeTestIds`
    in `scheduler.js` is the existing pattern for exactly this.
  - Skip the query entirely when the list is empty, so a fresh install still
    answers in one round trip.
  - N is a server constant, not a query parameter. Twenty or so — enough to see
    a pattern, small enough that the payload stays a list response.
- Frontend:
  - Lift `Timeline` out of `HistoryView.jsx` into its own module, taking marks
    rather than runs, so History's per-run strip and this per-slot strip are one
    component. Two strips disagreeing about what red means is the bug this
    avoids, and `status.js` already exists to stop that happening in colour.
  - A slot bar's tooltip names the slot time and the tally — "3 Aug, 02:00 —
    1 of 8 failed". Clicking it opens History filtered to that schedule, which
    needs `GET /api/runs` to accept `?schedule_id=` (one more clause in
    `buildFilters`, `routes/runs.js`, next to `?test_id=`).
  - A schedule with no attributed slots yet renders no strip at all, not an
    empty one — the same choice `Timeline` already makes (`if (!runs.length)
    return null`).
  - **Phone.** `sched-list` exists because that row already holds more than a
    phone fits side by side (`frontend/CLAUDE.md`, US-067). The strip goes on
    its own line under the row, full width, tooltips replaced by the tap →
    History path; it must not compete with the three action buttons for the
    same line.
- `docs/api.md`: the `recent` array on the schedule object, `?schedule_id=` on
  `GET /api/runs`, and one line under Schedules on what a bar is (a slot, not a
  run) and what it cannot show (a slot that started nothing).

## Correctness

**The slot collapse is correctness-critical** — ruled 2026-08-04 by the
maintainer, on the argument below, and it now holds a row in
`correctness-critical.md`.

The argument for, which carried it: the input is seven statuses (`queued`,
`running`, `passed`, `failed`, `completed`, `error`, `cancelled`) crossed with a
nullable `success`,
collapsed into one colour, and every wrong answer fails in the same direction —
**green**. A slot of nine passes and one error reading green is a false all-clear
on the page whose entire purpose is to raise the alarm, and it is invisible:
nothing downstream contradicts it, no test fails, and the reader's conclusion is
"fine". The neighbouring cases are each individually reasonable and collectively
a mess — a still-running member, a stopped one (US-047), a `completed` one with
no verdict — and there is no obvious right answer to any of them that a
written-alongside test would not simply ratify.

The argument against, which did not: it is display aggregation, not billing or
secrets or slot math.

The collapse is a **pure function in its own module** with the precedence order
written down as data, not an inline ternary in JSX. The order that shipped:
`error > failed > running > queued > cancelled > completed > passed`, with an
unknown status sorting worst. Outcomes beat in-flight members, an unfinished
slot never gets a settled-looking colour, and green needs every member.

**What the ruling does not claim.** The assertion-first order was *not* followed
here. The implementation and its tests landed in one sitting, so
`server/test/slot-verdict.test.js` ratifies the precedence rather than having
specified it, and the maintainer confirmed the order after the fact rather than
before. The row is added anyway, because the register's job is to say which
surfaces owe the discipline *next time* — the collapse escalates on its next
change, the same footing as the five other test-alongside rows.

## Acceptance criteria

- [x] A run started by the tick records the schedule that started it and the
      slot it fired for; a UI, API or CI run records neither
- [x] Two schedules pointing at the same test produce strips that differ
- [x] A suite schedule's slot is one bar however many tests it ran, and the bar
      is red if any member failed or errored
- [x] A slot where every member passed is green; a slot still in flight reads as
      running, not as passed
- [x] Deleting a schedule leaves its runs in History and takes only the strip
- [x] Runs that predate the migration are absent from the strip and break
      nothing — a schedule with only such runs shows no strip, not an empty one
- [x] A schedule whose slots are firing into nothing is marked on the row, and
      is distinguishable from one that has genuinely never been due
- [x] Clicking a bar opens History filtered to that schedule, and
      `GET /api/runs?schedule_id=` rejects a non-uuid with 400
- [x] The list route makes one extra query for the whole page, not one per
      schedule, and none at all when there are no schedules
- [x] The strip drops below the row on a phone and does not crowd the actions
- [x] `cd server && npm test` covers the attribution and the collapse; the
      migration and its partial index are exercised against real Postgres
- [ ] `cd frontend && npm test` covers the collapse function's precedence
      directly, not only through a rendered row — **not as written**: the
      collapse ended up server-side, because `recent[].status` is part of the
      API response and a second copy of the rule on the client is the drift
      this story exists to prevent. Its precedence is asserted directly in
      `server/test/slot-verdict.test.js`; the frontend covers the mapping from
      a slot to a bar (`Timeline.test.jsx`)

## Results

Shipped 2026-08-04 across two commits: the feature (`f3a6267`) and a visual
revision the day it landed (`d3fae0e`).

- **Migration 019 is inert on arrival.** Existing rows get null in both new
  columns, so no strip appears until the first tick after deploy. That is a
  night of a feature looking broken, and the migration comment says so.
- **The strip fills its row.** The ticks first shipped at a fixed `--s15`
  anchored to the right edge, which left most of a wide row empty and read as a
  fragment. They now share the width they are given, one rule serving History
  and a schedule row. Measured in Chromium against the real stylesheets: a
  25-run strip draws 24px ticks at 1280px and 7.6px at 360px, with no overflow
  at any width and no wrap. Below the 600px breakpoint the *gap* drops to
  `--s05` — at `--s1` it was as wide as the tick beside it and the strip read as
  a dotted line. A ~7px tick is still under a comfortable touch target; fixing
  that means charting fewer bars on a phone, which is its own decision.
- **History lost its caption with the same change.** "5/7 passed in this page"
  counted the page rather than the test, so the number moved with the paging
  controls instead of with anything the reader was looking at, and the strip's
  own colours already answer it. "Oldest" went too — the bars read left to right
  and only the far end needs naming.
- **Two pg-mem traps, both silent**, now recorded in `docs/testing.md`'s terms:
  `row_number() over (…)` is rejected outright, and `count(*) filter (where …)`
  answers with the **unfiltered** count — which would have put a clean tally
  under a failed slot. The partial index went to a real Postgres test for the
  reason the Details section predicted.

## Notes

- **This adds no new run states and changes no verdict.** Every colour on the
  strip is one `runs.status` already renders elsewhere; the only new thing is
  the rule for turning several of them into one.
- **`last_run_at` stays on the schedule and stays authoritative.** It is written
  by `stampRun` only when something actually started (BUG-006), which is a
  different question from what the runs say afterwards, and the strip does not
  replace it.
- The full slot ledger — every fire, including the ones that started nothing,
  with the tick's reason attached — is the natural follow-up and is deliberately
  not this story. It would make the five silent-skip counters in `tick()`
  visible in the product rather than only in the log, and it wants its own
  table.
- Not a dashboard. One strip per existing row, on a page that already exists; an
  aggregate "how is everything doing" view is a different story with a different
  audience.
