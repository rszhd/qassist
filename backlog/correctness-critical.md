# Correctness-critical surfaces

The running register of the **correctness-critical, easy-to-get-subtly-wrong**
pieces that the assertion-first Workflow rule in `CLAUDE.md` applies to: work
where the maintainer writes or tightens the assertion *first* and reviews it,
and only then is the implementation written against it. Rationale and the wider
testing philosophy: `docs/testing.md`.

**This list is non-exhaustive by design, and absence from it proves nothing.**
Deciding whether a given piece of work belongs in this class happens at the
moment the work is done, and that judgement is **Claude's to raise, not the
maintainer's to remember** (the rule says so). A table can seed that judgement
and give us something concrete to point at; it can't replace it, and "it wasn't
on the list" is never a reason to skip the discipline. The counterpart duty:
when new work turns out to be one of these, **add a row here as part of doing
it** — the register only stays useful if it grows with the code.

Each row is a one-line reminder of the *shape* of the failure, so the table
stays scannable before starting work. The full account of how each surface
breaks lives in the story that built it — follow the link in the first column.
Cross-cutting lessons about what the test layers can and cannot prove live in
`docs/testing.md`, not here. If a row no longer fits on one or two lines, that
is the signal its content belongs in the story, not that the row needs more
room.

## Known surfaces

| Piece | Lives in | The shape of the failure | Guarded by |
|---|---|---|---|
| [Scheduler claim](sprint/current/done/US-010-scheduled-runs.md) | `server/src/scheduler.js` (`claim`) | Double-fire under concurrent ticks; or an equality claim on a microsecond timestamp leaves the row unclaimable forever; or a field describing an *outcome* rides along with the claim (BUG-006) | `scheduler-postgres.test.js` (real Postgres), `scheduler.test.js` |
| [Slot math](sprint/current/done/US-010-scheduled-runs.md) | `server/src/schedule.js` | Off-by-one at minute / hour / day / weekday boundaries and across DST and timezone; the next slot must land strictly in the future | `schedule.test.js` |
| [Redaction](sprint/current/done/US-034-testing-practice-and-coverage.md) | `agent/redact.py` (`scrub`) | A secret leaks through — inside a URL, as a substring, or because `sensitive` was empty and the guard was wrong | `agent/tests/test_redact.py` |
| [Secret variables](sprint/current/done/US-035-run-variables.md) | `server/src/variables.js` (`resolveForRun`) + the agent `QA_VARS` path | A secret's value reaches the goal, the persisted run or the page, because it was substituted inline instead of routed as a placeholder — or a placeholder is hand-written into a saved goal, where nothing declares it (BUG-004) | `variables.test.js`, `agent/tests/test_secret_vars.py` |
| [Session cookie](sprint/current/done/US-021-signup-auth.md) | `server/src/auth.js` (`signSession`/`verifySession`) | A forged, tampered or expired cookie verifies and auth becomes decorative — there is no session table to catch it | `auth.test.js` |
| [Magic-link consume](sprint/current/done/US-021-signup-auth.md) | `server/src/auth.js` (`consumeLoginToken`) | A link redeemable after use or past expiry is account takeover from anyone who reads a mailbox; a check-then-update consume double-redeems under concurrency | `auth-isolation.test.js`, `auth-postgres.test.js` (real Postgres) |
| [Per-user API keys](sprint/current/done/US-021-signup-auth.md) | `server/src/auth.js` (`mintApiKey`) + `routes/keys.js` | The plaintext is persisted or handed back on a later read; a revoked key still authenticates; a user revokes or lists another tenant's key | `api-keys.test.js` |
| [Tenant isolation](sprint/current/done/US-021-signup-auth.md) | Every user-scoped query; `server/src/db.js` (`currentUserId`) routes it | One missed `and user_id = $n` leaks another tenant's tests, runs, PDFs or recordings — and a single-user test DB still returns plausible rows | `auth-isolation.test.js` |
| [Demo run interceptor](sprint/current/done/US-036-demo-sandbox.md) | `server/src/runs.js` (`createRun` demo branch → `startReplay`) | One trigger path slips past the interceptor and spawns the agent, claims a slot or calls an LLM — spending the operator's key and box on a stranger, through a public writable endpoint | `demo-interceptor.test.js` |
| [Demo reaper](sprint/current/done/US-036-demo-sandbox.md) | `server/src/demoReaper.js` (`reapDemoTenants`) | An expired tenant leaves rows or artifact dirs behind: `runs.user_id` is `on delete set null`, so a naive user delete orphans run rows and leaks `runs/<id>/` forever | `demo-reaper-postgres.test.js` (real Postgres) |
| [Stored BYOK key](sprint/current/done/US-005-byok-user-api-keys.md) | `server/src/crypto.js` + `openaiKey.js` + `routes/account.js` | Plaintext at rest or handed back on a read; a tampered ciphertext decodes to attacker bytes instead of failing closed; the resolved run key escapes the child env into the row, the events or the report | `openai-key.test.js`, `openai-key-postgres.test.js` (real Postgres) |
| [Per-user concurrency cap](sprint/current/done/US-028-per-user-concurrency-limit.md) + [override](sprint/current/done/US-058-per-user-concurrency-override.md) | `server/src/concurrency.js` + the three gates in `runs.js` | A gate that counts running-only, or an override reaching some of the three gates and not all, lets one account beat the FIFO; a stale cache makes the operator's lever a no-op | the seven `concurrency-*.test.js` files (`concurrency-override-postgres.test.js` on real Postgres) |
| [Staging/production config separation](sprint/current/done/US-038-staging-environment.md) | `docker-compose.prod.yml` + `.env.staging` | A second stack on the same box inherits a production value and stops being staging — live Stripe keys, production's `SESSION_SECRET`, real mail recipients | **Candidate — no assertion yet** (needs Docker in CI) |
| [BYOK-only run funding](sprint/current/done/US-039-byok-only-no-server-key.md) | `server/src/openaiKey.js` (`resolveRunKey`) + `startRun`'s child env | A start path resolves no key and starts anyway — or `...process.env` in the spawn hands the server's ambient key to the child. Inverse: the solo self-hoster stranded with nowhere to put a key | `byok-only.test.js`, `byok-solo.test.js`, `byok-postgres.test.js` (real Postgres) |
| [Client IP behind the proxy](sprint/current/done/US-040-demo-deployment.md) | Express `trust proxy` (`TRUST_PROXY`) → `routes/demoSession.js` + `routes/auth.js`'s limiter | Both directions fail: unset, every request behind Traefik shares one address and the per-IP cap becomes global; too trusting, any client claims any address. In-process tests pass either way, which is why they hide it | `trust-proxy.test.js`, `demo-ip-throttle-proxy.test.js`, `demo-ip-throttle.test.js` |
| [Billing gates](sprint/current/done/US-022-stripe-billing.md) | `server/src/billing.js` + `routes/helpers.js` (`requireEntitled`) + the scheduler's fire path | One of the run-start paths misses the gate and the paid tier is free through it; or the gate leaks into the `STRIPE_*`-unset path and self-host stops being free; or a forged, replayed or out-of-order webhook grants entitlement | `billing-gate.test.js`, `billing-webhook.test.js`, `billing-webhook-postgres.test.js` (real Postgres), `billing-off.test.js`, `frontend/src/Billing.test.jsx` |
| [Checkout precondition](sprint/current/done/US-053-onboarding-key-then-subscribe.md) | `routes/billing.js` (`POST /checkout`) + `openaiKey.js` (`getUserOpenaiKeyStatus`) | The gate reaches one notch too far and traps a lapsed customer out of the card update that would clear the paywall; or it runs *after* `createCheckoutSession` and sells a subscription to an account with nothing on file | `checkout-key-gate.test.js` |
| [Activation window](sprint/current/done/US-054-activation-window-after-subscribe.md) | `server/src/activation.js` + `requireEntitled` + the scheduler's fire path | The window leaks into the unset path and a self-host grows a wall it never asked for; a start path misses it; a webhook rewrite or a sliding deadline re-walls a customer | `activation-gate.test.js`, `billing-gate.test.js` (the window OFF) |
| [Stopping a run](sprint/current/done/US-047-stop-a-run.md) | `server/src/runs.js` (`stopRun`, `verdictOf`, `close`) | The loudest failure looks like success: browser-use returns history normally out of `Agent.stop()`, so an aborted run ends `passed` — green in CI, in History and in the mail. Quieter twins in the story | `stop-run.test.js`, `RunView.test.jsx` |
| [Navigation confinement](sprint/current/done/US-042-agent-navigation-confinement.md) | `server/src/navigationPolicy.js` + `agent/navigation_policy.py` | A fence that is off by default, or that lets one spelling of an address through, is worth *less* than no fence, because it is believed. The allowlist traps are in the story | the four `navigation-*.test.js` files (`navigation-fence-postgres.test.js` on real Postgres), `agent/tests/test_navigation_policy.py` |
| [Project fixtures](sprint/current/done/US-048-file-upload-in-test-flows.md) | `server/src/fixtures.js` + the `QA_FIXTURES` path | The `available_file_paths` whitelist is the only thing between an agent argued into `read_file` and the container's `.env`; a traversal spelling, another tenant's project, or an ad-hoc run resolving to "everything on the box" all get on it | `fixture-path.test.js`, `fixture-whitelist.test.js`, `agent/tests/test_fixtures.py` |
| [Captured browser evidence](sprint/current/done/US-044-network-and-console-evidence.md) | `agent/diagnostics.py` + `runs.js` (`diagnosticsOf`) | Page-authored text reaches the PDF unscrubbed — or truncated *before* scrubbing, which splits the secret so `scrub` no longer matches it | `agent/tests/test_diagnostics.py`, `diagnostics-evidence.test.js` |
| [Saved browser sessions](sprint/current/done/US-043-reusable-authenticated-sessions.md) (+ [US-063](sprint/current/done/US-063-capture-a-session-without-a-terminal.md)) | `server/src/browserSession.js` + the spawn/capture/close path in `runs.js` + `agent/browser_session.py`; US-063 adds `sessionCapture.js` and the extension | A `storageState` **is** the credential, and `scrub` can never be the guard because the blob never enters the LLM's context — containment is everything. The handover, teardown and capture-token traps are in the two stories | the `session-*.test.js` files (`session-postgres.test.js` on real Postgres), `agent/tests/test_browser_session.py`, `extension/lib/storageState.test.mjs` |
| [Stored secret variables](sprint/current/done/US-064-secret-variables-in-a-scheduled-run.md) | `server/src/testSecrets.js` + `variables.js` (`resolveForRun`) | A masked read plus a naive write-back erases the credential during an unrelated edit, silently — it surfaces as a failed run at 02:00 a fortnight later. The twins are in the story | `test-secrets.test.js`, `test-secrets-postgres.test.js` (real Postgres), `variables.test.js` |
| [Slot collapse](sprint/current/done/US-069-schedule-health-strip.md) | `server/src/slotVerdict.js` + `routes/schedules.js` (`recentSlots`) | Seven statuses and a nullable `success` fold into one colour, and every wrong answer fails the same way — **green**. Nine passes and one error drawn as a clean night is a false all-clear on the page whose only job is to raise the alarm, and nothing downstream contradicts it | `slot-verdict.test.js`, `schedules-api.test.js` |
| [Run memory metric](sprint/current/done/US-024-memory-watchdog-pss-metric.md) | `server/src/procMemory.js` + `runs.js` (`memWatch`) | The result meets one threshold and nothing else, so a unit slip — kB read as bytes, or as pages — is off by 1024x or 4x and still looks like a memory reading; too low and the watchdog stops guarding without saying so | `proc-memory.test.js` |

Six rows are covered test-*alongside* rather than assertion-first, and
escalate on their next change: **Scheduler claim**, **Slot math**,
**Redaction**, **Magic-link consume**, **Tenant isolation**, **Slot collapse**.
**Staging/production config separation** has no guard at all yet.

## What a row owes

A surface listed here should, whenever it is next touched, have its expected
behaviour pinned by an assertion written or tightened **before** the change,
reviewed by the maintainer, and left as the spec the implementation is measured
against. CRUD and wiring do not belong here — they stay test-alongside.

A row also owes its story. When one of these surfaces changes, the account of
*how* it breaks — the spellings, the orderings, the traps read out of a
dependency's source — belongs in that change's US-xxx file, and any lesson that
outlives it belongs in `docs/testing.md`. Writing that account into this table
instead is what made it unreadable once already (`CLAUDE.md` holds that
history).
