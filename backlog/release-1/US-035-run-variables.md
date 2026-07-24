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
- [ ] CI can override the same variables via the trigger body (one snippet,
      values as its only per-environment change) — generalizing US-008's
      `start_url`
- [ ] A `secret` variable's value never appears un-redacted in frames, steps,
      the report, or the persisted run (assertion-first, maintainer-owned)
- [ ] History shows which environment/values a run used (non-secret)
- [ ] A test with no variables is indistinguishable from today's Run view
