# US-029 — CI/CD tiers 2 & 3: reusable Action + GitHub App

**As a** developer, **I want** QAssist wired into my repo rather than into my pipeline script, **so that** triggering tests and reading their verdicts costs no YAML of my own and shows up where I review code.

- **Status:** 📋 Planned
- **Priority:** P2
- **Estimate:** tier 2 ~1–2 days, tier 3 ~1 week+
- **Depends on:** [US-008](../sprint/current/US-008-cicd-integration.md) tier 1
  (the documented `curl` snippet is what both tiers wrap)

## Why this is its own story

Split out of US-008 on 2026-07-23. The current sprint owes the CI step and nothing
more, and a story whose acceptance criteria are two-thirds out of scope makes
the release folder lie about what is left — `ls sprint/current/` is supposed to be
the remaining work. US-008 keeps tier 1 and ships; this file carries the rest,
unscheduled until there is demand for it.

Nothing here changes the trigger API. Both tiers are packaging around the same
`POST /api/tests|suites|modules|projects/:id/run` + poll that tier 1
documents, so neither should need a server change beyond what tier 1 lands.

## Tiers

1. **Reusable Action** — `qassist/run-tests@v1`: wraps trigger+poll, takes a
   module or suite (US-008's two CI targets, by slug) plus an optional
   `start_url`, fails the job on a failing test, and links the PDF report in
   the job summary. (~1–2 days)
2. **GitHub App** — webhook-driven runs posting **PR status checks**,
   optionally gating merge; GitLab equivalent via webhooks + the commit-status
   API. The repo↔suite mapping lives in the control plane, which is the first
   thing here that is not just packaging. (~1 week+)

Tier 2 is worth doing on its own; tier 3 only pays off once someone wants
merges gated on a browser verdict, and it wants US-021 (real accounts) under
it — a GitHub App installed against a single-token deployment has nowhere to
put the mapping.

## Acceptance criteria

### Tier 2 — reusable Action

- [ ] A workflow using `qassist/run-tests@v1` with a module or suite slug runs
      it and fails the job on a failing verdict
- [ ] `start_url` input overrides the saved test's URL, so a preview
      deployment can be tested
- [ ] The job summary links the report PDF for every run the step started
- [ ] The Action's own release/versioning story is documented (`@v1` tag
      moves; `@v1.2.3` pins)

### Tier 3 — GitHub App

- [ ] Installing the App on a repo and mapping it to a suite makes a push
      post a PR status check carrying the verdict
- [ ] A failing check links the report; a passing one is quiet
- [ ] The mapping survives a re-install and is editable in the UI
- [ ] GitLab: the same via webhooks + commit-status API
