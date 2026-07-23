# US-008 — CI/CD trigger: the documented pipeline step

**As a** developer, **I want** QAssist runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1)
- **Estimate:** ~half a day including docs, once US-009 is in
- **Depends on:** US-007 (public HTTPS) + US-009 (saved tests) — both hard requirements
- **Followed by:** [US-029](../unscheduled/US-029-cicd-action-and-github-app.md)
  — the reusable Action and the GitHub App, split out 2026-07-23 so this story
  is exactly what Release 1 owes

## Design decision

CI does **not** describe tests inline (no goal strings in pipeline YAML — no
use case for it). Users create test cases in the QAssist UI first (US-009),
optionally group them into suites, and CI triggers by **test-case id or
suite id** only. The test definitions live server-side and evolve without
touching the pipeline.

**Updated 2026-07-22 by [US-023](done/US-023-projects-and-modules.md).** Two more
trigger targets exist: `POST /api/modules/:id/run` (everything in one module,
e.g. "run the auth tests") and `POST /api/projects/:id/run`. Document modules
alongside suites — modules are the likelier CI target, since they map to a
part of the app rather than a curated selection. US-023 shipped **slugs** on
projects and modules — every path param takes a slug or a uuid — so the
documented snippet should read `/api/projects/checkout/modules/auth/run`
rather than carry UUIDs through pipeline YAML.

## Scope

The pipeline `POST`s to `/api/tests/:id/run` (or `/api/suites/:id/run`,
`/api/modules/:id/run`, `/api/projects/:id/run`), polls run status, and fails
the job on a failing verdict. The body accepts an optional `start_url`
override so CI can point a saved test at a fresh preview URL. What ships is a
copy-paste snippet for GitHub Actions and GitLab CI — no Action, no App, no
new server surface beyond documenting what US-009/US-023 already expose.

## Best-practice pattern to document

Trigger on **deploy success** and pass the fresh **preview URL**
(Vercel/Netlify/CD) as the `start_url` override, not the raw merge — the
agent should test what users will actually hit.

## Acceptance criteria

- [ ] A GitHub Actions job can trigger a saved test by id, wait for the
      verdict, and fail on a failing test using only `curl` + the documented
      snippet
- [ ] Same for a suite id: all member tests run, job fails if any test fails
- [ ] Same for a module id (US-023), documented as the default recommendation
- [ ] `start_url` override respected for the triggered run(s)
- [ ] Report PDF URL(s) printed in job output
