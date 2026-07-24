# Correctness-critical surfaces

The running register of the **correctness-critical, easy-to-get-subtly-wrong**
pieces that the assertion-first Workflow rule in `CLAUDE.md` applies to: work
where the maintainer writes or tightens the assertion *first* and reviews it, and only
then is the implementation written against it. Rationale and the wider testing
philosophy: `docs/testing.md`.

**This list is non-exhaustive by design, and absence from it proves nothing.**
Deciding whether a given piece of work belongs in this class happens at the
moment the work is done, and that judgement is **Claude's to raise, not
the maintainer's to remember** (the rule says so). A table can seed that judgement and
give us something concrete to point at; it can't replace it, and "it wasn't on
the list" is never a reason to skip the discipline. The counterpart duty: when
new work turns out to be one of these, **add a row here as part of doing it** —
the register only stays useful if it grows with the code.

## Known surfaces

| Piece | Lives in | The subtle way it breaks | Guarded by |
|---|---|---|---|
| Scheduler claim | `server/src/scheduler.js` (`claim`) | double-fire under concurrent ticks; a `next_run_at = $1` equality claim can never re-match the microsecond timestamp Postgres wrote, so the row is silently unclaimable forever | `scheduler-postgres.test.js` (real Postgres — pg-mem's ms timestamps hide this) |
| Slot math | `server/src/schedule.js` | off-by-one at minute / hour / day / weekday boundaries and across DST and timezone; the next slot must land strictly in the future | `schedule.test.js` (pure) |
| Redaction | `agent/redact.py` (`scrub`) | a secret leaks through — inside a URL, as a substring, or because `sensitive` was empty and the guard was wrong | `agent/tests/test_redact.py` (pure) |
| Secret variables (US-035) | `server/src/variables.js` (`resolveForRun`) + the agent `QA_VARS` path | a `secret` variable's value reaches `QA_GOAL`/the persisted `run.goal`/`run.variables` because it was substituted inline instead of routed as a placeholder, or the agent never adds it to `sensitive` so `scrub` can't strip it from frames/steps/report | `variables.test.js` (secret block — value never enters goal/persisted map, routes on `secrets` channel, rejected in start_url) + `agent/tests/test_secret_vars.py` (`QA_VARS` fails closed, loaded secret is scrub-redactable); assertion maintainer-reviewed before implementation |
| Session cookie (US-021) | `server/src/auth.js` (`signSession`/`verifySession`) | a forged or tampered cookie verifies, or an expired one is still accepted — auth becomes decorative, and there is no session table to catch it | `auth.test.js` (round-trip, tamper on every field, forgery without the secret, expiry) — assertion maintainer-reviewed before implementation |
| Magic-link consume (US-021) | `server/src/auth.js` (`consumeLoginToken`) | a link redeemable after use or past expiry = account takeover from anyone who reads a mailbox; a check-then-update consume double-redeems under concurrency | `auth-isolation.test.js` (single-use, expiry, signup-creates-user on pg-mem) + `auth-postgres.test.js` (concurrent double-redeem on real Postgres, which pg-mem can't prove) |
| Tenant isolation (US-021) | every user-scoped query; `server/src/db.js` (`currentUserId`) routes it | one missed `and user_id = $n` leaks another user's tests, runs, PDFs or recording, and a single-user test DB still returns plausible rows | `auth-isolation.test.js` (list scoping + cross-user test/run/report/recording all 404) — request-scoped `currentUserId()` so a route can't forget to scope |
| Billing gates | (next sprint — US-022) | a paid-only path opens when `STRIPE_*` is unset, or the self-host free tier gets gated by mistake | not built yet |

## What a row owes

A surface listed here should, whenever it is next touched, have its expected
behaviour pinned by an assertion written or tightened **before** the change,
reviewed by the maintainer, and left as the spec the implementation is measured against.
The three built rows above are currently covered test-*alongside* (the tests
shipped with the code); the assertion-first escalation applies to the next
change to any of them, and to billing gates from their first line. CRUD and
wiring do not belong here — they stay test-alongside.
