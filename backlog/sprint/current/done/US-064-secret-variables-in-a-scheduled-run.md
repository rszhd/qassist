# US-064 — Secret variables in a scheduled run

**As** someone whose nightly suite covers a flow behind a credential the agent
has to type, **I want** a schedule to supply its secret variables, **so that**
the tests I can run by hand are the tests I can run at 02:00.

- **Status:** ✅ Done 2026-07-28 — filed the same day out of the question
  "during a run using the scheduler, what about the secret variables?", which
  had no answer: there was no channel. **Approach B, with C**, as settled — with
  one deviation in where the ciphertext lives, recorded under "What was built".
- **Priority:** P1, raised from P2 the day it was filed. The demand question
  this story was going to open with is already answered, and by our own schema:
  migration 015 says a passing run of a session's `login_test_id` refreshes the
  row, "which makes 'the session went stale' a thing the existing scheduler
  already fixes nightly, with no new machinery". That nightly refresh has never
  been able to run — see "What US-043 covers". A shipped feature whose stated
  maintenance path does not execute outranks a coupon code.
- **Depends on:** [US-035](US-035-run-variables.md) (the contract this
  amends), [US-010](US-010-scheduled-runs.md),
  [US-021](US-021-signup-auth.md). It does not duplicate
  [US-043](US-043-reusable-authenticated-sessions.md), it **completes** it —
  the nightly session refresh that story designed cannot run without this
  channel. See "What US-043 covers, and the one thing it cannot".
- **Not** [BUG-005](BUG-005-scheduler-counts-unstarted-members-as-runs.md),
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
[`015_browser_sessions.sql`](../../../../db/migrations/015_browser_sessions.sql),
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

**Add a row to [`correctness-critical.md`](../../../correctness-critical.md) as
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

## What was built

All eight met. `017_test_secrets.sql`, `server/src/testSecrets.js`, the four
`variables.js` functions below, the three run paths, option C on the schedule
routes, and the editor.

**The one deviation from B as written: the ciphertext is a table, not a field
inside `tests.variables`.** B said "`tests.variables[].value` encrypted", and
that collides with this story's own last assertion — *the column is never
selected into anything that reaches a response*. `variables` is in the `COLS`
constant all four test endpoints select, so ciphertext inside it ships in every
response body and masking becomes a discipline repeated at four sites forever,
which the fifth site added next year does not inherit. `test_secrets
(test_id, name, value_ciphertext)` makes that property structural instead, keeps
the `bytea` envelope US-005 and US-043 already use rather than base64 inside
jsonb, and — because it is keyed by name — answers the editor's set/not-set
state with `select name`, so **no read path decrypts anything at all**. That is
what keeps "plaintext exists only between decrypt and `resolveForRun`" literally
true rather than approximately. Everything else about B is unchanged: the secret
is a property of the test, and manual, CI and scheduled runs were all fixed by
the one change because all three already read the declaration.

The register's standing obligation is correspondingly smaller than B was
accepted with: a future endpoint that forgets to mask leaks nothing, because
there is nothing in the columns it selects to leak.

### The decisions, and what each one is protecting against

Numbered as D1-D17 across the three spec files (`variables.test.js` D1-D6,
`test-secrets.test.js` D7-D14, `test-secrets-postgres.test.js` D15-D17).

- **Blank means keep, non-empty means replace, `clear: true` means clear.**
  The read-modify-write hazard was the real risk and it landed exactly where
  the story predicted: `TestDialog` GETs the array, holds it in editor state and
  PUTs the whole thing back, so any other reading of blank wipes the credential
  during a rename. `clear` is an explicit flag rather than `value: null` —
  `null` was free (it is currently rejected) but a client that serializes an
  untouched field as null would then silently erase a stored secret, and this is
  the one edit whose damage is invisible for a fortnight.
- **The merge seam is the update route's existing `variables === undefined` ⇒
  leave unchanged.** The decision itself is pure (`secretWrites` in
  `variables.js`); only the encrypt-and-write half needs the DB, which is why
  `variables.js` could stay DB-free as designed.
- **An empty override never displaces a stored secret.** Not in the story, and
  it would have broken every manual run of a test with one: `RunVarsDialog`
  prefills from `v.value` — masked, so empty — and PUTs every declared name, so
  `''` arrives as a *present* key. `||` rather than `??` in `resolveForRun`, and
  the frontend drops blank secret boxes before sending as well.
- **An optional secret with nothing to resolve now behaves like an empty
  optional plain variable** (AC #6): the reference substitutes empty, nothing is
  routed on the `secrets` channel, and the run row records `''` rather than the
  `'<secret>'` presence marker. Marking presence for a value nobody supplied is
  the same lie one layer up, and history is where it would be believed longest.
- **Option C skips the check when the result is disabled.** Refusing to let
  someone turn OFF a schedule whose target is broken puts the fix behind the
  refusal. A disabled schedule fires into nothing, so there is nothing to
  protect it from.
- **`testsOf` is now exported from `scheduler.js`** and is what the schedule
  route validates against, so the save-time question and the 02:00 question
  cannot disagree about what a schedule would do — the drift BUG-006 already
  cost us once in the target counts.
- **C stayed scoped to secrets, as AC #5 words it.** The identical failure
  exists for a *required non-secret* variable with no default — same dropped
  member, same silent 02:00, and `unresolvableSecrets` is two characters from
  covering it. Left alone deliberately: widening it would start refusing PUTs on
  schedules that exist today. Worth its own line if it ever bites.

### What the tests hold up, and where

- `variables.test.js` — the pure rules. Its existing US-035 secret block passes
  unchanged (AC #8), which is the point: the amendment adds a source of a value
  and changes nothing about where one may go.
- `test-secrets.test.js` — storage, masking over the **response body** (so a
  fifth column-list site fails rather than inherits), the three-state write, the
  run paths, and C's refusals. The set-state assertion corrupts the ciphertext
  first: if any read path ever decrypts, that test throws, which is the only
  way to prove a negative like "reads don't decrypt".
- `test-secrets-postgres.test.js` — the `bytea` round trip through the product's
  own parameter binding, which pg-mem cannot hold up at all (`byteaPool` papers
  over exactly the defect worth catching), plus the `on delete cascade` and a
  rotated-key refusal.
- `scheduler.test.js` — the same schedule over the same declaration that the
  pre-existing "a member whose required variable cannot resolve is not counted as
  a run" test proves starts *nothing*, now starts a run; the 015 nightly refresh
  (AC #2); an undecryptable secret skipping the member; and no secret in any log
  line.
- `RunView.test.jsx` — "drops the stored default when a variable is marked
  secret" was rewritten, not loosened. Ticking Secret used to clear the value
  because nothing was allowed to persist one; it now masks the field and keeps
  it. The comment above it says which behaviour changed and why, per the red-test
  rule.

### Left undone

Nothing in scope. Two adjacent things, neither this story's:

- The required *non-secret* variable case above.
- Renaming a secret variable orphans its stored value — it reads as not-set
  under the new name. Honest rather than fixable: the value cannot be read back
  to carry across a rename, and the alternative is a stored secret silently
  answering to a name nobody set it for.
