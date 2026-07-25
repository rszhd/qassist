# US-032 — CI on every push, a published image on every tag

**As a** self-hoster, **I want** `docker compose up` to pull a versioned QAssist image someone else already built and tested, **so that** I can run a known-good release without cloning the source, installing Chromium, or trusting a `latest` tag that changes under me.

- **As the maintainer**, the same pipeline is what stops a broken `dev` from
  looking green: 99 server tests, a typecheck and a frontend build exist and
  currently only ever run when I remember to run them.

- **Status:** 🧱 Repo side shipped, **entirely unverified** (2026-07-25) —
  `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
  `docker-compose.release.yml` and the README's "Run a release" quick start are
  in, and the YAML and the release guard's shell logic were checked locally.
  But **not one of this story's criteria is met yet**, because every one of them
  is about what happens on GitHub: nothing has been pushed, no workflow has
  ever run, no tag exists and nothing is on ghcr. Blocked on US-031's public
  flip.
- **Priority:** P1 (current sprint) — `docs/repo-model.md` rule 1 makes the
  published image *the* artifact the product ships
- **Estimate:** ~half a day (the image build is slow to iterate on)
- **Depends on:** [US-031](US-031-license-and-public-repo.md) — Actions and
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

- **The image path must be lowercase**, and the repo is `rszhd/QAssist`. ghcr
  rejects an uppercase path component, so `${{ github.repository }}` cannot be
  used to name the image — it is a lowercase literal
  `ghcr.io/${{ github.repository_owner }}/qassist`. US-031's outstanding rename
  is what makes the two agree; until then the image name is simply the
  lowercase one, which is correct either way.
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

Written but **unverified** — each of these is a statement about GitHub, and
nothing has been pushed yet:

- [ ] A push to `dev` runs tests, typecheck and the frontend build, and the
      run is red when any of them fail
- [ ] `scheduler-postgres.test.js` **runs** in CI (not skipped) — assert on the
      log line, since a skipped test file is otherwise green. *(Guard written
      to cover all five `*-postgres.test.js` files, not just this one; needs a
      real run to prove the service container is reachable.)*
- [ ] Tagging `v1.0.0` publishes `ghcr.io/<owner>/qassist:1.0.0`, `:1.0` and
      `:latest`, and the workflow refuses to publish if the test job failed
- [ ] `docker compose -f docker-compose.release.yml up` on a machine that has
      never seen the source starts the app and serves the UI on :8080
- [ ] The package is public on ghcr — an anonymous `docker pull` works
