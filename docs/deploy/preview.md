# Preview — `preview.qassist.run`

A spur off the promotion chain: whatever was last force-pushed to `preview`,
built on the box in seconds. Orientation and the other stacks:
[`DEPLOY.md`](../../DEPLOY.md).

`preview.qassist.run` runs whatever was last force-pushed to a `preview` branch,
built **on the box** (US-055). It exists because staging's bill — the full CI
suite, an image build carrying the Chromium layer, a push to ghcr, a `pull` here
— is the right price for proving a release and the wrong price for "is that the
right shade of grey". The fix is not a faster staging; it is to stop asking
staging the questions that do not need production fidelity.

**Preview is a spur off the chain, not a stage in it.** The chain is still
`dev → staging → main`. `preview` hangs off the side:

```sh
git push -f origin HEAD:preview     # from dev, or from any WIP branch
```

Two things follow, and both are the point. A branch that is not on `dev` yet can
be previewed — which is precisely when a live look is worth most. And US-052's
`--ff-only` promotion is untouched, because rewritten preview history never
enters staging's ancestry. **Nothing ever merges out of `preview`.**

`dev → preview → staging → main` was rejected. It reads naturally and is wrong
twice: it makes preview a mandatory gate, so everything must pass through the
environment that exists to be *optional*; and it puts force-pushed history
upstream of `staging`, which is the one invariant US-052 bought.

## What it costs

Three things, and none of them are free. Read them before standing it up:

1. **The box builds, for the first time.** US-032's `build: !reset null` exists
   so that a deployment never compiles what it serves. Preview is a deliberate
   exception and must stay confined to one — production and staging still
   cannot build — and it builds *unreviewed, untested* commits on the same
   Docker daemon as production. (The box already had a checkout before this:
   `~/qassist` holds the compose files and every stack's env file. What is new
   is building from one.)
2. **Disk — and the obvious prune is the wrong one.** `docker image prune -f`
   reclaims **nothing** across a rebuild: BuildKit moves the tag and drops the
   old manifest itself, so no dangling image is ever left. What grows is the
   **build cache**, which `image prune` cannot see (measured on the box,
   2026-07-26). Production shares that disk, and a full disk takes production
   down, so the bounded `buildx prune` below is part of the deploy.
   `--max-used-space` rather than a plain prune, because the cache is also what
   keeps a rebuild at seconds.
3. **RAM.** A fourth app container *and* a fourth Postgres.
   `MAX_CONCURRENT_SESSIONS=1`, and production's own budget may have to come
   down to pay for it — the worked example in
   [production's first-time setup](production.md#first-time-setup) already lands
   at 3 + 1 on 8 GB with no room spare.

## Standing it up

**1. DNS.** An `A` record for `preview.qassist.run` → the same IP. (Added
alongside production's in [its first-time setup](production.md#first-time-setup).)

**2. A clone, in its own directory.** The box already has a checkout at
`~/qassist` — it is where the other stacks' compose files and env files live,
and `docker compose ls` names it as their config path. Preview must **not**
build there. Its whole loop is `git checkout -B preview`, and switching that
branch would swap the compose files out from under three running stacks. So it
gets a clone of its own:

```sh
git clone https://github.com/<owner>/qassist.git ~/qassist-preview
cd ~/qassist-preview
```

`.gitignore` already covers `.env.*` and `runs-*/`, so the env file and the
artifacts sit inside that clone and a force-push never disturbs them.

**3. Configure.** Copy a *complete app* env into `~/qassist-preview/.env.preview`
and work through [`.env.preview.example`](../../.env.preview.example) — the diff from
that, not a second copy. Every secret **freshly generated**, as for the other
stacks.

**4. Up.** Fetch, build, start. This is also the update loop:

```sh
cd ~/qassist-preview
git fetch origin && git checkout -B preview origin/preview

docker build -t qassist:preview \
  --label org.opencontainers.image.revision="$(git rev-parse --short HEAD)" .

export ENV_FILE=.env.preview          # exported, not a command prefix — see Staging
docker compose -p qassist-preview \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d

docker buildx prune -f --max-used-space 6GB
```

`git checkout -B` rather than `pull`, because the branch is force-pushed: a
`pull` would try to merge two histories that diverged on purpose.

The `--label` is not decoration. It is the only way to answer "which commit is
this?" on an image that never went through a registry, and the check below reads
it.

Four mechanics worth knowing, because none of them are obvious:

- **No `pull`, and that is correct here.** `docker-compose.prod.yml` sets
  `pull_policy: missing`, so compose finds the `qassist:preview` image the build
  just produced and never reaches for a registry. This is the whole trick that
  lets a locally built image go through the same overlay as a published one.
- **`up -d` does recreate on a rebuild.** Compose compares the image *ID* it
  recorded against the container, not the tag string, so a fresh build under an
  unchanged tag is picked up. This is the exact inverse of staging's trap, where
  an unchanged *registry* tag is what silently is not fetched.
- **A rebuild is seconds, not minutes.** Measured on the box, 2026-07-26: **2 s**
  for a `server/src` change and **4 s** for a frontend one, of which Vite itself
  is 3.5 s. `pip install -r requirements.txt` and
  `playwright install --with-deps chromium` are keyed on `agent/requirements.txt`
  and `npm install` on `frontend/package.json`, so an ordinary change touches
  nothing but the `COPY`s and the Vite build. Two builds still cost real time:
  the first one on a cold cache, and any change to `agent/requirements.txt`,
  which reinstalls Chromium and its system libraries. Budget ~20 minutes for
  those and seconds for everything else.
- **There is no seed step.** Preview starts empty and is meant to. If a change
  needs a populated database, that is staging's `seed-staging.mjs`, and it is a
  hint that the change wants staging.
- **Billing and mail are real here** (revised 2026-07-26 — see
  [what preview must not become](#what-preview-must-not-become)). Stripe in
  **test** mode and a live Resend key, so a billing-gated change (US-053's
  checklist, US-054's activation window) can be looked at on the fast loop
  instead of costing a staging round trip. The webhook secret must be
  **preview's own**; the reason is below, and it is the one line in
  `.env.preview.example` that is a security boundary.

## Verifying it

```sh
curl -sS https://preview.qassist.run/api/health          # {"ok":true,…,"billing":true}
curl -sSI https://preview.qassist.run | grep -i x-robots-tag     # noindex, nofollow
```

**Confirm the running commit, not the tag.** The tag never changes, so it can
tell you nothing; the label the build stamped can:

```sh
docker inspect "$(docker compose -p qassist-preview ps -q qassist)" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
# the short sha of the preview branch tip — if it is the previous one, `up -d`
# did not recreate and you are looking at the last build
```

Mail is real, so a sign-in link arrives in an inbox rather than a log. If you
have deliberately set `MAIL_DEV_CONSOLE=1` for an afternoon instead, it is
printed:

```sh
docker compose -p qassist-preview logs qassist | grep -A5 '\[mail:dev\]'
```

**The billing round trip**, which is the thing that used to require staging:

```sh
# sign in as an address that is NOT OPERATOR_EMAIL — an exempt account is never
# walled, and is the usual reason "the wall does not appear" on a first try
# then: store a key, Subscribe, pay with 4242 4242 4242 4242

# with ACTIVATION_SLA_HOURS set, the account is now walled on the fourth step
docker compose -p qassist-preview exec qassist \
  npm --prefix /app/server run activate            # lists it, with time left
docker compose -p qassist-preview exec qassist \
  npm --prefix /app/server run activate -- you@example.com
# the wall falls in the open tab within 30s, and the customer mail arrives
```

Confirm the webhook is preview's own and not staging's — a shared signing secret
is the one isolation failure the checks below would not catch, because they test
cookies and API keys and this is neither:

```sh
docker compose -p qassist-preview logs qassist | grep -i 'invalid signature'
# and in the Stripe TEST dashboard: two endpoints, two secrets, one per host
```

Isolation, same three checks as the other stacks:

```sh
docker volume ls | grep pgdata      # qassist-preview_pgdata alongside the others

# a preview API key is refused by production and by staging
curl -sSo /dev/null -w '%{http_code}\n' https://app.qassist.run/api/runs \
  -H "Authorization: Bearer <a preview key>"                    # 401
```

And that the disk is not growing without bound. Read the **Build Cache** row,
not the Images one — images do not accumulate here, the cache does:

```sh
docker system df
df -h /
```

With the bounded `buildx prune` in each cycle this stays flat; without it,
rebuild cycles add gigabytes that `docker image prune` cannot reclaim.

## What preview must not become

The bill preview exists to skip is a CI run, an image push and a `pull`.
Environment variables cost none of it, so preview runs Stripe in **test** mode
and a real Resend key (revised 2026-07-26 —
[US-055](../../backlog/sprint/current/done/US-055-preview-environment.md)
shipped it stricter, which put every billing change on the slow loop for no
saving). What separates it from staging is the part that was always doing the
work:

- **A populated database.** Staging is seeded (`seed-staging.mjs`); preview
  starts empty and must stay that way. A migration meeting data it did not
  expect is the failure staging exists to catch, and the one thing preview
  structurally cannot tell you.
- **A build that went through CI**, from a reviewed commit, through the same
  registry production pulls from. Preview's image is built on the box from a
  force-pushed branch.
- **The promotion chain.** Nothing is ever promoted out of preview.

So preview must never grow a seed step, a live Stripe key, or any secret
production or staging also holds — and **its Stripe webhook secret must be its
own**. The webhook is unauthenticated by design: its signature is its
authentication, so a shared endpoint secret means an event minted for one stack
verifies against the other. That is an isolation hole the session-cookie and
API-key checks above would not find, because it is neither.

The older, stricter line is still available for an afternoon when you would
rather not have a live mail key on the box: set `MAIL_DEV_CONSOLE=1` and blank
the three `STRIPE_*` values, and preview is what US-055 shipped.

## CI on `dev` went with it

The same reasoning one layer up. `ci.yml` no longer runs on pushes to `dev`
(US-055): the gates are `staging.yml` and `release.yml`, both of which
`uses: ./.github/workflows/ci.yml` before publishing anything, so an image whose
tests never ran stays impossible either way. The `dev` run was informational,
about a branch that takes WIP pushes. A PR into `dev` still runs the full suite,
and so does a push to `staging`.

The tradeoff, stated rather than discovered: a broken test is now found at
merge-to-`staging` time, which is the slow round trip. Local `npm test` stops
being optional.
