# BUG-007 — The server suite fails intermittently, on a different test each time

- **Status:** 🐛 Open — found 2026-07-28 while verifying
  [BUG-006](../sprint/current/done/BUG-006-empty-scheduled-target-reports-a-run.md).
  It reproduces on a clean `dev` with that work stashed, so it is older than
  the change that surfaced it.
- **Lives in:** the test harness rather than the product —
  `server/package.json:14` (`node --test 'test/**/*.test.js'`), the wall-clock
  holds in `server/test/stubs/fake_agent.js:90-95`, and the `pollUntil` helper
  copied into 29 of the 60 test files.
- **Severity:** high for how we work, zero for a user. `CLAUDE.md` says CI does
  **not** run on a push to `dev` — only on a PR into it — so `npm test` locally
  is the load-bearing gate, not a courtesy. A suite that fails for reasons
  unrelated to the change trains us to re-run until green, and re-running until
  green is exactly how a real regression gets waved through. `docs/testing.md`
  already names the stake: "a fast hermetic suite is what lets the AI run the
  whole thing after every change and self-correct without a human in the loop. A
  slow or flaky suite breaks that loop — it gets skipped, or a green run gets
  trusted that shouldn't be."

## What happens

Roughly one full run in four or five fails, and **almost never on the same
test twice**. Five distinct names seen over ~13 runs on 2026-07-28, at most one
per run:

- `P-fair (dequeue): a freed slot is left idle rather than promoting an at-cap user`
  (`concurrency-fairshare.test.js`)
- `a session can be created empty and filled by its login test`
  (`session-containment.test.js`)
- `the paste endpoint stores ciphertext and answers with metadata only` (same file)
- `a passing login run refreshes the session it belongs to` (same file)
- `a resolved run key reaches only the child env, and the request key beats the
  stored one`

Only one was captured with its error text, and it is the informative one:

```
not ok 204 - P-fair (dequeue): a freed slot is left idle rather than promoting an at-cap user
  error: 'pollUntil: timed out'
```

That test starts three stub runs holding 4000ms and one holding 250ms, then
polls up to **8000ms** for the short one's slot to free. Timing out means a
250ms child process did not finish inside eight seconds.

## Why

`node --test` runs the 60 test files **in parallel**, roughly one worker per
core (8 here). Many of those files spawn stub agent child processes, and
`fake_agent.js` implements a hold as real wall-clock `setTimeout`. So the
suite's timing assumptions are written in wall-clock milliseconds while the
machine running them is oversubscribed by its own test runner. Under a bad
scheduling draw a child is starved long past its hold, the poll deadline
expires, and whichever test drew the short straw that run is the one that
fails.

This also explains the shape of the evidence — different test each time, never
two at once, and no correlation with the change under test.

**Not yet confirmed for all five.** The four non-`P-fair` failures were seen
but not captured with their error text, and one of them — the paste endpoint —
does no polling and no spawning at all, so it may be a second, unrelated cause.
Capture the text before assuming one diagnosis covers everything.

## Fix

Two directions, and they are not exclusive:

1. **Stop the suite from oversubscribing itself.** `--test-concurrency` bounds
   the parallel file count. Measured on the 8-core dev box, 2026-07-28:

   | | wall | CPU | result |
   |---|---|---|---|
   | `npm test` (parallel) | 29s | 2m00s | 1 failure in 6 runs |
   | `--test-concurrency=1` | 1m51s | 1m24s | clean (n=1) |

   Note the CPU column: the same 632 tests cost **43% more CPU** run in
   parallel, which is the contention tax made visible — and the reason a
   250ms child can miss an 8s deadline. But serial is 3.8× the wall-clock, and
   the suite being fast is itself load-bearing, so the answer is probably a
   bounded concurrency rather than 1. One clean serial run is not proof;
   it is one sample that fits the diagnosis.
2. **Stop the timing-sensitive tests depending on wall-clock at all.** The
   queue and fair-share tests are asserting an *ordering* — who gets a freed
   slot — and expressing it in sleeps is what makes them hostage to load. A
   stub that frees its slot on a signal rather than a timer would make them
   exact.

⚠️ **What a fix must not do: raise the timeouts.** `P-fair (dequeue)` guards
the fair-share dequeue scan, and concurrency/fair-share is on
[`correctness-critical.md`](../correctness-critical.md). The distinction
between *this test timed out* and *this test observed the wrong promotion* is
the signal — a genuinely wrong dequeue fails the `deepEqual` on the line after
the poll, not the poll. Widening the deadline would hide the second failure
mode inside the first, on the surface where that matters most. Same reasoning
as the assertion-first rule: do not loosen an assertion to reach green.

## Guarded by

Awkward by nature — the property is "green means green", which no single
assertion states. The honest check is the one used to find it: run the whole
suite N times and count. Before/after that number is the evidence a fix worked.
