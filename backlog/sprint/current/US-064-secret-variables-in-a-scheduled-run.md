# US-064 — Secret variables in a scheduled run

**As** someone whose nightly suite covers a flow behind a credential the agent
has to type, **I want** a schedule to supply its secret variables, **so that**
the tests I can run by hand are the tests I can run at 02:00.

- **Status:** 📋 Planned — filed 2026-07-28 out of the question "during a run
  using the scheduler, what about the secret variables?", which has no answer:
  there is no channel. Scheduled into `sprint/current/` the same day.
  **Approach settled 2026-07-28: B, with C.** See "Approaches".
- **Priority:** P1, raised from P2 the day it was filed. The demand question
  this story was going to open with is already answered, and by our own schema:
  migration 015 says a passing run of a session's `login_test_id` refreshes the
  row, "which makes 'the session went stale' a thing the existing scheduler
  already fixes nightly, with no new machinery". That nightly refresh has never
  been able to run — see "What US-043 covers". A shipped feature whose stated
  maintenance path does not execute outranks a coupon code.
- **Depends on:** [US-035](done/US-035-run-variables.md) (the contract this
  amends), [US-010](done/US-010-scheduled-runs.md),
  [US-021](done/US-021-signup-auth.md). It does not duplicate
  [US-043](done/US-043-reusable-authenticated-sessions.md), it **completes** it —
  the nightly session refresh that story designed cannot run without this
  channel. See "What US-043 covers, and the one thing it cannot".
- **Not** [BUG-005](done/BUG-005-scheduler-counts-unstarted-members-as-runs.md),
  which is the reason this gap is currently invisible rather than the gap itself.
  That one is a defect and stands on its own; fix it whether or not this story
  is ever built.

## The gap

A `secret` declaration deliberately stores no value. `VariablesEditor` clears it
the moment the box is ticked (`frontend/src/RunDialogs.jsx:191`) so no plaintext
secret lands in `tests.variables`, and US-035's guarantee is that the real value
arrives per run. Exactly two channels carry it, and both are request-scoped:

- the per-run override dialog (`frontend/src/RunView.jsx:437` → body `variables`)
- a CI trigger body

Both land as `opts.variables` on `runTests`. The scheduler has neither. There is
no `variables` column on `schedules` (`db/migrations/003_schedules.sql`), the
route accepts no such field (`server/src/routes/schedules.js`), and
`server/src/scheduler.js:230` calls `runTests` without the key. So
`resolveForRun` sees the declaration's empty `value` and the run fails two ways
depending on one checkbox:

- **Required secret** → `{ error: 'variable X is required' }`, the member is
  dropped, **no run row is created at all**. Nothing appears in history, in
  Activity, or in a failure email — there is no run to attach any of it to.
- **Optional secret** → `secrets[name] = ''`. The goal keeps its
  `<secret>name</secret>` placeholder, `QA_VARS` hands the agent an empty
  string, and it types nothing into the password field. A false fail, and one
  that looks like the app broke rather than the config.

Neither is reported: BUG-005 counts the dropped member as a run.

## Why this is not "add a column"

US-035's redaction guarantee is that a secret's value is never persisted —
`migration 005` says so about `runs.variables`, the editor enforces it about
`tests.variables`, and `resolveForRun` routes the value on an in-memory
`secrets` channel that dies with the process.

A schedule fires while nobody is present, so anything it supplies must survive
between slots — **at rest, encrypted, on our disk.** That is a deliberate
amendment to the guarantee, not an oversight being tidied up.

The amended sentence, which belongs in `server/src/variables.js`'s header next
to the old one: **a secret's value is never persisted unencrypted, never
returned by any endpoint, and never denormalized onto a run.** What that gives
up is only "never persisted at all"; everything the redaction assertions
actually check is still true.

## What US-043 covers, and the one thing it cannot

For a test *behind* a login, the answer exists and is better than a secret
variable. US-043 sessions replay a saved `storage_state` (`scheduler.js:238`
passes `sessionsForTests(ready)`), so the credential never enters the goal and
the nightly re-run needs no secret at all.

Agent-provided secrets need nothing either: `qa_password`, `email_code` and
`email_link` (`AGENT_PROVIDED_SECRETS`) are minted mid-run, so the US-059 OTP
work does not wait on this story.

**But the login test itself cannot use a session, because it is what produces
one.** It is the single test that must type a real credential on every run — and
US-043 already assumed it would do that on a schedule.
[`015_browser_sessions.sql`](../../../db/migrations/015_browser_sessions.sql),
on `login_test_id`:

> The test whose job is to authenticate. A passing run of it refreshes this row,
> which makes "the session went stale" a thing the existing scheduler already
> fixes nightly, with no new machinery.

**That refresh has never worked.** The scheduler passes no `variables`
(`scheduler.js:230`), no session route accepts a credential, and `qa_password`
is the generated *signup* password, not an existing account's. So the login test
lands in exactly the gap above: required secret → dropped member and no run row;
optional → an empty string typed into the password field, reported as the app
being broken.

The same run is also the first monitor a self-hoster asks for — "log in every
morning so I know login still works" — and a passing login run refreshes the
session as a side effect. One nightly schedule, both jobs.

So the demand question this story was filed to ask (*is a non-login secret typed
mid-run real for someone?*) is moot: the motivating case is not a coupon code,
it is the credential US-043 is built around. A coupon code, a pasted API token
or a payment-sandbox card ride the same channel for free.

## Approaches — settled 2026-07-28: B, with C

**B — encrypted default on the declaration. Chosen.**
`tests.variables[].value` encrypted with `server/src/crypto.js` when `secret`,
the same envelope the BYOK key and the session blob already use. The editor
field simply stops clearing on the Secret tick, and manual, CI and scheduled
runs are fixed by one change, because all three already read the declaration.

Why it wins: **the secret is a property of the test, not of the firing.** The
login test's password is as much part of `Login to admin` as its goal or its
start URL — true at 02:00, at a manual click, and from CI. Store it once, every
consumer resolves it, rotate it in one place.

**A — encrypted overrides on the schedule row. Rejected.**
`schedules.secret_variables`, decrypted in the tick and passed as
`opts.variables`. Per-schedule scope reads as an advantage until it is priced:

- **Two sources of truth for one credential.** A nightly refresh and a weekly
  monitor over the same login test each hold their own encrypted copy of the
  same password, rotated separately. Miss one and it fails as a *test failure* —
  "login is broken" — which is the false alarm the monitor exists to rule out.
- **It fixes only the scheduled path.** A manual run of that same test still
  prompts for the value, because A stores on the schedule while the manual path
  resolves from the test. The password ends up in two rows and the operator's
  head, with no authoritative copy.
- **A ceiling it cannot lift.** The override map is name-keyed and sprays every
  member (`variables.js:151`), so two members of one suite declaring the same
  name cannot receive different values. That failure is a silent false green,
  and no assertion can catch it — it is a design limit, not a bug.

What A would have bought is a narrower standing obligation: nothing will ever
want to return a schedule's secrets, whereas every future feature touching
`tests` inherits B's masking requirement. Accepted deliberately — see the last
assertion below for why its worst case is survivable.

**C — refuse it, loudly, at save. Also doing, as part of B.**
Validate at schedule create/update that no target test has a required secret it
cannot resolve, and reject with the reason. Under B this check is *better* than
it would have been alone: it asks "does this target have a required secret with
no stored value?" against real state, rather than "does this target mention a
secret at all?". A target that cannot resolve is refused when it is saved, not
at 02:00.

## Assertion-first — this is correctness-critical

It puts a secret value at rest and routes it through `resolveForRun` on the one
path where nobody is watching the outcome. Same class as the US-035 secret path
already in the register, and the maintainer writes/reviews the assertions before
the implementation:

- a stored secret's value never appears in a `GET /api/tests` or
  `GET /api/tests/:id` response, in `runs.variables`, in `run.goal`, in a report
  or in a scheduler log line. Declarations leave through one `COLS` constant at
  four sites (`server/src/routes/tests.js:116,143,165,233`), so masking has one
  home — but assert over the *response body*, not the helper, so a fifth site
  added later fails the test instead of inheriting the bug.
- **the read-modify-write hazard, which is B's real risk.** `TestDialog` loads
  `test.variables` into editor state and PUTs the whole array back, so a masked
  GET plus a naive PUT writes an empty value over a stored secret while the user
  was renaming the test. Silent, and it surfaces as a failed run at 02:00 two
  weeks later. The merge is three-state — blank means keep, non-empty means
  replace, an explicit clear means clear — and it needs the stored row, which is
  the one thing `variables.js` deliberately cannot reach (`variables.js:5-9`: no
  DB, no spawn). Decide where the merge lives before writing it; the update
  route already treats `variables === undefined` as "leave unchanged" at
  `routes/tests.js:201`, and that is the seam.
- `resolveForRun` still routes the value on the `secrets` channel only — the
  existing US-035 assertions must pass unchanged with a stored value
- a schedule whose secret cannot resolve starts no run **and says so** (the
  BUG-005 behaviour, fixed 2026-07-28: the tick counts only `{runId}` members as
  runs, reports the rest under `unstarted`, and logs each by test id and reason)
- decrypt failure skips the member with an error marker, like a session that
  cannot be decrypted (`runs.js:441`), rather than starting a run with an empty
  secret
- plaintext exists only in memory between decrypt and `resolveForRun`, so a
  future endpoint that forgets to mask leaks *ciphertext*. That is what makes B's
  standing obligation survivable, and it is worth an assertion of its own: the
  column is never selected into anything that reaches a response.

**Add a row to [`correctness-critical.md`](../../correctness-critical.md) as
part of doing this**, next to the existing "Secret variables (US-035)" row —
the register's rule is that the row lands with the work, not before it.

## Frontend

B collapses most of this. The work is in `VariablesEditor`
(`frontend/src/RunDialogs.jsx:191`): stop clearing the value on the Secret tick,
show a masked input in place of the `value set per run / CI` note, and add the
one thing a never-readable field needs — a plain **set / not set** state and an
explicit clear, since blank now means "keep".

`RunVarsDialog` prefills from `v.value` (`RunView.jsx:416`), which under B is the
masked empty. So a manual run of a test with a stored secret shows a blank
password box that means "use the saved value" — hint it, or the operator retypes
a password they did not need to.

`frontend/src/SchedulesView.jsx` gains only option C's refusal at save, in the
words of the failure it prevents. No per-schedule secret UI, and no union of a
group's declared secrets — the thing A would have needed, since one override
sprays every member (US-035 group semantics).

## Acceptance criteria

1. A test declaring a secret can store its value, encrypted, and a schedule over
   that test runs correctly with no per-schedule configuration.
2. **US-043's nightly refresh works.** A schedule over a session's
   `login_test_id` types the real credential, passes, and refreshes the row —
   the thing migration 015 already says the scheduler does.
3. A stored secret is encrypted at rest and appears in no API response, run row,
   report or log line.
4. Editing an unrelated field on a test that has a stored secret neither changes
   nor clears that secret.
5. A schedule whose target has a required secret it cannot resolve is refused at
   save, with the reason — it never fires into a dropped member.
6. An optional secret with no value no longer silently types an empty string.
7. The US-043 path is otherwise untouched: a scheduled test *behind* a login,
   with a saved session, still needs no secret variable.
8. `variables.test.js`'s existing secret block passes unchanged.
