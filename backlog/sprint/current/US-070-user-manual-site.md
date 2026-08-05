# US-070 — A user manual, deployed off the chain

**As a** user, **I want** the QAssist manual at `docs.qassist.run`, **so that**
there is one link to send someone — and, as the maintainer, so that fixing a
typo in it costs a push rather than a promotion through `dev → staging → main`
and an image rebuild.

- **Status:** 📋 Planned
- **Priority:** P2 (current sprint)
- **Estimate:** ~1 h repo-side, plus one stand-up on the box
- **Depends on:** [US-007](done/US-007-https-reverse-proxy.md) (Traefik,
  hostname routing and ACME) and
  [US-055](done/US-055-preview-environment.md) (the spur shape and the
  second-clone rule this reuses)

## The problem: there is no manual, and no obvious place to put one

`docs/` is contributor material. `testing.md`, `ci.md`, `repo-model.md`,
`design-system.md`, `deploy/` — every page there is written for someone editing
this repo. Nothing in it is written for someone who wants to write a goal and
read a verdict.

What a user gets today is `README.md` and
[`docs/quickstart.md`](../../../docs/quickstart.md), which cover the first run
and stop. Everything after it — suites, schedules, variables and secrets, saved
sessions, the CI trigger — is documented as commits, story files and API
reference, or not at all. The README has been absorbing the overflow, which is
the wrong home for it and the reason it keeps growing.

The marketing site is not the answer either: `qassist.run` is a separate Next.js
repo, so a manual written there drifts from the code it describes, and every
change to it is a second commit in a second place.

## Rejected: ship the manual inside the app image

This was the first plan and it is worth recording why it lost, because it is
cheap and it nearly wins.

VitePress output is static, and serving it from the app needs **no server
change at all**: auth is per-router on `/api/*` (`server/src/server.js:147-169`),
and `express.static(PUBLIC_DIR)` at line 171 already runs before the SPA
catch-all at 175. Drop the build into the frontend's output directory as
`manual/` and it is served, publicly, in the right order. Self-hosters would get
the manual offline, and it would always match the build they run.

It fails on **cadence**. The image is built by the promotion chain, so
correcting a sentence means `dev → staging → main` and a rebuild. That chain
exists to gate code; prose does not need gating, and putting writing behind a
code gate means the writing does not get done.

A second, smaller failure: every install would serve its own copy at its own
address, so there would be no canonical URL to put in a support reply, a GitHub
issue or the marketing nav, and nothing for a search engine to index.

**Deferred, not dead.** The same build output can also be copied into the image
later, once the manual is stable. Then `docs.qassist.run` gets a fix in seconds
and self-hosters get it at the next release, which is the right cadence for
each. That is a follow-up, and it changes nothing about the source layout below.

## Approach: another spur, with a container of its own

**VitePress, sourced from `manual/` at the repo root.** Root rather than
`docs/manual/` because the two audiences should not share a folder: the site
would otherwise need an exclusion list that grows with every contributor doc
added, and `docs/**` would stop meaning "not for users". Local search provider,
`appearance: 'force-dark'` to match the app identity, and the palette from
[`docs/design-system.md`](../../../docs/design-system.md) via theme CSS
variables.

**Everything lives in one compose file**, `docker-compose.docs.yml`, run as its
own project `qassist-docs`. Nothing is configured on the host — no cron, no
script in a home directory, no `nginx.conf`, and no change to the proxy.
`docker-compose.proxy.yml` already states the contract: a new stack "just has to
join the qassist-edge network and carry router labels."

Two services and two named volumes:

- **`web`** — `nginx:alpine` serving the `dist` volume at
  `/usr/share/nginx/html`, carrying the same Traefik label block the app uses in
  `docker-compose.prod.yml`. **No config file is mounted**, and keeping
  VitePress's `cleanUrls` at its default `false` is what buys that: the emitted
  links carry `.html`, so stock nginx serves them with no `try_files` rule.
- **`builder`** — `node:22-alpine`, long-lived, holding the clone in a `src`
  volume and looping: fetch, build when `manual/` moved, write into `dist`. The
  loop body is `manual/publish.sh` **in the repo**, not in the compose
  `command`, so improving it is a commit rather than a compose edit. Publishing
  is writing files into a volume; no container is recreated.

**This does not contradict US-055's ban on a `docker-compose.preview.yml`.**
Preview is the same app *parameterized*, so an overlay that knew which
environment it served would be wrong. Docs is a different workload, so it gets a
file of its own rather than bending the app's two.

**Why a build loop is allowed here when staging's deploy is a hand-run step.**
[`docs/deploy/staging.md`](../../../docs/deploy/staging.md) rules out
`git pull` in a cron because `~/qassist` is *shared* — it holds every stack's
compose and env files, so moving it changes what `demo` and the proxy would get
on their next `up -d`. The builder's clone lives in a volume no other stack
reads, which is the same reason US-055 gave preview `~/qassist-preview`. The
rule is about the shared checkout, not about automation.

**What is left on the host is three things**, and none of them is
configuration: a DNS `A` record for `docs.qassist.run`, a `git checkout` in
`~/qassist` to receive the new file, and one `up -d` with a small `.env.docs`
carrying `DOCS_HOST`.

## What it costs

1. **A fifth stack on the box**, and the cheapest one yet: a static nginx
   container idling at a few MB, plus a builder that is idle between pushes. No
   app, no Postgres, so `DEPLOY.md`'s RAM budget is untouched.
2. **A DNS `A` record** for `docs.qassist.run`, and a certificate Traefik issues
   and renews on its own.
3. **The builder publishes unattended.** It builds whatever is on `dev`, so a
   half-written page on `dev` is a public page. That is acceptable for prose and
   it is the whole point of the cadence; the escape hatch, if it ever bites, is
   to point `DOCS_BRANCH` at a `docs` ref and force-push to it exactly as
   preview does.
4. **Disk.** Small — a static site, a clone and an npm cache in two volumes —
   but the cache still needs a bound, since production shares the disk.

## What the docs site must not become

- **Not a second app.** Static files only: no auth, no API, no database. The
  moment it needs a request handler it has stopped being a docs site.
- **Not the contributor tree.** `docs/` stays where it is and stays out of the
  site. If a page is useful to both audiences, it is written for the user and
  linked from `docs/`, not copied.
- **Not a gate.** Nothing merges out of it and nothing waits on it, for the same
  reason preview is a spur.

## Acceptance criteria

- [ ] `docs.qassist.run` serves the manual over HTTPS on its own Let's Encrypt
      certificate
- [ ] A push to `dev` touching `manual/**` is live within one poll interval,
      with no workflow run, no image build and no registry round trip
- [ ] A push touching nothing under `manual/` rebuilds nothing
- [ ] The whole stack is `docker-compose.docs.yml` plus `.env.docs`: no cron, no
      host script, no `nginx.conf`, and `docker-compose.proxy.yml` is unchanged
- [ ] Standing it up touches no other stack: `~/qassist` is only checked out,
      the builder's clone is a volume of its own, and demo, staging, production
      and the proxy see no change from a docs publish
- [ ] The manual covers the path a user actually walks — writing a goal, reading
      a verdict, saving a test, projects/modules/suites, schedules, variables and
      secrets, saved sessions, the CI trigger — enough that `README.md` can stop
      growing and link instead
- [ ] `docs/` gains no user-facing page and `manual/` gains no contributor page
- [ ] `node scripts/check-doc-links.mjs` passes over the new tree, and every
      internal manual link resolves in the built site
- [ ] The app and the marketing site both link to the manual, and the manual
      links back to the app
- [ ] `DEPLOY.md` carries the docs stack in its table, and a
      `docs/deploy/docs-site.md` runbook says how to publish by hand when the
      cron is not enough
- [ ] The app image is unchanged: no VitePress in the `Dockerfile`, no `/manual`
      route, no new dependency in `frontend/package.json`
