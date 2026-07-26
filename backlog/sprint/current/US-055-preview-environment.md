# US-055 — A preview environment, off to the side of the chain

**As the** maintainer, **I want** `preview.qassist.run` to run whatever I
force-push to a `preview` branch, built on the box itself, **so that** looking at
a change live costs a minute instead of a staging round trip — and staging stays
free to be the thing that replicates production.

- **Status:** 🟡 2/9 (2026-07-26) — **the repo half is in.**
  `.env.preview.example` exists and says why it is looser rather than only what
  differs; `DEPLOY.md` carries the [Preview](../../../DEPLOY.md#preview) section
  with its three costs, the build-and-`up -d` loop, the running-commit check and
  the "what preview must not become" boundary; `CLAUDE.md`, `CONTRIBUTING.md`
  and `README.md` all describe preview as a spur rather than a stage. `ci.yml`
  now triggers on `push: [main]` plus `pull_request`, so a push to `dev` runs
  nothing while a PR into it still runs the full suite and `staging.yml` still
  gates its image on that suite. Two criteria are closed on the repo alone: no
  `docker-compose.preview.yml` exists and no compose file mentions preview.

  One decision made while writing it, not in the plan above: the documented
  build stamps `--label org.opencontainers.image.revision="$(git rev-parse
  --short HEAD)"`. An image that never went through a registry has no other way
  to answer "which commit is this?", and the criterion asks for the running
  commit rather than the tag — so the label is what makes that check possible
  at all, and `docker inspect` on the container reads it back.

  **The remaining seven all need the box** and none of them can be faked
  here: the hostname, its certificate, the rebuild actually being picked up by
  image ID, the cross-stack refusal, mail staying in the console, and disk
  staying flat across cycles. The `dev`/PR trigger split is also only observable
  on the next push.
- **Priority:** P2 (current sprint) — it is the friction
  [US-052](US-052-staging-branch-continuous-deploy.md) halved rather than
  removed, and every story that wants a live look pays it again
- **Estimate:** ~1 h repo-side, plus one stand-up on the box
- **Depends on:** [US-038](US-038-staging-environment.md) (the fourth-stack
  shape this reuses) and [US-052](US-052-staging-branch-continuous-deploy.md)
  (the chain this deliberately does *not* join)

## The problem: staging is the only place to look at a change

US-052 made a deploy cost a merge instead of a version tag, which was the large
half. What it did not change is what the merge itself costs: the full CI suite,
an image build carrying the Chromium layer, a push to ghcr, then a `pull` on the
box. Three minutes on a warm cache and more when it is cold — and that is the
price of *every* look at a change, including "is that the right shade of grey".

That price is correct for staging, and not incidental to it. Staging replicates
production — real Resend, real Stripe test keys, a populated database, the same
two compose files — which is exactly what makes green there mean something. The
bill it cannot get out of is the same property that makes it a poor iteration
loop.

So the fix is not to make staging faster. It is to stop asking staging the
questions that do not need production fidelity.

## Approach: preview is a spur, not a link

**The chain stays `dev → staging → main`.** `preview` hangs off the side of it:

```sh
git push -f origin HEAD:preview     # from dev, or from any WIP branch
```

Force-pushable, disposable, and **nothing ever merges out of it**. Two things
follow, and both are the point:

- **A branch that is not on `dev` yet can be previewed** — which is precisely
  when a live look is worth most.
- **US-052's `--ff-only` promotion is untouched.** `main` remains nothing but
  staging's history, because rewritten preview history never enters staging's
  ancestry.

**Rejected: `dev → preview → staging → main`.** It reads naturally and is wrong
twice. It makes preview a *mandatory gate*, so everything must pass through the
environment that exists to be optional — slowing the path this story is here to
speed up. And it puts force-pushed history upstream of `staging`, which is the
one invariant US-052 bought.

## The box builds it, and no compose file learns about it

`docker-compose.prod.yml` sets `pull_policy: missing`, so a locally built image
under the pinned tag means compose never goes to the registry. That is the whole
trick: **preview is the same two compose files a fourth time**, with a project
name and an env file, exactly as US-038 says an environment is.

```sh
git fetch && git checkout -B preview origin/preview
# the label is the only way to read the commit off a registry-less image
docker build -t qassist:preview \
  --label org.opencontainers.image.revision="$(git rev-parse --short HEAD)" .
# .env.preview: QASSIST_IMAGE=qassist:preview
export ENV_FILE=.env.preview
docker compose -p qassist-preview -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file "$ENV_FILE" up -d
docker image prune -f
```

No `docker-compose.preview.yml`, and none should appear — the moment the overlay
needs to know which environment it is serving, the overlay is wrong.

Two mechanics worth writing down because they are not obvious:

- **`up -d` recreates on a rebuild.** Compose compares the image *ID* it
  recorded against the container, not the tag string, so a fresh build under an
  unchanged tag is picked up. This is the inverse of US-052's trap, where an
  unchanged *registry* tag is what silently is not fetched — here there is no
  registry in the loop at all.
- **The expensive layer is cached.** `pip install -r requirements.txt` and
  `playwright install --with-deps chromium` are keyed on
  `agent/requirements.txt`, so a code-only rebuild pays for the Vite build and
  the `COPY`s. That is the difference between ~2 minutes and the ~20 the fast
  workflow was designed to avoid.

## What it costs

Three, and none of them are free:

1. **The box gets a working tree for the first time.** US-032's
   `build: !reset null` exists so that a server never sees source. Preview is a
   deliberate exception and must stay confined to one: production and staging
   still cannot build, and preview runs unreviewed, untested commits on the same
   Docker daemon as production.
2. **Disk.** Each rebuild orphans a layer set of a couple of GB, and production
   shares that disk — a full disk takes production down. So the prune is part of
   the documented deploy, not a habit someone is trusted to have.
3. **RAM.** This is a fourth app container *and* a fourth Postgres.
   `MAX_CONCURRENT_SESSIONS=1`, and production's own budget may have to come
   down to pay for it — `DEPLOY.md`'s worked example already lands at 3 + 1 on
   8 GB with no room spare.

## What preview must not become

Staging's env file is strict because staging proves the real Resend path and a
real Stripe round trip. Preview proves neither, so it is deliberately **looser,
not a second staging**: `MAIL_DEV_CONSOLE=1`, `STRIPE_*` empty so the billing UI
is simply absent, `ROBOTS_TAG=noindex, nofollow`, `RUNS_DIR=./runs-preview`, and
its own freshly generated secrets.

`.env.preview.example` has to say *why* it is looser, not just what differs. The
day preview acquires Stripe keys and real mail, there are two staging
environments and no preview, and the round trip this story exists to shorten is
back.

## CI on `dev` goes with it

The same reasoning one layer up. `ci.yml` triggers on `push: [main, dev]` plus
`pull_request`, but the *gates* are `staging.yml` and `release.yml` — both
`uses: ./.github/workflows/ci.yml` before publishing anything. An image whose
tests never ran stays impossible whether or not pushes to `dev` are checked, so
the `dev` run is informational, and it is informational about a branch that
takes WIP pushes.

Drop `dev` from the push triggers; keep `pull_request`, so a PR into `dev` is
still fully checked. Keep `main`, which costs nothing because nothing reaches it
except a fast-forward from staging.

The tradeoff, stated rather than discovered: a broken test is now found at
merge-to-`staging` time, which is the slow round trip. Local `npm test` stops
being optional — `CLAUDE.md` already asks for it after touching `server/src/`,
and this makes that rule load-bearing.

## Acceptance criteria

- [ ] A force-push to `preview` reaches `preview.qassist.run` in about two
      minutes by `pull` + `build` + `up -d` on the box, on its own Let's Encrypt
      certificate, serving `noindex, nofollow`
- [ ] The fourth stack is the same two compose files with a different `-p` and
      `--env-file` — no `docker-compose.preview.yml` exists, and no compose file
      mentions preview
- [ ] A rebuild is actually picked up: `up -d` recreates the container from the
      new image ID with no tag change and no registry round trip, confirmed by
      the running commit rather than by the tag
- [ ] A branch that has never been merged to `dev` can be previewed, and
      preview's history never reaches `staging` — `git merge --ff-only staging`
      into `main` still succeeds afterwards
- [ ] Isolation holds as it does for the other three: its own `pgdata` volume,
      its own secrets, and a preview API key or session cookie is refused by
      production and staging
- [ ] Preview cannot mail a stranger and shows no billing UI — a failing run
      sends nothing (console only) and `/api/health` reports `billing:false`
- [ ] Repeated rebuilds do not grow the disk without bound: the documented
      deploy prunes, and the box's image usage is stable after several cycles
- [ ] A push to `dev` runs no workflow; a PR into `dev` runs the full suite; a
      push to `staging` still gates its image on that suite
- [ ] `DEPLOY.md` carries the preview section (including its costs), and
      `CLAUDE.md`, `CONTRIBUTING.md` and `README.md` agree that preview is a
      spur off the chain rather than a stage in it
