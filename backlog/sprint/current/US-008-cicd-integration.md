# US-008 — CI/CD trigger: the documented pipeline step

**As a** developer, **I want** QAssist runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** 🧱 **2/5 — the script itself is verified** (2026-07-25). Docs
  written 2026-07-23; `staging.qassist.run` (US-038) is now the deployment a
  runner can reach, and `docs/ci.md`'s `qassist-run.sh` was extracted **verbatim
  from the doc** and run against it: a green suite exited 0, a mixed suite exited
  1 and printed the failing run's permalink, one `POST /api/suites/<id>/run`
  batched two runs, the poll loop handled the second queueing behind the first at
  `MAX_CONCURRENT_SESSIONS=1`, and a `start_url` argument overrode the saved URL
  on the run it started. So the snippet is no longer hypothetical.

  **Still owed:** the module-by-slug endpoint (only the suite path was
  exercised), and running either from a **real** GitHub Actions or GitLab runner
  rather than a shell. The remaining risk is the pipeline YAML and the secret
  plumbing around the script, not the script.
- **Priority:** P1 (current sprint)
- **Estimate:** ~half a day including docs, once US-009 is in
- **Depends on:** US-007 (public HTTPS) + US-009 (saved tests) — both hard requirements
- **Followed by:** [US-029](../../unscheduled/US-029-cicd-action-and-github-app.md)
  — the reusable Action and the GitHub App, split out 2026-07-23 so this story
  is exactly what the current sprint owes

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

**Suites keep their uuid in CI configs** (decided 2026-07-23). They never got
a slug column, and the story doesn't buy one: a suite target is one line in
one pipeline file, and a migration plus slug handling on create/update is more
surface than that line is worth. Revisit if suite renames start breaking
configs in practice.

**No batch-status endpoint** (same date). Triggering returns N run ids and the
snippet polls `GET /api/runs/:id` per id in a loop. A `GET /api/runs?ids=…`
would roughly halve the snippet, but the scope line says no new server surface
and the loop is ~10 lines of bash.

**Gate on `passed` only.** `completed` means the agent finished its steps
without producing a verdict — the run answered nothing, and a build going
green on that is the false signal the step exists to prevent. So the script
fails the job on anything that isn't `passed`.

**The `start_url` override replaces the whole URL, not a prefix** — a test
saved against `example.com/login`, run with `start_url=preview.app`, starts at
that preview's root. The docs tell CI users to author tests that navigate from
the app root instead of teaching a path-join rule that would need server work
and would still guess wrong.

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
- [x] `start_url` override respected for every run the trigger started — the
      snippet's second argument reached the run: a test saved against
      `https://example.com/` recorded `http://example.com/` in `runs.start_url`
      and the agent visited it (staging, 2026-07-25)
- [x] The docs say why a single test and a whole project aren't CI targets, so
      the omission reads as a decision rather than a gap

Dropped 2026-07-23: *report PDF URL printed in job output*. The PDF needs the
bearer token, so a link in a job log isn't clickable by whoever reads it, and
`report_status` is still `generating` for a moment after a run goes terminal —
printing the URL at that point promises a file that 202s. The log prints the
run id and the docs point at History, which has the report behind a session.
Revisit alongside US-020 (report v2) if the report becomes the artifact CI
users want in hand.
