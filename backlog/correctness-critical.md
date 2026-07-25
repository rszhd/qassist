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
| Per-user API keys (US-021) | `server/src/auth.js` (`mintApiKey`) + `server/src/routes/keys.js` | the plaintext is persisted or handed back on a later read (only the sha256 hash may be stored, shown once at creation); a revoked key still authenticates; a user revokes or lists another tenant's key | `api-keys.test.js` (plaintext-once + hash-only-stored, minted key authenticates as bearer, revoked key refused, cross-tenant revoke 404) — assertion-first, written before the routes |
| Tenant isolation (US-021) | every user-scoped query; `server/src/db.js` (`currentUserId`) routes it | one missed `and user_id = $n` leaks another user's tests, runs, PDFs or recording, and a single-user test DB still returns plausible rows | `auth-isolation.test.js` (list scoping + cross-user test/run/report/recording all 404) — request-scoped `currentUserId()` so a route can't forget to scope |
| Demo run interceptor (US-036) | `server/src/runs.js` (`createRun` demo branch → `startReplay`) | one trigger path (ad-hoc / test / suite / module / schedule / retry) slips past the interceptor and spawns `run_agent.py`, claims a `MAX_CONCURRENT` slot, or calls an LLM — spending the operator's key/box on a stranger via a public, writable endpoint | `demo-interceptor.test.js` (every path: no Python canary, `counts()` stays 0 past the cap, no OPENAI key needed, real owned terminal row, fixture-matched verdict) — assertion-first, reviewed before implementation |
| Demo reaper (US-036) | `server/src/demoReaper.js` (`reapDemoTenants`) | an expired tenant leaves rows or artifact dirs behind: `runs.user_id` is `on delete set null` (`001_init.sql:102`), so a naive user delete orphans run rows and leaks `runs/<id>/` forever — the reaper must rm dirs + delete run rows explicitly, before the user delete | `demo-reaper-postgres.test.js` (real Postgres: completeness across every table incl. runs-by-id + dirs; live/normal untouched; the set-null trap demonstrated) — assertion-first, reviewed before implementation |
| Stored BYOK key (US-005) | `server/src/crypto.js` (`encryptSecret`/`decryptSecret`) + `server/src/openaiKey.js` + `server/src/routes/account.js` | the plaintext OpenAI key is persisted in the clear or handed back on a read (only the AES-GCM ciphertext may be stored, decrypted server-side only to spawn); a tampered ciphertext decodes to attacker bytes instead of failing closed; the resolved run key leaks into `run.goal`/`run.variables`/the persisted row/events/`report_data.json` instead of only the child env; a user reads or clears another tenant's key | `openai-key.test.js` (pure: round-trip, fresh IV, GCM tamper throws, shape gate, request>stored>server precedence) + `openai-key-postgres.test.js` (real Postgres: ciphertext-only at rest, reads never return the value, clear, cross-tenant, run-key containment) — assertion-first, reviewed before implementation |
| Per-user concurrency cap (US-028) | `server/src/runs.js` (`createRun` admission, `canStart`, `startNext` fair-share) + `config.js` | admission counts running-only so a user parks runs in the queue and beats the FIFO; the start-gate/dequeue count running+queued so a scheduled burst that bypassed admission still takes the whole box; a freed slot is promoted FIFO instead of skipping an at-cap user, so one user drains the worker; or the cap leaks into the unset path and stops being byte-for-byte self-host | `concurrency-cap.test.js` (admission counts running+queued, per-user not global, batch partial-accept in order, schedule never rejected) + `concurrency-fairshare.test.js` (schedule bounded to cap running, fair-share at submit + at dequeue — the idle-slot eligibility scan) + `concurrency-off.test.js` (unset = FIFO no-op) — assertion-first, reviewed before implementation |
| Billing gates | (current sprint — US-022) | a paid-only path opens when `STRIPE_*` is unset, or the self-host free tier gets gated by mistake | not built yet |

## What a row owes

A surface listed here should, whenever it is next touched, have its expected
behaviour pinned by an assertion written or tightened **before** the change,
reviewed by the maintainer, and left as the spec the implementation is measured against.
The three built rows above are currently covered test-*alongside* (the tests
shipped with the code); the assertion-first escalation applies to the next
change to any of them, and to billing gates from their first line. CRUD and
wiring do not belong here — they stay test-alongside.
