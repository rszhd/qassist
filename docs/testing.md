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

  Another blind spot, found by US-039: **pg-mem corrupts a `bytea`
  parameter.** The adapter squeezes the buffer through a UTF-8 string, so
  AES-GCM ciphertext (high bytes) comes back with replacement characters and
  never decrypts — an encrypted-at-rest write path simply cannot be exercised
  there (`byok-postgres.test.js` is the real-server counterpart). The escape
  hatch for tests whose subject is *not* key storage: a **registered function
  returns a Buffer that pg-mem stores intact**, so
  `test/helpers/stored-key.js` seeds a decryptable stored key by registering
  `decode` and inlining the ciphertext as hex in the SQL text. `byteaPool` in
  the same file does that rewrite for the parameters *product* code passes,
  which is what lets an encrypted-at-rest write path be exercised there at all.

  BUG-007 added the sting in the tail: **that corruption is not always
  silent.** The escaped string the adapter builds is sometimes SQL pg-mem's own
  parser rejects — 1.6% of AES-GCM ciphertexts at 213 bytes — and whether it is
  depends on nothing but the random IV. So the same write is fine ninety-eight
  times and throws the ninety-ninth, which reads as a flaky suite rather than as
  a fake being a fake. Worse, pg-mem's parse error enumerates the tokens it
  expected, one of which is `kw_unique`, so a route with a
  `/unique|duplicate/i` fallback on the message answers **409 Conflict** for a
  name nothing has ever used. A fake's blind spot can present as any error the
  product knows how to make.

  A third blind spot is not the database at all, found by BUG-006: **pg-mem
  never runs node-pg's type parsers.** `count(*)` is bigint, and node-pg hands
  bigint back as a *string* — so an uncast count is `0` under pg-mem and `"0"`
  in production, and a `=== 0` check downstream silently never matches. The fix
  is `::int` in the SQL; the point is that no pg-mem test can ever fail on it,
  because the value never passes through the driver that makes it a string.
  Anything whose correctness depends on the *type* a column arrives as — bigint
  counts, numerics, dates as strings — is in this class.

  Four more, each found the same way — by writing the assertion first and
  watching it pass against code that could not possibly be right:

  - **An uncast `text[]` default comes back as the *string* `"{}"`** (US-042).
    An allowlist that arrives as a string matches nothing, which is precisely
    the failure the feature exists to prevent: a fence that is believed and
    absent. Same class as the bigint above — the column's *type* on arrival.
  - **`on conflict do nothing` reports `rowCount: 1` for a conflicting insert**
    (US-022). That is the whole of a webhook ledger's idempotency claim, so
    pg-mem passes an implementation with no idempotency in it at all; the
    duplicate charge is what would have found it otherwise.
  - **An inline `check` in `alter table add column` does not parse, and the
    named form parses without being enforced** (US-058). A `> 0` constraint is
    only ever provable against a real server — pg-mem cannot hold it up in
    either direction.
  - **The two engines auto-name an inline column check differently** —
    `runs_status_check` versus `runs_constraint_2` (US-047). A migration that
    drops one name no-ops on the other engine, leaving the old constraint
    standing and rejecting every new value on exactly one of them. Drop both,
    as `004` and `011` do.

  It also can't run every query shape: a correlated subquery cannot see the
  outer alias, so `LIST_QUERY` in `routes/schedules.js` uses grouped derived
  tables. That one is loud, which makes it the harmless kind.

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

**When the suite goes flaky, run the suspect file alone.** BUG-007 looked
exactly like runner oversubscription — a different test each time, never two at
once, no correlation with the change — and it was not. Holding four cores busy
produced zero failures; running one file *by itself* produced four in forty. A
fault that survives being run alone is not a scheduling fault, and that one
measurement is what separated a plausible story from the two real causes. Reach
for it before reaching for `--test-concurrency`.

**A wait in milliseconds is a race, not an ordering.** The other half of
BUG-007 was a fair-share test that proved "B's slot frees before A's" with a
250ms hold against a 4000ms one, then drained inside an 8000ms budget it spent
7.8s of — every run, not just bad ones. Where a test means an ordering, say the
ordering: `fake_agent.js` takes `release=<name>` and holds its slot until the
test drops that file, so the wait is over something that has definitely
happened rather than something that has probably happened by now. Widening the
deadline would have been the wrong repair twice over — it hides a genuinely
wrong promotion inside the same timeout the busy box produces.

## What we don't test (and why that's a choice, not neglect)

- **The browser-driving agent loop itself.** Every server test stubs
  `run_agent.py`; launching a real Chromium + LLM per test is slow, flaky, and
  costs tokens. What US-034 could peel *off* the browser is now covered without
  one: `scrub()` redaction (`agent/redact.py` + `test_redact.py`), the report
  formatters (`agent/report_format.py` + `test_report_format.py`), and a
  recorded-fixture run through the pass/fail judge (`server/test/verdict.test.js`
  replays canned NDJSON transcripts through the real engine, no browser). What
  stays untested is the Chromium-driving core proper — the part that genuinely
  needs a browser to exercise.
- **Deep frontend interaction.** `status.js` helpers are unit-tested and a
  jsdom mount-smoke test now renders the shell and the run-detail card
  (`App.test.jsx`, `RunDetail.test.jsx`, US-034) to catch render-time breaks the
  build can't see. What stays untested is interaction behaviour — driving
  events, the WebSocket flow — which costs far more harness than it returns.
- **A full end-to-end (real browser + real LLM).** Not planned. The
  recorded-fixture approach buys most of the confidence with none of the
  flake or spend.

### The one claim the suite cannot make

Those omissions have a standing price, and the release-plumbing sprint paid it
often enough to be worth naming: **a green suite says the code does what we
modelled; it never says the model was right.** The last claim in a change is
routinely the one that needs the real thing running.

The clearest case is US-047. Stopping a run prefers `Agent.stop()` over
`SIGKILL` for exactly one reason — `agent.run()` returns, so the recorder's
`finally` writes the mp4's moov atom and the video stays playable. The test
stub is a Node script that writes the string `fake mp4 for tests`, so no test
in the suite could distinguish a playable file from a truncated one; that whole
chain had only ever been *read out of browser-use's source*. What closed the
story was watching a real stopped run play back. Same shape elsewhere: staging
found four defects (a Traefik/Docker version clash, a NULL Stripe column) that
no fixture here could have; running `docs/ci.md`'s snippet from a real GitHub
runner found Actions redacting the URL the doc told readers to keep secret.

The practical rule: when a change's reason-for-existing rests on third-party
behaviour — a library's cleanup path, a proxy's headers, a provider's payload —
the suite covers *our* half, and the claim is not proven until it has run
somewhere real. Budget that step into the story rather than treating green as
the finish line.

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

   The sharpest version of this is about **third-party payloads**, and US-051
   is the case that proved it: a fixture we wrote is evidence about our parser,
   never about the wire format. `billing-webhook.test.js` built its Stripe
   subscription object with a top-level `current_period_end` — a shape Stripe
   stopped sending in API version `2025-03-31.basil`, having moved the field
   onto the subscription item. The suite was green and self-consistent for a
   year: the reader read where the fixture wrote, and every real subscription
   had a NULL period end in the database. Nothing but a round trip against a
   real Stripe account could find it, and nothing but staging on test keys made
   that round trip cheap. So: when a fixture stands in for someone else's API,
   the shape has to be copied from a captured payload, and the story that
   touches the parser moves the fixture too.
4. **Selective TDD for the correctness-critical, easy-to-get-subtly-wrong
   pieces** — scheduler claim, slot math, redaction, billing gates; the running
   register is [`backlog/correctness-critical.md`](../backlog/correctness-critical.md).
   There, the human writes or tightens the assertion *first*, reviews it, then
   the AI implements against it. The test becomes a spec the implementation
   can't retrofit. Not the whole codebase — CRUD and wiring stay test-alongside.
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

The throwaway driver is now a repeatable tool: from `agent/`, `.venv/bin/mutmut
run` then `mutmut results` (config and scope in `agent/setup.cfg`). It mutates
the stdlib-only modules — `redact.py`, `report_format.py`, `email_codes.py` —
and, via `mutate_only_covered_lines`, skips the untested IMAP network glue so
survivors are always about logic a test could catch. Reading the survivors is
the point, not chasing zero: some are **equivalent mutants** — `fmt_date`'s
`.replace("Z", …)` is a no-op on Python 3.11+ where `fromisoformat` takes `Z`
natively, and `generate_address`'s `partition`→`rpartition` is identical for a
single-`@` address — unkillable without contorting the code, so they stay.
Others are honest gaps worth a case (`extract_code`'s `4 <= len` lower bound has
no 4-char-code test). `redact.py` — the security-critical one — leaves no
survivors.

## Where this should go next

Tracked in [US-034](../backlog/sprint/current/done/US-034-testing-practice-and-coverage.md):
the owed agent coverage (redaction, report formatters, judge fixture) and the
frontend mount-smoke test have landed. Selective TDD is now a standing CLAUDE.md
rule (Workflow rules) rather than only a mitigation here — written as a *forward*
rule, not a claim that the habit already ran, with one addition: spotting which
work is correctness-critical is Claude's job to raise, since it won't reliably
be flagged otherwise. The `mutmut` audit is wired up (see above). With that,
US-034's build items are all done; what stays open is judgement, not code —
keeping the correctness-critical register current and exercising the
assertion-first habit on the next hard piece.
