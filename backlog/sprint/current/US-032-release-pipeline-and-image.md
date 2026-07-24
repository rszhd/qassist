# US-032 — CI on every push, a published image on every tag

**As a** self-hoster, **I want** `docker compose up` to pull a versioned QAssist image someone else already built and tested, **so that** I can run a known-good release without cloning the source, installing Chromium, or trusting a `latest` tag that changes under me.

- **As the maintainer**, the same pipeline is what stops a broken `dev` from
  looking green: 99 server tests, a typecheck and a frontend build exist and
  currently only ever run when I remember to run them.

- **Status:** 📋 Planned
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

## Acceptance criteria

- [ ] A push to `dev` runs tests, typecheck and the frontend build, and the
      run is red when any of them fail
- [ ] `scheduler-postgres.test.js` **runs** in CI (not skipped) — assert on the
      log line, since a skipped test file is otherwise green
- [ ] Tagging `v1.0.0` publishes `ghcr.io/<owner>/qassist:1.0.0`, `:1.0` and
      `:latest`, and the workflow refuses to publish if the test job failed
- [ ] `docker compose -f docker-compose.release.yml up` on a machine that has
      never seen the source starts the app and serves the UI on :8080
- [ ] The package is public on ghcr — an anonymous `docker pull` works
