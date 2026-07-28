# BUG-005 — A scheduled member that never started is counted as a run

- **Status:** 🐛 Open — found 2026-07-28 while answering "during a run using the
  scheduler, what about the secret variables?". The secrets gap itself is
  [US-064](../sprint/current/US-064-secret-variables-in-a-scheduled-run.md); this
  is the reason that gap, and three others, are silent.
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
