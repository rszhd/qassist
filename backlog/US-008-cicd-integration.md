# US-008 — CI/CD integration (GitHub / GitLab)

**As a** developer, **I want** QAgent runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** 📋 Planned
- **Priority:** P2
- **Estimate:** tiered (see below)
- **Depends on:** US-007 (public HTTPS) — hard requirement

## Rollout tiers

1. **CI step** (~works the moment US-007 lands): pipeline `POST`s to
   `/api/runs`, polls `GET /api/runs/:id`, fails the job on `failed`.
   Document a copy-paste snippet for GitHub Actions + GitLab CI. (~half day
   incl. docs/polish)
2. **Reusable Action** — `qagent/run-tests@v1`: wraps start+poll, fails the
   job on a failing test, links the PDF report in the job summary. (~1–2 days)
3. **GitHub App** — webhook-driven runs posting **PR status checks**
   (optionally gating merge); GitLab equivalent via webhooks + commit-status
   API. Needs the control plane (US-009) for installations/config. (~1 week+)

## Best-practice pattern to document

Trigger on **deploy success** and test the fresh **preview URL**
(Vercel/Netlify/CD), not the raw merge — the agent should test what users will
actually hit.

## Acceptance criteria (tier 1)

- [ ] A GitHub Actions job can start a run, wait for the verdict, and fail on
      a failing test using only `curl` + the documented snippet
- [ ] Report PDF URL printed in job output
