# US-008 — CI/CD trigger: the documented pipeline step

**As a** developer, **I want** QAssist runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1)
- **Estimate:** ~half a day including docs, once US-009 is in
- **Depends on:** US-007 (public HTTPS) + US-009 (saved tests) — both hard requirements
- **Followed by:** [US-029](../unscheduled/US-029-cicd-action-and-github-app.md)
  — the reusable Action and the GitHub App, split out 2026-07-23 so this story
  is exactly what Release 1 owes

## Design decisions

CI does **not** describe tests inline (no goal strings in pipeline YAML — no
use case for it). Users create test cases in the QAssist UI first (US-009) and
group them; the definitions live server-side and evolve without anyone
touching the pipeline.

**A pipeline triggers a module or a suite — nothing else** (decided
2026-07-23; this story previously documented single tests and projects too).
Both are *the set of tests that covers a change*, which is the unit a job can
gate on: a module maps to a part of the app, a suite is a curated selection
across modules. The two we dropped are the two that aren't that unit. A single
test is not a gate — a deploy check that runs one goal and calls the build
green is a false signal, and pipelines that want it end up listing ten ids by
hand, which is a suite spelled badly. A whole project is every test there is:
minutes of browser time and LLM spend per push, which is a nightly schedule
(US-010), not a per-deploy gate.

`POST /api/tests/:id/run` and `POST /api/projects/:id/run` still exist and
still work — the UI runs both, and no endpoint is being removed. They just
aren't what the CI docs teach, and the snippet shouldn't offer four targets
where two are right.

US-023 shipped **slugs** on projects and modules — every path param takes a
slug or a uuid — so the documented snippet reads
`/api/projects/checkout/modules/auth/run` rather than carrying UUIDs through
pipeline YAML.

## Scope

The pipeline `POST`s to `/api/projects/:project/modules/:module/run` (the
nested form is what the docs show — `checkout/modules/auth` reads as what it
runs, where `/api/modules/:id/run` does not) or `/api/suites/:id/run`, polls
run status, and fails the job on a failing verdict. The body accepts an
optional `start_url` override so CI can point the saved tests at a fresh
preview URL. What ships is a copy-paste snippet for GitHub Actions and GitLab
CI — no Action, no App, no new server surface beyond documenting what
US-009/US-023 already expose.

## Best-practice pattern to document

Trigger on **deploy success** and pass the fresh **preview URL**
(Vercel/Netlify/CD) as the `start_url` override, not the raw merge — the
agent should test what users will actually hit.

## Acceptance criteria

- [ ] A GitHub Actions job can trigger a module by slug, wait for every test
      in it to finish, and fail the job if any test fails — using only `curl`
      plus the documented snippet
- [ ] Same for a suite — one snippet serves both, with the target URL as its
      only variable
- [ ] Same two, documented for GitLab CI
- [ ] `start_url` override respected for every run the trigger started
- [ ] Report PDF URL printed in job output for each run
- [ ] The docs say why a single test and a whole project aren't CI targets, so
      the omission reads as a decision rather than a gap
