# BUG-005 — A scheduled member that never started is counted as a run

- **Status:** ✅ Fixed 2026-07-28 — found the same day while answering "during a
  run using the scheduler, what about the secret variables?". The secrets gap
  itself is [US-064](US-064-secret-variables-in-a-scheduled-run.md);
  this is the reason that gap, and three others, are silent. Fixed first because
  US-064's "starts no run **and says so**" assertion cannot be written until the
  tick can say it. See "Result".
- **Lives in:** `server/src/scheduler.js` (`tick`, the tally after `runTests`)
- **Severity:** the run count a scheduler tick reports, and the log line an
  operator reads, both overstate what happened. A schedule that has stopped
  producing runs looks like a schedule that is working.

## What happens

`runTests` returns one marker per member, and four of them mean "no run
started": `{error}` (a variable that cannot resolve, or a session that cannot be
decrypted — `runs.js:434` and `:441`), `{blocked}` (the navigation fence),
`{rejected}` (over the concurrency cap), against `{runId}` for a real start.

The tick accounts for exactly one of the four:

```js
const confined = started.filter((m) => 'blocked' in m);
runs += started.length - confined.length;
```

So an `{error}` or `{rejected}` member is counted in `runs`, and the log line
below it — which names confined members deliberately, because "a schedule fires
with nobody watching" (the comment at `scheduler.js:241`) — says nothing about
them. A suite of three where one needs a secret logs:

```
schedule abc12345: suite def67890 → 3 run(s)
```

and produces two. There is no run row for the third, so nothing in history,
Activity or a failure email contradicts the log. The returned
`{fired, runs, skipped, blocked, pending, keyless}` is wrong in the same way,
which is what the scheduler tests assert on.

## Why it survived

Each non-start marker arrived with the story that introduced it — US-035's
`{error}`, US-028's `{rejected}`, US-042's `{blocked}` — and only the last one
was added while the scheduler's tally was in view. The HTTP paths hand every
marker back to a caller who is looking at the response, so the scheduler is the
one place where an unhandled marker becomes silence.

## Fix

Partition `started` by outcome rather than filtering one case out of it: count
only `{runId}` members as runs, and log every non-start by test id with its
reason, the way confined members already are. `{error}` and `{rejected}` want
their own counters in the returned shape too — a batch shedding members to the
cap is a capacity signal and should not be readable as a misconfigured test.

## Guarded by

`server/test/scheduler.test.js` — pg-mem is fine here, nothing about this needs
real Postgres semantics. A case per marker: a member whose required variable is
missing, one refused by the cap, one confined, and the mixed batch where the
tally must equal the number of run rows actually written.

## Result

Fixed in `scheduler.js`'s tally. Two things above were wrong, and both narrowed
the change:

**`{rejected}` cannot reach the scheduler.** `createRun` bypasses admission when
`trigger === 'schedule'` (`runs.js:335`) — a schedule fires with no human
watching, so a member is never dropped for the cap; it queues past it and
`canStart`/`startNext` hold it to `cap` running. So there are three reachable
markers, not four, and only two of them are non-starts: `{error}` and
`{blocked}`. The cap counter this file asked for would have been dead code, and
the capacity-signal argument for keeping it distinct from a misconfigured test
falls with it. (`concurrency-fairshare.test.js` already asserts a schedule is
never rejected, which is why nothing here noticed.)

**One counter, not two.** The two reachable non-starts are the same thing to the
operator — a target that is misconfigured today and will not fix itself — so
they share `unstarted` in the returned `{fired, runs, skipped, unstarted,
blocked, pending, keyless}`. Distinct from `skipped` (a sibling still running,
which runs next slot) and from `blocked` (a whole schedule the billing gate
declined). ⚠️ [BUG-006](BUG-006-empty-scheduled-target-reports-a-run.md) proposed
an `empty` counter "alongside BUG-005's `error`/`rejected` counters" — those two
are this one, so `empty` joined a shape with `unstarted` already in it (fixed
2026-07-28; the shape now carries both). It counts a target with no members at
all, where `unstarted` counts a member that was there and would not start.

The partition is on what a run **is** (`'runId' in m`), not on the marker kinds
known today, and every non-start is now logged by test id with its reason —
which is what stops the next marker being silent the way these were. That is the
actual lesson of "Why it survived": the tick enumerated the markers it knew.

Three cases in `scheduler.test.js` (unresolvable variable, fence-confined, and
the mixed batch asserting `result.runs === rows.length`), all three confirmed
red against the pre-fix `scheduler.js` before being taken as green.
