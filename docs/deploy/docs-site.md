# The docs site — `docs.qassist.run`

The user manual, built from `manual/` on `main` and served as static files.
Orientation and the other stacks: [`DEPLOY.md`](../../DEPLOY.md).

It is a **spur off the promotion chain, like preview** — nothing merges out of
it and nothing waits on it. Preview exists because staging's bill is the wrong
price for a live look; this exists because prose should not also cost an image.

**A push to `main` touching `manual/**` is live within one poll interval**, with
no image build and no registry round trip: the promotion is the whole cost, and
nothing after it. Everything else — a page still on `dev`, an urgent fix, a look
at what a branch renders as — is [published by hand](#publishing-by-hand).

The trade, stated: a page goes public when it is promoted rather than when it is
written, so `main` and the site are the same thing and a half-written page on
`dev` is not a public page. If the promotion ever becomes the reason the writing
does not get done, `DOCS_BRANCH` at a `docs` ref you force-push to — preview's
shape — buys the fast cadence back and costs no other change.

## What it is

Two containers and two volumes, and that is the entire stack —
[`docker-compose.docs.yml`](../../docker-compose.docs.yml) plus a small
`.env.docs`. Nothing is configured on the host: no cron, no script in a home
directory, no `nginx.conf`, and `docker-compose.proxy.yml` is untouched.

| | |
|---|---|
| **`web`** | `nginx:alpine` serving the `dist` volume read-only, carrying the same Traefik label block the app stacks carry. **No config file is mounted** — that is bought by VitePress's `cleanUrls: false`, which emits `.html` links the default server block serves with no `try_files` rule. |
| **`builder`** | `node:22-alpine`, long-lived, holding the clone and `node_modules` in the `src` volume and looping: fetch, build if `manual/` moved, rsync into `dist`. |

**Publishing is writing files into a volume.** No container is recreated, no
image is pulled, and `web` never restarts.

The loop body is [`manual/publish.sh`](../../manual/publish.sh) **in the repo**,
not in the compose `command`, and it is re-read from the clone every iteration.
So improving what a publish does is a commit that takes effect on the next poll
— not a compose edit and not a `docker compose up -d`.

### Why a build loop is allowed here when staging's deploy is hand-run

[`staging.md`](staging.md) rules out `git pull` in a cron because `~/qassist` is
**shared**: it holds every stack's compose and env files, so moving it changes
what `demo` and the proxy would get on their next `up -d`. The builder's clone
lives in a volume no other stack reads — the same reason US-055 gave preview
`~/qassist-preview`. **The rule is about the shared checkout, not about
automation.**

## What it costs

1. **A fifth stack, and the cheapest one yet.** A static nginx idling at a few
   MB and a builder that is idle between pushes. No app, no Postgres, so
   `DEPLOY.md`'s RAM budget is untouched.
2. **A DNS `A` record**, and a certificate Traefik issues and renews on its own.
3. **The builder publishes unattended, and it follows `main`.** So a page is
   public once it is promoted, and a page that is only on `dev` is not published
   until it is — that is the gate, and the hand publish below is the way past it
   when something cannot wait for one.
4. **Disk.** Small, and bounded rather than trusted: the clone is `--depth 1`,
   `npm ci` runs only when the lockfile moved, and its cache is dropped after
   each install. Production shares this disk.

## Standing it up

**1. DNS.** An `A` record for `docs.qassist.run` → the same IP as the other
hostnames.

**2. The compose file.** `~/qassist` is the shared checkout the other stacks
read their compose and env files from, and it is only ever **checked out** here
— never built in, never branch-switched. `checkout <ref> -- <paths>` writes those
paths and nothing else, so it cannot disturb a running stack:

```sh
cd ~/qassist
git fetch origin && git checkout main -- docker-compose.docs.yml .env.docs.example
```

**Take the ref that actually carries the files.** If a change to either file is
only on `dev` so far, `git checkout origin/dev -- …` works the same way — a
path checkout writes those paths and moves no branch.

**3. Configure.**

```sh
cp .env.docs.example .env.docs
$EDITOR .env.docs          # DOCS_HOST is the only value with no default
```

There is nothing secret in it. The builder clones over public https and holds no
credential, which is most of why this stack can be trusted to run unattended.

**4. Up.**

```sh
docker compose -p qassist-docs -f docker-compose.docs.yml \
  --env-file .env.docs up -d
```

The first cycle is the slow one: a clone plus a cold `npm ci`, a minute or two.
Watch it land:

```sh
docker compose -p qassist-docs logs -f builder
# publishing manual <tree sha> from main
# installing dependencies
# published 17 pages
```

### Changing the branch it follows

An edit to `DOCS_BRANCH` in `.env.docs` and one `up -d`, which recreates
`builder` alone. **The clone does not have to be rebuilt**: it was made with
`--branch`, but every publish resolves the tree through `FETCH_HEAD`, so it
follows whatever the variable now says. `node_modules` and the stamp survive,
and the first publish on the new branch is a normal incremental one.

## Verifying it

```sh
curl -sSI https://docs.qassist.run | head -1              # 200
curl -sSI https://docs.qassist.run | grep -i x-robots-tag # all — this one IS indexed
curl -sS https://docs.qassist.run/first-run.html | grep -o '<title>.*</title>'
```

**The `.html` matters.** `cleanUrls` is off precisely so stock nginx can serve
these; a request for `/first-run` with no extension is a 404 and that is
expected, not a misconfiguration. Every link the site emits carries the
extension, so this is only ever reached by a URL somebody typed or truncated.

**That 404 is the site's own page, and it is the proxy that makes it so.** Stock
nginx has no `error_page 404` rule, so three `errors` labels on `web` — rather
than an `nginx.conf`, the one thing this stack exists without — have Traefik
re-fetch the styled `404.html` VitePress builds (the one carrying the nav and
the search box, which is the way back) while keeping the 404 status.
`docker-compose.proxy.yml` is untouched, because reading labels off a container
is exactly the contract it states.

```sh
curl -sSI https://docs.qassist.run/settings | head -1        # HTTP/2 404
curl -sS  https://docs.qassist.run/settings | grep '<title>' # 404 | QAssist
```

Both halves matter and it is easy to fix one and not the other: a styled page
returning **200** tells a crawler the URL is real, and a bare nginx page
returning 404 leaves a reader with no way back.

The one thing worth confirming by hand after a stand-up, because it is the only
thing no other check covers:

```sh
# a push touching nothing under manual/ must rebuild nothing
docker compose -p qassist-docs logs --since 10m builder    # silent between publishes
```

Isolation, the same question asked of every stack:

```sh
docker volume ls | grep qassist-docs     # qassist-docs_src, qassist-docs_dist
docker compose -p qassist ps             # production untouched by a publish
```

## Publishing by hand

This is the other half of following `main`: the poll covers promoted prose, and
everything else is published from here.

When the poll is not enough — you merged thirty seconds ago and want it now, or
you want to see the build output:

```sh
docker compose -p qassist-docs exec builder sh /src/manual/publish.sh
```

It is the same script the loop runs and it is idempotent: with nothing new it
prints nothing and exits 0.

**To publish a ref that is not `main`** — a page still on `dev`, or a branch you
want to read as rendered pages:

```sh
docker compose -p qassist-docs exec -e DOCS_BRANCH=dev builder \
  sh /src/manual/publish.sh
```

**This holds until the next poll and no longer.** The loop fetches `main` again,
finds a tree that does not match the stamp, and puts `main` back — so the site
self-corrects within one interval rather than sitting on a branch nobody
remembers publishing. If you want it to stay, promote it. If you want a longer
look, stop the builder (`docker compose -p qassist-docs stop builder`) and start
it again when you are done; `web` serves the `dist` volume either way.

**To force a rebuild of an unchanged tree** — after changing something the stamp
cannot see, such as a dependency pinned by a range:

```sh
docker compose -p qassist-docs exec builder rm -f /src/.publish-stamp
docker compose -p qassist-docs exec builder sh /src/manual/publish.sh
```

**To start from nothing** — a corrupted clone, a wedged `node_modules`:

```sh
docker compose -p qassist-docs down -v      # both volumes; nothing here is state
docker compose -p qassist-docs -f docker-compose.docs.yml \
  --env-file .env.docs up -d
```

`down -v` is safe on **this** project and on no other one on the box. The docs
stack holds no data: the source is GitHub and the site is a build product.

## When something is wrong

**The site is stale.** Read the builder log first — the loop prints a line per
publish and swallows a failure with `publish failed; retrying next poll` rather
than dying, so a broken build leaves the *previous* site up and says so once per
poll. That is deliberate: a red build must not take the manual down.

**A page 404s but its neighbours work.** Almost always a link written without
`.html` by hand. VitePress rewrites the ones in Markdown; a raw `<a href>` in a
page is yours to spell.

**Nothing publishes and the log is silent.** The stamp matched. Confirm what the
builder thinks it has:

```sh
docker compose -p qassist-docs exec builder cat /src/.publish-stamp
git rev-parse origin/main:manual       # locally — the two should differ if you promoted
```

**The build itself fails.** Reproduce it where the output is readable rather
than in a loop:

```sh
cd manual && npm ci && npm run build
```

VitePress fails the build on a dead internal link, which is the check that keeps
the published site's links honest. `node scripts/check-doc-links.mjs` covers the
Markdown *in the repo*; the two are not the same check and both run.

## What the docs site must not become

- **Not a second app.** Static files only: no auth, no API, no database. The
  moment it needs a request handler it has stopped being a docs site — and the
  tell is `.env.docs` growing a value that also appears in `.env`.
- **Not the contributor tree.** `docs/` stays where it is and stays out of the
  site. A page useful to both audiences is written for the user in `manual/` and
  linked from `docs/`, never copied into both.
- **Not a gate.** Nothing merges out of it and nothing waits on it, for the same
  reason preview is a spur.

## Deferred, not dead: the offline copy

Serving the manual from the app image needs **no server change at all** — auth
is per-router on `/api/*` and `express.static` already runs before the SPA
catch-all — so dropping the same `dist` into the frontend's output as `manual/`
would serve it, publicly, in the right order.

That was the first plan and it lost on cadence, not difficulty. It is still
worth doing **once the manual is stable**: then `docs.qassist.run` gets a fix in
seconds and self-hosters get it at the next release, which is the right cadence
for each. It changes nothing about the source layout.
