# US-008 — CI/CD trigger: the documented pipeline step

**As a** developer, **I want** QAssist runs triggered from my CI/CD pipeline with results reported back, **so that** every deploy is smoke-tested by a real browser agent without manual steps.

- **Status:** ✅ **Closed 2026-07-26 — the snippet ran from a real runner.**
  Docs written 2026-07-23; the script proven in a shell against
  `staging.qassist.run` on 2026-07-25 (green suite exited 0, mixed suite exited
  1, one `POST /api/suites/<id>/run` batched two runs, the poll loop handled the
  second queueing behind the first at `MAX_CONCURRENT_SESSIONS=1`, `start_url`
  honoured).

  What 2026-07-26 added is the part that was still owed. `docs/ci.md`'s
  `qassist-run.sh` was extracted **verbatim** (sha256 `ee951934…`, byte-identical
  to the fenced block — **superseded 2026-07-27 by `4d2f5ea8…`**, see the note at
  the end) onto a throwaway `us-008-verify` branch and run by
  **GitHub Actions** against staging: module by slug green, suite by uuid green,
  and a mixed suite whose job came out **red** — the gate proving it fails a
  build rather than just reporting. All four runs are in staging's `runs` table
  with `trigger = 'ci'` and the overridden `start_url`. The branch, its workflow
  and the staging API key were deleted afterwards; the deliverable is the doc,
  not the scaffolding.

  **The runner found a doc defect a shell never could** — the exact risk this
  step existed to cover. The failing line printed `***/runs/<id>`: Actions
  redacts secret *values* wherever they appear in a log, and the doc had told
  users to store `QASSIST_URL` as a secret, so every permalink it promised was
  unopenable. Fixed in `docs/ci.md` — the base URL is a public hostname and now
  goes in GitHub `vars` (unmasked on GitLab), with only the token a secret. That
  is a one-line YAML change that no amount of running the script by hand would
  have surfaced.
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

- [x] A GitHub Actions job can trigger a module by slug, wait for every test
      in it to finish, and fail the job if any test fails — using only `curl`
      plus the documented snippet (run 30206357362, 2026-07-26:
      `/api/projects/acme-storefront/modules/smoke/run` → `passed`, job green;
      the red job below is the same script failing a build on a `failed` verdict)
- [x] Same for a suite — one snippet serves both, with the target URL as its
      only variable (same run: green suite green, mixed suite **red** on a real
      `failed` verdict, permalink printed)
- [x] Same two, documented for GitLab CI — **documented, not executed**, by
      decision 2026-07-26: the criterion asks for a documented snippet, and the
      script is shell-identical across both, so a gitlab.com account with runner
      minutes buys re-proof of `curl` rather than of anything GitLab-specific.
      The GitLab-specific risk is variable masking, and that is exactly what the
      Actions run caught and the doc now covers for both
- [x] `start_url` override respected for every run the trigger started — the
      snippet's second argument reached the run: a test saved against
      `https://example.com/` recorded `http://example.com/` in `runs.start_url`
      and the agent visited it (staging, 2026-07-25)
- [x] The docs say why a single test and a whole project aren't CI targets, so
      the omission reads as a decision rather than a gap

## Found on the way, not fixed here

**`POST /api/tests` silently ignores slug grouping keys.** Creating a test with
`{"project":"acme-storefront","module":"smoke"}` returns 201 with
`project_id: null, module_id: null` — `resolveGrouping` reads only the
`project_id`/`module_id` uuid forms, and unknown keys are dropped without an
error. Every *path* param takes a slug or a uuid (US-023), so a body that
doesn't is a trap, and the failure mode is silent: the caller believes it filed
the test and the module runs without it. Out of scope for a docs story — the CI
snippet never creates tests — but it belongs to whoever next touches
`routes/tests.js`. Either accept the slug forms or 400 on unknown keys; silently
discarding them is the one option that should go.

Dropped 2026-07-23: *report PDF URL printed in job output*. The PDF needs the
bearer token, so a link in a job log isn't clickable by whoever reads it, and
`report_status` is still `generating` for a moment after a run goes terminal —
printing the URL at that point promises a file that 202s. The log prints the
run id and the docs point at History, which has the report behind a session.
Revisit alongside US-020 (report v2) if the report becomes the artifact CI
users want in hand.

## Amended 2026-07-27 by US-047

The script gained a third outcome and its hash moved: `ee951934…` →
`4d2f5ea8…`. US-047 made `cancelled` a terminal status, and "a stopped run is
not a red build" is one of that story's acceptance criteria — so the `if
[ "$status" = passed ]` became a `case` whose `cancelled` branch prints `STOP`
with the run's link and leaves `exit_code` alone. Everything else in the script
is byte-identical, including the `*)` branch this story's real Actions run
proved red.

Not re-run on a real runner. The Actions run's value was catching what a shell
could not — secret masking eating the permalink — and this change adds a branch
to a `case`, not a new interaction with the CI system. It was instead exercised
against a stub in an **Alpine container**, the same image `docs/ci.md`'s own
GitLab job describes, because the dev box has no `jq`: a lone `cancelled` exits
0, a `passed,cancelled,failed` batch still exits 1 (a stop suppresses nothing),
`completed` still exits 1.

Worth knowing rather than buried: the change means a job whose runs were *all*
stopped exits 0 having verified nothing, so anyone who can reach the UI can
green a gate by stopping its runs. That is the right default — a red build for
the one action whose purpose is to stop spending would make the feature cost an
incident — and `docs/ci.md` now says so, and tells a release gate which single
line to move.
