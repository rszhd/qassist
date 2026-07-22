# US-008 — CI/CD integration (GitHub / GitLab)

**As a** developer, **I want** QAssist runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1 — tier 1 only; tiers 2–3 stay on the backlog)
- **Estimate:** tiered (see below)
- **Depends on:** US-007 (public HTTPS) + US-009 (saved tests) — both hard requirements

## Design decision

CI does **not** describe tests inline (no goal strings in pipeline YAML — no
use case for it). Users create test cases in the QAssist UI first (US-009),
optionally group them into suites, and CI triggers by **test-case id or
suite id** only. The test definitions live server-side and evolve without
touching the pipeline.

**Updated 2026-07-22 by [US-023](US-023-projects-and-modules.md).** Two more
trigger targets exist: `POST /api/modules/:id/run` (everything in one module,
e.g. "run the auth tests") and `POST /api/projects/:id/run`. Document modules
alongside suites — modules are the likelier CI target, since they map to a
part of the app rather than a curated selection. US-023 also proposes
**slugs** on projects/modules so pipeline YAML can read
`/api/projects/checkout/modules/auth/run` instead of carrying UUIDs; that
decision is open and this story is its main consumer.

## Rollout tiers

1. **CI step**: pipeline `POST`s to `/api/tests/:id/run` (or
   `/api/suites/:id/run`), polls run status, fails the job on a failing
   verdict. Body accepts an optional `start_url` override so CI can point the
   saved test at a fresh preview URL. Document a copy-paste snippet for
   GitHub Actions + GitLab CI. (~half day incl. docs/polish, once US-009 is in)
2. **Reusable Action** — `qassist/run-tests@v1`: wraps trigger+poll, takes
   `test_id`/`suite_id` + optional `start_url`, fails the job on a failing
   test, links the PDF report in the job summary. (~1–2 days)
3. **GitHub App** — webhook-driven runs posting **PR status checks**
   (optionally gating merge); GitLab equivalent via webhooks + commit-status
   API. Repo↔suite mapping lives in the control plane. (~1 week+)

## Best-practice pattern to document

Trigger on **deploy success** and pass the fresh **preview URL**
(Vercel/Netlify/CD) as the `start_url` override, not the raw merge — the
agent should test what users will actually hit.

## Acceptance criteria (tier 1)

- [ ] A GitHub Actions job can trigger a saved test by id, wait for the
      verdict, and fail on a failing test using only `curl` + the documented
      snippet
- [ ] Same for a suite id: all member tests run, job fails if any test fails
- [ ] Same for a module id (US-023), documented as the default recommendation
- [ ] `start_url` override respected for the triggered run(s)
- [ ] Report PDF URL(s) printed in job output
