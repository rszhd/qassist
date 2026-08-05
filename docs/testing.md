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

  pg-mem's **known lies**, each learned the expensive way — the story or bug
  named is where the full account lives:

  - **A `bytea` parameter is corrupted** through a UTF-8 round trip, so AES-GCM
    ciphertext never decrypts — and intermittently (on nothing but the random
    IV) the escaped string is SQL pg-mem's own parser rejects, so the
    corruption presents as a flaky suite, or even as a **409** from a
    `/unique|duplicate/i` fallback matching the parser's `kw_unique` token
    (US-039, BUG-007). `test/helpers/stored-key.js` is the in-fake workaround;
    `byok-postgres.test.js` the real-server counterpart.
  - **node-pg's type parsers never run**: `count(*)` arrives as `0` where
    production gets the string `"0"`, so an uncast bigint check can never fail
    under pg-mem (BUG-006). Same class: an uncast `text[]` default arrives as
    the *string* `"{}"` — an allowlist that matches nothing (US-042). Anything
    whose correctness depends on the type a column arrives as is here.
  - **`on conflict do nothing` reports `rowCount: 1` for a conflicting
    insert** (US-022), so an idempotency claim proves nothing.
  - **Check constraints don't hold**: the inline form does not parse, the named
    form parses without being enforced (US-058) — and the two engines auto-name
    an inline check differently, so a migration dropping one name no-ops on the
    other; drop both, as `004` and `011` do (US-047).
  - **`count(*) filter (where …)` answers with the unfiltered count**,
    silently (US-069) — green on a surface whose failures are the point.
    `row_number() over (…)` and correlated subqueries are rejected loudly,
    which is the harmless kind; it is why the schedules strip trims a
    time-bounded window in JS and `LIST_QUERY` in `routes/schedules.js` uses
    grouped derived tables. That one is loud, which makes it the harmless kind.

That is the philosophy in miniature: **same feature, two tests, because the
shortcut one layer takes lies about the thing the other must verify.** Use the
fake by default; drop to reality only for the specific property the fake gets
wrong.

**For the database, that default has been withdrawn** (2026-07-28, after
BUG-007). The tax is not the lies on the list; it is the next one, which by
definition is not on it yet. So:

- **A new test file uses real Postgres.** `session-postgres.test.js` is the
  pattern — a uniquely-named database, migrations, dropped after. It costs
  ~450ms per file against a ~140ms node-startup floor, and CI already runs the
  service.
- **Convert an existing pg-mem file the next time it lies to you**, not on a
  sweep. Then it is one file, reviewed against a failure already understood.
- **When a file converts, its `*-postgres.test.js` counterpart folds back in** —
  that split exists only because the fake could not hold the claim up.

Retiring pg-mem outright is [US-065](../backlog/unscheduled/US-065-retire-pg-mem.md),
deliberately unscheduled: the risk is a 28-file sweep through assertion-first
specs, whose failure mode is a file that quietly stops asserting what its name
says. If the incremental route works, that story closes without being scheduled.

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

  **The boundary moves by extraction, not by mocking a browser**
  ([US-074](../backlog/sprint/current/done/US-074-run-agent-pure-logic-extracted.md)).
  `run_agent.py` imports `browser_use` at module top, so the host can never
  import it and nothing defined inside it is reachable by an assertion. The
  policy is therefore: when a change touches logic in that file that does not
  itself need a browser, it moves to a stdlib-only module *first*, the assertion
  goes on the module, and only then is the change made. Where the logic and the
  browser genuinely interleave, the browser half becomes an injected callable
  and the module owns the rest — `session_recorder.py` takes a
  `start_service(frame)` from run_agent.py and keeps the sampling, and
  `step_events.callback` takes its three collaborators the same way. Each of
  those seams exists because it is the only place an assertion can stand.
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
no fixture here could have; running the CI snippet (now `manual/ci.md`) from a real GitHub
runner found Actions redacting the URL the doc told readers to keep secret.

The practical rule: when a change's reason-for-existing rests on third-party
behaviour — a library's cleanup path, a proxy's headers, a provider's payload —
the suite covers *our* half, and the claim is not proven until it has run
somewhere real. Budget that step into the story rather than treating green as
the finish line.

### A measured constant needs a committed instrument, not more tests

`MAX_RUN_MEMORY_MB` is the case that names the pattern (US-024). A test can pin
what the code does with a memory reading; nothing in the suite can say the
default is the right number, because that answer lives in a real Chromium.

Split it in two, and each half gets the treatment it can actually take. The
*reader* becomes assertable by taking a `procRoot` parameter: a fake `/proc`
in a tmpdir gives you every case that matters — the kB unit, the fallback, a
pid vanishing mid-scan — with no root, no leaky browser and no flake. The
*number* gets a committed probe instead, run by hand when it needs re-deriving.
US-024's had been rebuilt from scratch twice before anyone kept it, which is
why its numbers could not be reproduced or trusted between measurements.

The wider rule: any constant in `config.js` justified by a measurement owes the
repo the command that produced it. Otherwise the next person to touch it has
only a comment, and a comment cannot be re-run.

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

A sweep proves *sensitivity* — no test passes no matter what, no assertion is
silently weak, which is exactly the AI-pair failure mode above (a manual
red-first sweep on 2026-07-24 confirmed ten seeded defects, ten caught). It
does **not** prove the expected values are the ones we want: a test can kill
every mutant and still pin a misread spec. Correctness of the target answer is
still on the human and the story.

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
survivors. The practice's origin story is
[US-034](../backlog/sprint/current/done/US-034-testing-practice-and-coverage.md).
