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
| Billing gates | (Release 2 — US-022) | a paid-only path opens when `STRIPE_*` is unset, or the self-host free tier gets gated by mistake | not built yet |

## What a row owes

A surface listed here should, whenever it is next touched, have its expected
behaviour pinned by an assertion written or tightened **before** the change,
reviewed by the maintainer, and left as the spec the implementation is measured against.
The three built rows above are currently covered test-*alongside* (the tests
shipped with the code); the assertion-first escalation applies to the next
change to any of them, and to billing gates from their first line. CRUD and
wiring do not belong here — they stay test-alongside.
