# US-064 — Secret variables in a scheduled run

**As** someone whose nightly suite covers a flow behind a credential the agent
has to type, **I want** a schedule to supply its secret variables, **so that**
the tests I can run by hand are the tests I can run at 02:00.

- **Status:** 📋 Planned — filed 2026-07-28 out of the question "during a run
  using the scheduler, what about the secret variables?", which has no answer:
  there is no channel. Scheduled into `sprint/current/` the same day.
- **Priority:** P2. **Settle the demand question below first** — it is the one
  input that decides whether this is option C and a day, or option A and a new
  at-rest secret store. The login case, which is most of the surface, is already
  US-043's and does not wait on this either way.
- **Depends on:** [US-035](done/US-035-run-variables.md) (the contract this
  amends), [US-010](done/US-010-scheduled-runs.md),
  [US-021](done/US-021-signup-auth.md). Must **not** duplicate
  [US-043](done/US-043-reusable-authenticated-sessions.md) —
  see "What already covers most of this".
- **Not** [BUG-005](../../bugs/BUG-005-scheduler-counts-unstarted-members-as-runs.md),
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
amendment to the guarantee, not an oversight being tidied up. Whatever lands
here should say in one sentence what the new guarantee is, and that sentence
belongs in `server/src/variables.js`'s header comment next to the old one.

## What already covers most of this

For a login-gated test — the overwhelmingly common case — the answer exists and
is better than a secret variable. US-043 sessions replay a saved
`storage_state` (`scheduler.js:238` passes `sessionsForTests(ready)`), so the
credential never enters the goal and the nightly re-run needs no secret at all.
Refreshing that session is itself the job a schedule is for.

Agent-provided secrets need nothing either: `qa_password`, `email_code` and
`email_link` (`AGENT_PROVIDED_SECRETS`) are minted mid-run, so the US-059 OTP
work does not wait on this story.

**What is genuinely left is a secret typed mid-run that is not a login** — a
coupon code, an API token pasted into a form, a payment-sandbox card. Before
building anything here, establish that this case is real for someone. If it is
thin, option C below is the whole story and it costs a day.

## Approaches (decide before implementing)

**A — encrypted overrides on the schedule row.** `schedules.secret_variables`,
encrypted with `server/src/crypto.js` exactly as the BYOK key and the session
blob already are, decrypted in the tick and passed as `opts.variables`.
Per-schedule scope, so two schedules over the same suite can carry different
credentials, and deleting the schedule deletes the secret with it. Cost: a new
at-rest secret store plus the editor UI to fill it.

**B — encrypted default on the declaration.** `tests.variables[].value`
encrypted when `secret`. The existing editor field simply stops clearing, and
it fixes manual and CI runs at the same time — but every run path then reads a
stored default, which reverses US-035's contract far more broadly than A does
for a benefit only the schedule asked for.

**C — refuse it, loudly, at save.** Validate at schedule create/update that no
target test references a non-optional secret, and reject with the reason. No
new secret storage anywhere. This is the honest answer if demand is thin — and
it is worth doing *as part of* A or B regardless, because a target that still
cannot resolve should be refused when it is saved, not at 02:00.

**Recommendation: C now, unconditionally. A only if the demand question above
comes back yes** — per-schedule keeps the blast radius to one row and reuses an
encryption path that already exists, and B's reach is not paid for by the case
that motivated it.

## Assertion-first — this is correctness-critical

It puts a secret value at rest and routes it through `resolveForRun` on the one
path where nobody is watching the outcome. Same class as the US-035 secret path
already in the register, and the maintainer writes/reviews the assertions before
the implementation:

- a stored schedule secret never appears in a `GET /api/schedules` response, in
  `runs.variables`, in `run.goal`, or in a scheduler log line
- `resolveForRun` still routes it on the `secrets` channel only — the existing
  US-035 assertions must pass unchanged with a schedule-supplied value
- a schedule whose secret cannot resolve starts no run **and says so** (the
  BUG-005 behaviour, which this depends on being fixed first)
- decrypt failure skips the member with an error marker, like a session that
  cannot be decrypted (`runs.js:441`), rather than starting a run with an empty
  secret

**Add a row to [`correctness-critical.md`](../../correctness-critical.md) as
part of doing this**, next to the existing "Secret variables (US-035)" row —
the register's rule is that the row lands with the work, not before it.

## Frontend

`frontend/src/SchedulesView.jsx` is target and cadence only — it never mentions
variables, so today you can schedule a test with a required secret and get no
warning at save and no signal afterwards. Whatever lands needs:

- the schedule editor listing the target's declared secrets, with a masked
  input per secret and a plain **set / not set** state (never the value back)
- option C's refusal surfaced at save, in the words of the failure it prevents
- for a module/suite/project target, the union of the members' declared secrets,
  since one override sprays every member (US-035 group semantics)

## Acceptance criteria

1. A schedule over a test with a required secret either runs it correctly or is
   refused at save — it never fires into a dropped member.
2. A stored secret is encrypted at rest and appears in no API response, run row,
   report or log line.
3. An optional secret with no value no longer silently types an empty string —
   the run is skipped with a stated reason, or the schedule was refused at save.
4. The US-043 path is untouched: a scheduled login-gated test with a saved
   session still needs no secret variable.
5. `variables.test.js`'s existing secret block passes unchanged.
