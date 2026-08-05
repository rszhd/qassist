# US-070 — A user manual, published without an image build

**As a** user, **I want** the QAssist manual at `docs.qassist.run`, **so that**
there is one link to send someone — and, as the maintainer, so that fixing a
typo in it costs a merge rather than a merge *plus* an image rebuild, a registry
round trip and a redeploy of the app.

- **Status:** 🔨 **Live** 2026-08-05 at `docs.qassist.run`, 9/11 — one closes on
  the first incremental publish (re-opened 2026-08-06 when the site moved from
  `dev` to `main`, see [The branch](#the-branch-dev-then-main)), one is a line in
  the marketing repo, which is not this repo. See [Results](#results).
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
correcting a sentence means `dev → staging → main` *and* a rebuild, a registry
push and a redeploy of the running app. The site as built keeps the promotion —
[The branch](#the-branch-dev-then-main) — and drops everything after it, which
is the part that costs minutes and touches production.

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
3. **The builder publishes unattended**, off whatever `DOCS_BRANCH` names. Which
   branch that is, and what it costs, is [The branch](#the-branch-dev-then-main)
   below — it started as `dev` and is now `main`.
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

- [x] `docs.qassist.run` serves the manual over HTTPS on its own Let's Encrypt
      certificate
- [ ] A push to **`main`** touching `manual/**` is live within one poll
      interval, with no image build and no registry round trip; anything not on
      `main` yet publishes by hand — **half proven**: no image was built for the
      first publish, but the branch changed to `main` on 2026-08-06 (see
      [The branch](#the-branch-dev-then-main)) and no incremental publish has
      run since. Closes on the first `main` push touching `manual/`, with the
      hand publish exercised off another ref
- [x] A push touching nothing under `manual/` rebuilds nothing — **measured on
      the box**: two poll intervals after a push touching only `docs/` and
      `backlog/`, the stamp was unchanged, the builder logged nothing, and its
      clone was still at the previous commit
- [x] The whole stack is `docker-compose.docs.yml` plus `.env.docs`: no cron, no
      host script, no `nginx.conf`, and `docker-compose.proxy.yml` is unchanged
- [x] Standing it up touches no other stack: `~/qassist` is only checked out,
      the builder's clone is a volume of its own, and demo, staging, production
      and the proxy see no change from a docs publish
- [x] The manual covers the path a user actually walks — writing a goal, reading
      a verdict, saving a test, projects/modules/suites, schedules, variables and
      secrets, saved sessions, the CI trigger — enough that `README.md` can stop
      growing and link instead
- [x] `docs/` gains no user-facing page and `manual/` gains no contributor page
- [x] `node scripts/check-doc-links.mjs` passes over the new tree, and every
      internal manual link resolves in the built site
- [ ] The app and the marketing site both link to the manual, and the manual
      links back to the app — **app half done**, marketing is a second repo
- [x] `DEPLOY.md` carries the docs stack in its table, and a
      `docs/deploy/docs-site.md` runbook says how to publish by hand when the
      cron is not enough
- [x] The app image is unchanged: no VitePress in the `Dockerfile`, no `/manual`
      route, no new dependency in `frontend/package.json`

## Results

**Live 2026-08-05 at `docs.qassist.run`**, on its own Let's Encrypt certificate
(`CN = docs.qassist.run`, issued at stand-up). Sixteen pages under `manual/`,
the stack in [`docker-compose.docs.yml`](../../../docker-compose.docs.yml) +
[`.env.docs.example`](../../../.env.docs.example), the loop body in
[`manual/publish.sh`](../../../manual/publish.sh), and the runbook at
[`docs/deploy/docs-site.md`](../../../docs/deploy/docs-site.md).

**The stand-up was three commands and cost nothing else on the box**: an `A`
record, `git checkout origin/dev -- <two files>` in the shared `~/qassist`, and
one `up -d`. First publish — a cold clone, `npm ci` and a build — landed in
about a minute. All seventeen emitted pages and every asset answer 200 over
HTTP/2, `X-Robots-Tag: all`, and `:80` 301s to `:443`.

`origin/dev` rather than the branch `~/qassist` sits on (`staging`), because
that is where the two files were and a stand-up does not need them promoted
first. `checkout <ref> -- <paths>` writes those paths only, so the four running
stacks saw nothing.

**`cleanUrls: false` had one cost, and it was paid at the proxy.** A URL typed
without `.html` got nginx's own 404 page, so the styled `404.html` VitePress
builds — the one carrying the nav and the search box — was never served. Fixing
it *inside* nginx means mounting the config file this stack exists without, so
it was fixed with three `errors` labels on `web` instead: Traefik re-fetches the
body from the same service and keeps the 404 status.
`docker-compose.proxy.yml` is still untouched, which is the point — a new
behaviour arrived by labels on our own container, exactly the contract the proxy
file states. Verified live: `HTTP/2 404` with `<title>404 | QAssist</title>`,
and `X-Robots-Tag` still on it because robots stays outermost in the chain.

The generalisable bit: **an error page has to get both halves right**, and it is
easy to fix one. A styled page returning 200 tells a crawler the URL is real; a
bare nginx page returning 404 leaves a reader with no way back. Only `web` was
recreated, so the builder's clone and `node_modules` survived and the next
publish stayed incremental.

**The builder was rehearsed end to end before anything was written about it**,
in a throwaway container against a throwaway ref carrying the working tree — a
cold clone plus `npm ci`, then four more publishes. Four things it settled, none
of which the compose file alone would have:

- A commit **outside `manual/`** publishes nothing and prints nothing. This is
  what `git rev-parse FETCH_HEAD:manual` buys: comparing the *tree* hash rather
  than diffing against a parent, which a `--depth 1` clone may not have at all.
- A commit **inside `manual/`** rebuilds in ~5 s and installs nothing, because
  `node_modules` lives in the `src` volume and the install is keyed on the
  lockfile's own blob hash. Only the cold start pays for npm.
- **A broken build leaves the previous site up and says so.** The rehearsal
  deleted a page four others link to; VitePress failed the build on the dead
  links, the loop logged `publish failed` and the stamp was left untouched, so
  the next poll retries. This is the failure mode that matters — the manual must
  not go down because someone pushed a bad link — and it is a property of the
  stamp being written *after* the rsync, not before.
- **A page removed upstream stops being served** (`rsync --delete`), and a
  publish never leaves the site half there, because rsync replaces each file by
  rename.

**VitePress's own dead-link check is the second half of `check-doc-links.mjs`,
not a duplicate of it.** The repo checker resolves relative Markdown links on
disk; VitePress resolves them against the *rendered site*, where `./x.md`
becomes `x.html`. Two of this story's links passed the first and failed the
second — one an `<http://localhost:8080>` autolink, one an anchor whose slug
turned an apostrophe into `-s-`. Both fail the build rather than shipping, which
is what the criterion asked for.

**Two `docs/` pages left for `manual/` rather than being copied.**
`docs/quickstart.md` and `docs/ci.md` are now pointers: both were written for
someone *using* QAssist, which is the audience `docs/` is explicitly not for,
and a second copy is the copy that drifts. The README's configuration table went
the same way — six rows a fresh install actually turns, and the rest linked —
which is the same shape it already used for the API section, and is what "stop
growing" means in practice. Everything that referenced either file by name,
including two load-bearing comments in `server/src/routes/runs.js` and
`control-plane-tests.test.js` about fields CI polls, now names `manual/ci.md`.

## The branch: dev, then main

**Decided 2026-08-06: the poll follows `main`, and everything else is published
by hand.** It stood up on `dev`, which is what the story was written around —
prose out of the code gate entirely — and one day of it was enough to see the
other side: `dev` is where a page is *drafted*, and the site is the one link you
send someone, so the two should not be the same ref. A page is now public when
it is promoted.

What this does **not** give back is the thing the design rejected. The image
plan cost the chain plus a rebuild, a registry push and a redeploy; this costs
the chain and stops there. Publishing is still writing files into a volume, no
container is recreated, no workflow builds anything, and the app is untouched.

**The hand publish is what keeps the gate from being a wall**, and it takes a
ref:

```sh
docker compose -p qassist-docs exec -e DOCS_BRANCH=dev builder \
  sh /src/manual/publish.sh
```

It holds until the next poll and no longer — the loop fetches `main`, the stamp
does not match, `main` goes back up. That is a property worth having rather than
a limitation: the site cannot quietly stay on a branch nobody remembers
publishing, and the way to make a page stay is to promote it.

**The flip is pending on the box, and the reason is worth writing down:
`main` has no `manual/` at all.** The manual has only ever lived on `dev`, so a
builder pointed at `main` today would fail `git rev-parse FETCH_HEAD:manual`
every poll. It would not take the site down — a failed publish leaves the
previous build up, which is the property the rehearsal proved — but it would
publish nothing until the tree is promoted. So the box stays on `DOCS_BRANCH=dev`
until `manual/` reaches `main`, and the config leads the deployment by one
promotion. **The first `main` push carrying `manual/` is what closes both the
flip and the open criterion.**

Published by hand off `dev` on 2026-08-06 (tree `1976831`, 17 pages) to get the
goal → instructions rename live without waiting: `web` was not recreated,
production was untouched, and the styled 404 still answers 404.

**On the box the flip is an `.env.docs` edit and one `up -d`**, recreating
`builder` alone. The clone was made with `--branch dev` and does not need rebuilding:
every publish resolves the tree through `FETCH_HEAD`, so it follows the variable,
and `node_modules` and the stamp survive. Runbook:
[`docs/deploy/docs-site.md`](../../../docs/deploy/docs-site.md#changing-the-branch-it-follows).

**The escape hatch is unchanged and is now the interesting one.** If the
promotion turns out to be why a typo goes unfixed, `DOCS_BRANCH` at a `docs` ref
that any branch can force-push to — preview's shape — buys the old cadence back
with no other change to the stack.

**`cleanUrls: false` is load-bearing and is worth not "fixing" later.** It is the
single reason no `nginx.conf` is mounted: the emitted links carry `.html`, so
stock nginx serves the site with no `try_files` rule. Turning it on for prettier
URLs puts a config file back on the host and re-opens the thing this story closed.
