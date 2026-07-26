# US-055 — A preview environment, off to the side of the chain

**As the** maintainer, **I want** `preview.qassist.run` to run whatever I
force-push to a `preview` branch, built on the box itself, **so that** looking at
a change live costs a minute instead of a staging round trip — and staging stays
free to be the thing that replicates production.

- **Status:** ✅ **Done 2026-07-26 — 9/9, live at `https://preview.qassist.run`** on
  its own Let's Encrypt certificate, `noindex, nofollow`, `billing:false`, its
  own `qassist-preview_pgdata`, built on the box from a `qassist:preview` tag
  that no registry has ever held. The loop was exercised three times end to end
  and the environment did what the story said it would — but three of the
  story's own claims were wrong, and each is corrected in place above:

  - **~2 minutes was pessimistic by a factor of thirty.** 2 s for a `server/src`
    change, 4 s for a frontend one. Only a cold cache or an
    `agent/requirements.txt` change costs real time.
  - **`docker image prune -f` reclaims nothing.** BuildKit leaves no dangling
    image; the **build cache** is what grows (5.05 → 7.81 GB over two rebuilds).
    The deploy needs `docker buildx prune -f --max-used-space 6GB`. With it,
    three cycles left Images, Build Cache and `df` all unchanged.
  - **The box already had a working tree.** `~/qassist` has always held the
    other stacks' compose and env files. The new exception is *building*, and
    the separate `~/qassist-preview` clone is a requirement rather than tidiness:
    `git checkout -B preview` in the shared tree would swap the compose files out
    from under three running stacks.

  Proven on the box: a `wip/preview-proof` branch that has never been on `dev`
  was previewed; `up -d` recreated the container from a new image ID with no tag
  change and no registry, confirmed by the revision label reading the branch tip
  (`dceb6c6` → `d4d4e42` → `41b3516`); a preview session cookie forced onto
  staging and demo with an explicit `Cookie:` header is 401 on both and 200 on
  preview; and a sign-in link for `stranger@example.com` was printed to the
  container log with `RESEND_API_KEY` empty, so a stranger cannot be mailed. The
  three pushes to `preview` triggered no workflow run.

  **The ninth criterion was failing on arrival, and not because of preview.**
  `git merge --ff-only staging` into `main` aborted — but `origin/preview` is
  provably not in staging's ancestry, so this was inherited rather than caused.
  `origin/main` carried two GitHub PR merge commits (`f8a2937` #2, `32aa949` #3)
  that `dev` and `staging` did not, because US-052's reconciliation commit
  `15e7de3` merged `b3977f7` — a **stale local `main`**, while the real
  `origin/main` had already moved on. US-052's scorecard claimed the
  fast-forward was now possible; it never was.

  **Fixed here** (`9f07713`): `origin/main` merged into `dev` for real, `staging`
  fast-forwarded onto it, both pushed. Neither PR merge commit contributes
  content — each has the tree of its second parent — so the merge changed not one
  byte: `git diff HEAD^1 HEAD` is empty. It is history being reconciled, not
  code. `git merge --ff-only staging` into `main` then succeeded, checked in a
  detached worktree so `main` itself was not moved: promoting is a release
  decision, and the criterion only asks that it *can*. US-052's record is
  corrected too.

  That the breakage was findable at all is the design working. Preview is the
  one branch allowed to rewrite history, so it is the one that would have hidden
  a `--ff-only` failure inside its own noise — and the ancestry check says it
  did not.

  Also noticed while reading env files, unrelated but real: **`.env.staging` has
  no `TRUST_PROXY`**, so staging's per-IP limits count Traefik's address rather
  than each caller's.

  Repo half, for the record:
  `.env.preview.example` exists and says why it is looser rather than only what
  differs; `DEPLOY.md` carries the [Preview](../../../../DEPLOY.md#preview) section
  with its three costs, the build-and-`up -d` loop, the running-commit check and
  the "what preview must not become" boundary; `CLAUDE.md`, `CONTRIBUTING.md`
  and `README.md` all describe preview as a spur rather than a stage. `ci.yml`
  now triggers on `push: [main]` plus `pull_request`, so a push to `dev` runs
  nothing while a PR into it still runs the full suite and `staging.yml` still
  gates its image on that suite. All three halves are now observed rather than
  reasoned about: pushing `dev` at `9f07713` triggered no run at all, and the
  `staging` push of the same commit ran the full suite before publishing. No
  `docker-compose.preview.yml` exists and no compose file mentions preview.

  One decision made while writing it, not in the plan above: the documented
  build stamps `--label org.opencontainers.image.revision="$(git rev-parse
  --short HEAD)"`. An image that never went through a registry has no other way
  to answer "which commit is this?", and the criterion asks for the running
  commit rather than the tag — so the label is what makes that check possible
  at all, and `docker inspect` on the container reads it back. It earned its
  place immediately: it is what caught the rebuild landing, and what would have
  caught it not landing.
- **Priority:** P2 (current sprint) — it is the friction
  [US-052](../US-052-staging-branch-continuous-deploy.md) halved rather than
  removed, and every story that wants a live look pays it again
- **Estimate:** ~1 h repo-side, plus one stand-up on the box
- **Depends on:** [US-038](../US-038-staging-environment.md) (the fourth-stack
  shape this reuses) and [US-052](../US-052-staging-branch-continuous-deploy.md)
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
docker buildx prune -f --max-used-space 6GB   # NOT `image prune` — see cost 2
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

  **Measured on the box, and ~2 minutes was pessimistic by a factor of thirty:**
  2 s for a `server/src` change, 4 s for a frontend one — Vite itself is 3.5 s.
  The two builds that do cost are the first on a cold cache and any change to
  `agent/requirements.txt`.

## What it costs

Three, and none of them are free:

1. **The box gets a working tree for the first time.** US-032's
   `build: !reset null` exists so that a server never sees source. Preview is a
   deliberate exception and must stay confined to one: production and staging
   still cannot build, and preview runs unreviewed, untested commits on the same
   Docker daemon as production.

   **Wrong on the premise, right on the cost.** The box has had a checkout all
   along — `~/qassist` is where every stack's compose files and env files live —
   and it even carries a locally built `qassist:latest` from four days ago. So
   the new thing is *building*, not seeing source. That also turns the separate
   clone from tidiness into a requirement: preview's loop is
   `git checkout -B preview`, and running it in `~/qassist` would swap the
   compose files out from under three live stacks.
2. **Disk.** Each rebuild orphans a layer set of a couple of GB, and production
   shares that disk — a full disk takes production down. So the prune is part of
   the documented deploy, not a habit someone is trusted to have.

   **The mechanism is wrong and so is the prune.** Nothing orphans: BuildKit
   moves the tag and drops the old manifest, leaving zero dangling images, and
   `docker image prune -f` therefore reclaims 0 B. What grows is the **build
   cache** — 5.05 GB → 7.81 GB over two rebuilds. The deploy line has to be
   `docker buildx prune -f --max-used-space 6GB`: bounded rather than emptied,
   because that cache is exactly what keeps a rebuild at seconds.
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

- [x] A force-push to `preview` reaches `preview.qassist.run` in about two
      minutes by `pull` + `build` + `up -d` on the box, on its own Let's Encrypt
      certificate, serving `noindex, nofollow`
- [x] The fourth stack is the same two compose files with a different `-p` and
      `--env-file` — no `docker-compose.preview.yml` exists, and no compose file
      mentions preview
- [x] A rebuild is actually picked up: `up -d` recreates the container from the
      new image ID with no tag change and no registry round trip, confirmed by
      the running commit rather than by the tag
- [x] A branch that has never been merged to `dev` can be previewed, and
      preview's history never reaches `staging` — `git merge --ff-only staging`
      into `main` still succeeds afterwards
- [x] Isolation holds as it does for the other three: its own `pgdata` volume,
      its own secrets, and a preview API key or session cookie is refused by
      production and staging
- [x] Preview cannot mail a stranger and shows no billing UI — a failing run
      sends nothing (console only) and `/api/health` reports `billing:false`
- [x] Repeated rebuilds do not grow the disk without bound: the documented
      deploy prunes, and the box's image usage is stable after several cycles
- [x] A push to `dev` runs no workflow; a PR into `dev` runs the full suite; a
      push to `staging` still gates its image on that suite
- [x] `DEPLOY.md` carries the preview section (including its costs), and
      `CLAUDE.md`, `CONTRIBUTING.md` and `README.md` agree that preview is a
      spur off the chain rather than a stage in it
