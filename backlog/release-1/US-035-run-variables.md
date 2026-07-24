# US-035 — Per-run variables (environment overrides)

**As a** user running the same saved test across dev, staging and production,
**I want** to define named variables in a test and override them when I start a
run, **so that** one test covers every environment — and CI can inject the
right values per pipeline — instead of me cloning the test per environment.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1)
- **Estimate:** TBD
- **Depends on:** US-009 (saved tests) — the variable defaults live on a test.
  Pairs with [US-008](US-008-cicd-integration.md), whose CI snippet is the
  second consumer.

## Why

`start_url` is already a per-run override (US-008: CI points a saved test at a
fresh preview URL). But a real environment differs by more than its URL — a
login user, a password, an API base, a coupon code, a tenant id. Today the only
way to vary those is to write them into the goal string and clone the test per
environment, which is the duplication saved tests exist to avoid. This story
generalizes the one built-in override into arbitrary named variables:
`start_url` becomes the first of them rather than a special case.

## Shape (to refine)

- A test carries a set of **variables**: `name`, a **default value**, and a
  `secret` flag. The goal (and `start_url`) reference them by name.
- At **run creation** the user sees each variable pre-filled with its default
  and can override any of them for this run. No override ⇒ default is used.
- **CI** passes the same thing in the trigger body — `variables: { … }` merged
  over the defaults, exactly as `start_url` is passed today (US-008). One
  pipeline per environment supplies that environment's values.
- Overriding a project/module/suite run applies the overrides to **every** test
  it starts (like the existing `start_url` override in `startRunGroup`), with
  each test filling unreferenced names from its own defaults.

## Decisions (resolved 2026-07-24)

- **Storage:** `jsonb` on both tables — `tests.variables` (array of
  `{name, value, secret, optional}` declarations) and `runs.variables` (the
  resolved non-secret map, denormalized for history). Migration `005`. No child
  table; matches the denormalize-at-enqueue pattern goal/start_url already use.
- **Optional & default are both per-variable, user-set.** A variable may carry a
  default `value` and/or be flagged `optional`. A referenced non-optional
  variable that resolves empty (no default, no override) rejects the run; an
  optional one substitutes empty.
- **Substitution boundary:** `{{name}}` in goal/start_url. The server resolves
  overrides-over-defaults at enqueue and substitutes **non-secret** values into
  `QA_GOAL`/`QA_START_URL` (stored on `run.goal`). **Secret** values are *not*
  substituted server-side — they route to the agent as placeholders + a
  `QA_VARS` env (browser-use `sensitive_data`), so they never touch `QA_GOAL`,
  the report, or the run row. Pure logic in `server/src/variables.js`.
- **Validation:** reject at save time when goal/start_url references an
  undeclared `{{name}}` (a silent literal is a false-green risk).
- **Group override:** a suite/module/project/scheduler run sprays one
  `variables` override across every member; each test substitutes the names it
  declares and fills the rest from its own defaults. A member that can't resolve
  is skipped with an `error` marker rather than blocking the batch.

**Implementation status:** non-secret path shipped end to end — backend
(migration, tests CRUD + validation, single + group run substitution,
`runs.variables` persistence and history exposure) **and UI** (progressive
disclosure: a variable-less test is unchanged; declaring lives behind a quiet
"Add variable" affordance in the create/edit dialog; a variable'd test's Run
opens a defaults-prefilled override dialog; RunDetail shows a run's resolved
non-secret variables). The `secret` flag is deliberately kept out of the UI so
you can't build a test the server would reject.

The **secret** path is now shipped (backend + agent), assertion-first: the
maintainer reviewed the `resolveForRun` and `QA_VARS` assertions
(`variables.test.js` secret block, `agent/tests/test_secret_vars.py`) before the
implementation. A referenced secret's real value leaves `resolveForRun` only on
a `secrets` channel — never the substituted goal/start_url, never the persisted
`run.variables` (which carries it as the presence marker `'<secret>'`). The run
engine hands `secrets` to the agent as an in-memory-only `QA_VARS` env (never
persisted or serialized); `secret_vars.load` merges it into the browser-use
`sensitive` dict so `<secret>name</secret>` substitutes at type-time and
`redact.scrub` strips it from every emitted event. A secret referenced in
`start_url` is rejected (a secret in a URL is the exact leak US-034's scrub
patches). Still out of the UI (declaring a secret) and still remaining: **Report
(PDF) display** of a run's non-secret variables.

## Open design decisions (raise before implementing)

- **Placeholder syntax & where substitution happens.** e.g. `{{name}}` in the
  goal, resolved server-side before the agent spawns (the server already builds
  `QA_GOAL`/`QA_START_URL` env in `runs.js`). Values the *agent* types (a
  password it enters into a form) need to reach it as well — probably a
  `QA_VARS` JSON env alongside the substituted goal. Decide the boundary: what
  the server substitutes into the prompt vs. what the agent receives to use.
- **Secrets are correctness-critical — redaction owns this.** A `secret`
  variable's value (passwords, tokens) must never reach frames, step logs, the
  report, or the persisted run row un-redacted. `agent/redact.py` (`scrub`) is
  the existing surface; a run's stored variables must be redacted before
  persistence. This is exactly the assertion-first class in
  `backlog/correctness-critical.md` — the maintainer writes/reviews the
  redaction assertion first. Add a row there when this is scheduled.
- **Persistence / history.** History should show *which environment* a run
  used (so a failure is attributable), which means storing the non-secret
  resolved variables on the run. Secret values are stored redacted or as
  presence-only. Decide the column shape (a `jsonb variables` on `runs`, and
  whether defaults live on `tests` as `jsonb` or a child table).
- **Validation.** A goal referencing `{{coupon}}` with no such variable and no
  override: reject at create time, or run with the literal text? Reject reads
  safer — a silent literal is a false-green risk.
- **UI (progressive disclosure).** A test with no variables shows no variable
  UI — the Run view stays exactly the pre-variable form. Variables appear only
  once a test defines them, matching the grouping rule in CLAUDE.md.

## Acceptance criteria (draft)

- [ ] A saved test can declare named variables with defaults and a `secret`
      flag; the goal/`start_url` reference them
- [ ] Starting a run pre-fills defaults and lets the user override per run
- [x] CI can override the same variables via the trigger body (one snippet,
      values as its only per-environment change) — generalizing US-008's
      `start_url`
- [x] A `secret` variable's value never appears un-redacted in frames, steps,
      the report, or the persisted run (assertion-first, maintainer-owned) —
      routed via `secrets`→`QA_VARS`→`sensitive`, persisted as `'<secret>'`
- [ ] History shows which environment/values a run used (non-secret)
- [ ] A test with no variables is indistinguishable from today's Run view
