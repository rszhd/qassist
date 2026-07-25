# US-032 — CI on every push, a published image on every tag

**As a** self-hoster, **I want** `docker compose up` to pull a versioned QAssist image someone else already built and tested, **so that** I can run a known-good release without cloning the source, installing Chromium, or trusting a `latest` tag that changes under me.

- **As the maintainer**, the same pipeline is what stops a broken `dev` from
  looking green: 99 server tests, a typecheck and a frontend build exist and
  currently only ever run when I remember to run them.

- **Status:** 🧱 **4 of 5 criteria met — v0.1.0 published** (2026-07-25) —
  `ci.yml` passes on `dev`: three jobs in ~40 s, 258 server tests against a real
  Postgres with all five `*-postgres.test.js` files confirmed *running* rather
  than skipping, 31 frontend, 63 agent, typecheck and the frontend build. That
  closes the first two criteria.

  `v0.1.0` was then cut from `main` and `release.yml` ran green end to end:
  `ghcr.io/rszhd/qassist:0.1.0`, `:0.1` and `:latest` are published and
  anonymously pullable, the version-pin guard matched, and the `workflow_call`
  reuse put the test jobs ahead of the image job as designed.

  **One criterion is left:** starting the published image on a machine that has
  never seen the source. That is a `docker compose -f docker-compose.release.yml
  up` on the VPS, which is also the first half of US-007's stand-up — so this
  story now finishes on the box, alongside US-007 and US-038.
- **Priority:** P1 (current sprint) — `docs/repo-model.md` rule 1 makes the
  published image *the* artifact the product ships
- **Estimate:** ~half a day (the image build is slow to iterate on)
- **Depends on:** [US-031](done/US-031-license-and-public-repo.md) — Actions and
  ghcr are free on a public repo, and a private repo burns minutes

## Design decisions (2026-07-23)

**Registry: ghcr.io.** No second account and no separate credentials — the
release workflow pushes with the `GITHUB_TOKEN` it already has, and the image
lives at the repo it was built from, tagged in step with it. Docker Hub is more
discoverable and can be mirrored later if anyone asks; its pull-rate limits
would land on *users*, which is a poor thing to hand a self-hoster on day one.

**Two workflows, not one.** `ci.yml` runs on every push and PR and is fast
(server tests, typecheck, frontend build — a few minutes, no Docker).
`release.yml` runs only on a `v*` tag and is slow (a full image build: Python,
Playwright Chromium and its system libraries). Keeping them apart means the
feedback loop on a normal push doesn't wait on Chromium, and a tag can't ship
an image whose tests were never run — `release.yml` runs the test job first and
builds only if it passes.

**amd64 only for v1.** `linux/arm64` doubles the build with QEMU emulation on
a Chromium image, for an audience (Apple Silicon, Pi) that is not who runs a
browser-testing server. Add it when someone asks.

**Postgres service in CI, not just pg-mem.** The suite runs on pg-mem, and
CLAUDE.md records what that hides — partial indexes, array binding, timestamp
precision. `scheduler-postgres.test.js` already skips with a reason when no
server answers, which in CI means it would *always* skip and the one file
written to catch real-Postgres bugs would never run. So `ci.yml` gives the job
a `postgres:16-alpine` service and sets `TEST_DATABASE_URL`, and the skip
becomes the local-developer path rather than the norm.

**Version tags: `v1.0.0` on the tag, three tags on the image.** A tag `v1.0.0`
publishes `:1.0.0`, `:1.0` and `:latest`. Self-hosters get told to pin the
exact version; `:latest` exists because people type it anyway. The release is
cut from `main`, not `dev`.

**A separate compose file for running the published image.** `docker-compose.yml`
keeps `build: .` — it is the developer's file and a fresh clone still builds
from source. `docker-compose.release.yml` is the same file with the build
stanza replaced by `image: ghcr.io/<owner>/qassist:<version>`, and it is what
the README's quick start hands a self-hoster: three commands, no toolchain, no
20-minute first build. The two files must be kept in step; the release workflow
is the natural place to fail if the pinned version doesn't match the tag.

## Details

- `.github/workflows/ci.yml` — on push + PR: `npm ci` in `server/`, `npm test`
  and `npm run check` against a `postgres:16-alpine` service, then `npm ci &&
  npm run build` in `frontend/`.

  **Three things the implementation added (2026-07-25):**

  1. **The Postgres service is load-bearing for five files, not one.** The
     design note above names `scheduler-postgres.test.js`; there are also
     `auth-`, `billing-webhook-`, `openai-key-` and `demo-reaper-postgres`.
     All five share one convention — they log `<name>-postgres: skipped —
     <reason>` and then pass — so the guard is a single grep for
     `-postgres: skipped` over the captured output, and it fails the job. That
     is the criterion below, and it covers every file rather than the one the
     story happened to name.
  2. **`set -o pipefail` before `npm test | tee`.** Actions' default shell is
     `bash -e`, *without* pipefail, so a piped `npm test` reports `tee`'s exit
     status and a failing suite goes green. Introducing that bug in the step
     whose purpose is catching silent green would have been a poor trade.
  3. **A third job: the agent's 63 pytest units.** Not in this story's Details,
     added because the maintainer's stated reason for the story is "tests that
     only ever run when I remember to run them" — and the agent suite is one of
     those. It costs seconds: every module under `agent/tests/` imports stdlib
     alone (`agent/pytest.ini` says so deliberately), so the job installs
     `pytest` and nothing else. No browser-use, no Playwright, no
     `requirements.txt`.

  `release.yml` reuses this file via `workflow_call` rather than copying the
  steps, so "a tag cannot ship an image whose tests never ran" is a property of
  the job graph instead of a convention.

  **Two things from the first real run (2026-07-25):**

  - **The first attempt failed with no jobs, no logs and no check runs**, under
    GitHub's generic "this run likely failed because of a workflow file issue".
    It was not the workflow file: actionlint was clean, a strict duplicate-key
    parse was clean, and there was no BOM, tab or invisible-unicode problem. A
    plain re-run of the same commit went green. The repo's visibility had been
    flipped seconds earlier and the API was serving intermittent internal
    errors, so this reads as a GitHub-side hiccup on a repo's first-ever run.
    Worth knowing before anyone debugs a phantom YAML error: **re-run once
    before believing that message.**
  - **Every action pin was several majors stale** and the run warned that
    Node 20 is deprecated and being forced onto Node 24. Bumped to
    `checkout@v7`, `setup-node@v7`, `setup-python@v7`,
    `setup-buildx-action@v4`, `login-action@v4`, `metadata-action@v6`,
    `build-push-action@v7`. `release.yml` got the same bump, and `v0.1.0`
    exercised all four `docker/*` actions at those versions — the annotations
    on both workflows are now clean.
- `.github/workflows/release.yml` — on `v*`: the CI job, then
  `docker/build-push-action` with `docker/metadata-action` deriving the three
  tags, pushing to `ghcr.io`. Layer caching via `type=gha` so a re-run of a
  failed release isn't another cold Chromium install.
- The image is built from the repo root `Dockerfile` unchanged — it is already
  a two-stage build that carries the frontend bundle, so nothing about the
  runtime needs to change for this story.
- README: a "Run a release" quick start (pull + `docker-compose.release.yml`)
  above the existing build-from-source instructions, and the image URL in the
  Packaging row.

**Two implementation notes on the image name and the pin (2026-07-25):**

- **The image path must be lowercase.** ghcr rejects an uppercase path
  component, and the repo was `rszhd/QAssist` when this was written — which is
  what turned US-031's rename from cosmetic into load-bearing. It is now
  `rszhd/qassist`, so `${{ github.repository }}` would work; the image is still
  a lowercase literal `ghcr.io/${{ github.repository_owner }}/qassist` on
  purpose, so that a future rename cannot silently move an image path
  self-hosters have pinned.
- **`docker-compose.release.yml` is standalone, not an overlay**, because the
  acceptance criterion is a machine that never saw the source: it must be one
  downloadable file that cannot reference a file you don't have. The cost is a
  duplicate of the base compose file carrying a hardcoded image tag, which is
  exactly the sort of thing that falls a release behind — so `release.yml`'s
  first step greps the pin out of it and fails the release if it doesn't equal
  the tag being cut. It also drops the base file's published `5433`: a release
  user has no reason to reach Postgres from the host, and the fixed
  `qassist:qassist` credentials are only safe because nothing off the compose
  network can.

## Acceptance criteria

- [x] A push to `dev` runs tests, typecheck and the frontend build, and the
      run is red when any of them fail — first run 2026-07-25: all three jobs
      green in ~1 min (258 server tests, 31 frontend, 63 agent, typecheck,
      frontend build). *The red half is only partly earned:* the skip guard was
      tested locally in both directions (it matches a real skip line and does
      not false-positive on a clean log), but no genuinely failing suite has
      been pushed, so "red when it should be" rests on `set -o pipefail` being
      correct rather than on having been observed.
- [x] `scheduler-postgres.test.js` **runs** in CI (not skipped) — proven. All
      **five** `*-postgres.test.js` files ran against the service container,
      the guard printed `None skipped.`, and the suite reported `# skipped 0`.
      The guard covers all five rather than only the file this story named.
- [x] Tagging `v1.0.0` publishes `ghcr.io/<owner>/qassist:1.0.0`, `:1.0` and
      `:latest`, and the workflow refuses to publish if the test job failed —
      **`v0.1.0` cut 2026-07-25**: all three tags published from one `linux/amd64`
      build in 3m07s (much less than the half-day this story budgeted for a cold
      Chromium install). The `workflow_call` reuse is proven, not assumed — the
      three test jobs ran nested under Release as `test / …` before the image job
      started. The "refuses if tests failed" half is structural via `needs: test`
      rather than observed, since no tag has been cut on a red suite.
- [ ] `docker compose -f docker-compose.release.yml up` on a machine that has
      never seen the source starts the app and serves the UI on :8080 — **the
      one criterion left.** The VPS is the honest venue for it: it has never held
      this source, and doing it there doubles as the first half of US-007's
      stand-up.
- [x] The package is public on ghcr — an anonymous `docker pull` works —
      verified with `docker logout ghcr.io` followed by a successful
      `docker manifest inspect ghcr.io/rszhd/qassist:0.1.0`. **No manual
      visibility flip was needed:** the package inherited the repo's public
      visibility on first publish, contrary to the expectation that ghcr
      defaults packages to private.
