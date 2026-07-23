# Testing philosophy

Why the tests look the way they do, what we deliberately don't test, and the
one thing that changes when the code is written by an AI pair rather than a
second human. Operational how-to (which command, where the harness is) lives in
CLAUDE.md's "Run / develop"; this file is the *why*.

## What we practice

**Spec-driven, test-alongside.** A `backlog/US-xxx` story is the contract, with
its rationale written down before the code. The test ships in the same commit
as the feature it covers — not test-first (red-green-refactor), and not
test-later either. Every server test file traces to a story: `control-plane`
→ US-009, `scheduler`/`schedules-api` → US-010, `queue` → US-027. The story
says *what* and *why*; the test proves the *what* holds.

**The fastest fake that still catches the bug you care about.** This is the
rule that decides which of the four test shapes a given check gets:

- *Pure unit* (`schedule.test.js`, `agent/tests/test_email_codes.py`) — logic
  that needs no world. No db, no app, no clock, no browser. Each case carries
  its own input. These run in milliseconds and are where most assertions
  should live.
- *In-process integration* (`api.test.js`, `schedules-api.test.js`) — the real
  Express app over supertest, with the Python agent/report scripts replaced by
  Node stubs speaking the same NDJSON/argv protocol. Tests everything except
  the browser, which these cases don't care about.
- *pg-mem control-plane* (`control-plane.test.js`, `scheduler.test.js`) — real
  migrations against an in-memory Postgres stand-in. Fast, no server needed,
  good enough for *our* SQL logic.
- *Real Postgres* (`scheduler-postgres.test.js`) — the exception, for
  correctness that depends on the database's own semantics. pg-mem stores
  millisecond timestamps and fakes partial indexes, which *hides* the exact
  bug there: a `where next_run_at = $1` claim that could never match the
  microsecond value real Postgres wrote. When the property under test is the
  fake's blind spot, you need the real thing.

That last pair is the whole philosophy in miniature: **same feature, two
tests, because the shortcut one layer takes lies about the thing the other
must verify.** Use the fake by default; drop to reality only for the specific
property the fake gets wrong.

**Speed and hermeticity are features, not niceties.** The suites are fast and
need no network, browser, or live services on purpose. Partly for CI, but
mostly because a fast hermetic suite is what lets the AI run the whole thing
after every change and self-correct without a human in the loop. A slow or
flaky suite breaks that loop — it gets skipped, or a green run gets trusted
that shouldn't be. The stub-the-agent / pg-mem discipline pays for itself
twice over here.

## What we don't test (and why that's a choice, not neglect)

- **The browser-driving agent core.** Every server test stubs `run_agent.py`.
  Launching a real Chromium + LLM per test is slow, flaky, and costs tokens.
  The first agent-side coverage reaches only the pure parsing in
  `email_codes.py`. Closing the rest — the `scrub()` redaction, the report
  formatters, and a *recorded-fixture* run through the pass/fail judge (a
  canned NDJSON transcript, no browser) — is US-034.
- **Rendered frontend components.** `status.js` helpers are unit-tested; a
  jsdom render-smoke test is deferred to US-034 because it needs a fetch/router
  harness the pure helpers don't.
- **A full end-to-end (real browser + real LLM).** Not planned. The
  recorded-fixture approach buys most of the confidence with none of the
  flake or spend.

## Working with an AI pair changes one thing

With two humans, the person who writes the test and the person who writes the
code usually derive "the right answer" independently, so a shared
misunderstanding has two chances to get caught. When the AI writes **both**
the test and the implementation, that independence is gone. The failure mode
that follows is specific:

> A test authored to match code authored by the same mind can encode one
> misunderstanding twice — the test asserts exactly the wrong thing the code
> does — and worse, a failing test can be "fixed" by quietly weakening the
> assertion instead of the code.

The mitigations, roughly by leverage:

1. **Anchor the expected value to intent, not to the implementation.** An
   assertion is trustworthy when a human can read the *input* and agree the
   *expected output* is right without ever seeing the code —
   `extract_code("Your code is below\n\n482913", ...) == "482913"` passes that
   bar. A test that *recomputes* the expected value the same way the code does
   proves nothing. Human-checkable literals over re-derived ones.
2. **See it fail.** A test you've never watched fail is not trusted. TDD gets
   this for free (the test fails before the code exists). Test-alongside does
   not, so we bolt it on: deliberately break the code and confirm the test goes
   red. The systematic form is mutation testing.
3. **Test against the real thing, not the AI's fake.** A fake the same author
   controls will agree with buggy code — this is *why* the pg-mem/Postgres
   split earned its keep, and why the agent judge wants a recorded real
   transcript over an invented one.
4. **Selective TDD for the correctness-critical, easy-to-get-subtly-wrong
   pieces** — scheduler claim, slot math, redaction, billing gates. There, the
   human writes or tightens the assertion *first*, reviews it, then the AI
   implements against it. The test becomes a spec the implementation can't
   retrofit. Not the whole codebase — CRUD and wiring stay test-alongside.
5. **The house rule:** *a red test is fixed in the code, not the assertion*
   (CLAUDE.md, Workflow rules). Expected values change only when the behaviour
   was *meant* to change, and the commit says which and why. This forces every
   code-vs-test disagreement up to intent instead of letting it be settled by
   editing whichever side is easier.

None of these removes the risk alone; each one re-introduces an *independent*
source of truth — a human, the spec, reality, a mutation — to break the
correlation.

### What a mutation sweep does and doesn't tell you

On 2026-07-24 a manual red-first sweep over the two new suites seeded ten
one-line defects (widen a digit cap, drop a guard, mis-map a token, …) and
confirmed all ten were caught. That proves *sensitivity*: no test passes no
matter what, no assertion is silently weak — exactly the AI-pair failure mode
above. It does **not** prove the expected values are the ones we want: a test
can kill every mutant and still pin the wrong intended behaviour if the author
misread the spec. Mutation testing checks "does a test react to change,"
correctness of the target answer is still on the human and the story.
(`scratchpad/mutsweep.py` was the throwaway driver; automating this with
`mutmut` for the agent is a US-034 item.)

## Where this should go next

Tracked in [US-034](../backlog/unscheduled/US-034-testing-practice-and-coverage.md):
the owed agent coverage (redaction refactor + test, report formatters, judge
fixture), the frontend component smoke test, `mutmut` for a repeatable agent
mutation audit, and promoting selective TDD from "practised on the hard bits"
to a documented habit once it has earned it.
