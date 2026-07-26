# Deploying QAssist

The runbook for the public deployment at **app.qassist.run** (US-007).
Everything here is in the repo — nothing about the deployment may live only on
the box, so a rebuilt server is this document plus `.env`.

The app is on a **subdomain, not the apex** (decided 2026-07-25): `qassist.run`
is a landing page built and served outside this repo, so the only hostnames that
resolve to this box are `app.qassist.run`, `staging.qassist.run`,
`demo.qassist.run` and `preview.qassist.run`. That is why nothing here ever
mentions the apex except for the mail records, which belong to the domain rather
than to any one stack.

Self-hosting does **not** need any of this: `cp .env.example .env && docker
compose up` still serves the app on :8080 with no proxy and no certificate. This
is the overlay for putting it on a public hostname over HTTPS.

## What runs on the box

Five compose projects, deliberately separate:

| Project | Hostname | Files | What it is |
|---|---|---|---|
| `qassist-proxy` | — | `docker-compose.proxy.yml` | Traefik: TLS, ACME, hostname routing. Shared. |
| `qassist` | `app.qassist.run` | `docker-compose.yml` + `docker-compose.prod.yml` | Production: app + its Postgres. |
| `qassist-staging` | `staging.qassist.run` | the same two files | [Staging](#staging): the same stack, production's data swapped out. |
| `qassist-demo` | `demo.qassist.run` | the same two files | [The demo sandbox](#the-demo-sandbox): the same stack, `AUTH_MODE=demo`. |
| `qassist-preview` | `preview.qassist.run` | the same two files | [Preview](#preview): the same stack, built on the box from a force-pushable branch. |

Four of the five are the same two compose files with a different `-p` and
`--env-file`. That is the design, not a coincidence: an environment is a project
name and an env file, and the overlay never learns which one it is serving.

What differs besides the env file is where each one's image comes from.
`qassist` pins an immutable `:x.y.z` cut from `main`; `qassist-staging` tracks
the mutable `:staging`, rebuilt on every push to the `staging` branch; and
`qassist-preview` runs a `qassist:preview` tag built on the box itself, with no
registry in the loop at all. That spread is the point — production moves at the
speed of a release, staging at the speed of a merge, preview at the speed of a
force-push.

**There is no separate API hostname**, and adding one would be a mistake. One
Express process serves the built frontend and mounts the API under `/api` on the
same port, behind one router — so the endpoint CI and Stripe talk to is just
`https://<hostname>/api`, and the live view is `wss://<hostname>/ws`. The
frontend agrees by construction: it fetches relative paths and builds its socket
URL from `location.host`, which is why the same image serves any hostname with
no rebuild. Splitting the API onto `api.qassist.run` would point a second
certificate at the same process and make this the first thing in the app to need
CORS, which it currently has none of.

They meet on one external Docker network, `qassist-edge`. The proxy is its own
project so that taking an app stack down does not take everyone's TLS with it,
and so a second stack needs no change to the proxy at all — Traefik reads router
labels off containers through the Docker socket.

The app publishes **no host port**. Only Traefik binds anything (80 and 443), so
"8080 is unreachable from outside" is true by construction rather than by
firewall rule.

## First-time setup

**1. DNS.** An `A` record for `app.qassist.run` → the box's public IP. Add the
`staging.qassist.run`, `demo.qassist.run` and `preview.qassist.run` records in
the same sitting even if those stacks come later — they cost nothing now and
save a second trip to the panel. The apex is not one of them: it points wherever
the landing page is hosted, which is not here.

While in the DNS panel, add Resend's **SPF and DKIM** records. Those go on the
**apex** `qassist.run` whichever subdomain the app runs on, because mail sends
as `…@qassist.run` — then verify the domain in the Resend dashboard. Until that
is done Resend only delivers to the account owner's own address, which is
US-012's one outstanding item.

**2. Docker.** Install Docker Engine + the compose plugin, then create the shared
network once:

```sh
docker network create qassist-edge
```

**3. Configure.** Copy `.env.example` to `.env` and set, at minimum:

```sh
APP_HOST=app.qassist.run
PUBLIC_BASE_URL=https://app.qassist.run    # must agree with APP_HOST
ACME_EMAIL=you@example.com
QASSIST_IMAGE=ghcr.io/<owner>/qassist:<tag>
KEY_ENCRYPTION_SECRET=<openssl rand -hex 32>
TRUST_PROXY=1
```

`TRUST_PROXY` belongs to every stack behind the proxy, not just this one. It is
commented out in `.env.example` because a self-host publishing 8080 directly must
*not* believe `X-Forwarded-For` — but here the app only ever hears from Traefik,
so without it `req.ip` is the proxy's container address on every request and each
per-IP limit in the app quietly becomes a limit on the deployment. `1` is the
number of hops we have; it is not the same as `true`, which would count whatever
the client claimed.

There is deliberately no server-wide OpenAI key variable (US-039): every run is
funded by the key its caller stored in Settings, encrypted under
`KEY_ENCRYPTION_SECRET`.
Generate that secret once and keep it with the volume — losing it makes every
stored key undecryptable. A deployed instance holds no key of its own, so a
hostname anyone can register on cannot spend yours.

`PUBLIC_BASE_URL` is not cosmetic: it is what puts a working recording link in
the PDF, a working run link in notification mail, and — because it is how the
app knows it is on HTTPS — what makes the session cookie `Secure`.

`MAX_CONCURRENT_SESSIONS` deserves a thought rather than the default.
`.env.example`'s rule — `floor((RAM_GB − 1.5) / 1)` — assumes the box is yours
alone. Subtract anything else living on it, and subtract every other stack that
borrows from the same RAM. A 4 vCPU / 8 GB box already running an unrelated
database lands at **3 for production and 1 for staging**, not the 6 the rule
alone would suggest — and standing [preview](#preview) up as well means that 3
comes down, because a fourth app container brings a fourth Postgres with it.

If this instance runs multi-user auth, also set `AUTH_ENABLED=1`,
`SESSION_SECRET`, `RESEND_API_KEY` and `MAIL_FROM`; the app refuses to boot
with auth on and any of them missing. Generate `SESSION_SECRET` with
`openssl rand -hex 32`, *separately* from `KEY_ENCRYPTION_SECRET` — rotating
sessions must never make every stored BYOK key undecryptable.

**4. Up.**

```sh
docker compose -p qassist-proxy -f docker-compose.proxy.yml up -d
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Pass `-p qassist` every time. Without it Compose names the project after the
directory, and the project name is what the router name, the network and the
`pgdata` volume are all derived from — so an inconsistent `-p` silently talks to
a different database.

The first request to the hostname is what triggers certificate issuance; give it
a few seconds. `docker compose -p qassist-proxy logs traefik` shows the ACME
exchange if it doesn't.

**If the hostname answers HTTPS with a `TRAEFIK DEFAULT CERT` and the HTTP→HTTPS
redirect still works, the Docker provider is down, not ACME.** The redirect is
static entrypoint config, so it survives a provider that never loaded — which
makes this look like a certificate problem when it is a discovery problem. The
log says so plainly (`client version 1.24 is too old`): Traefik before v3.7
pinned Docker API 1.24 and Engine 29 requires ≥1.40, which is why
`docker-compose.proxy.yml` pins v3.7. Seen on this box, 2026-07-25.

## Verifying a deployment

```sh
curl -sS https://app.qassist.run/api/health                     # {"ok":true,...}
curl -sSo /dev/null -w '%{http_code}\n' https://app.qassist.run/api/runs   # 401
curl -sSI http://app.qassist.run | head -1                      # 301 → https
docker compose -p qassist ps                                    # app healthy
```

Then, by hand, the three things a curl does not cover:

- **The WebSocket.** Start a run in the UI and confirm frames arrive. Traefik
  proxies the `/ws` upgrade on the same router with no extra configuration, but
  it is the one part of the routing that fails silently, so look at it.
- **Port 8080 is not published.** `ss -tlnp | grep 8080` on the box finds
  nothing, and `curl http://<ip>:8080` from elsewhere times out.
- **Mail.** Fail a run deliberately and confirm the report reaches an address
  that is *not* the Resend account owner's, and that the run link in it opens
  the run.

## Deploying a new version

A production deploy is a tag change — and one whose *commits* have already
survived [staging](#staging), because `main` is only reachable through it
([the full chain](#promoting-staging-to-production)):

```sh
# .env: QASSIST_IMAGE=ghcr.io/<owner>/qassist:1.4.0
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Compose recreates the app container and leaves `db` alone. Rolling back is the
previous tag through the same command.

**Migrations run at boot**, from `db/migrations/*.sql`, against whatever schema
is already there. There is no separate migrate step and no down-migration — so a
tag that carries a migration should reach production only after the same tag has
started cleanly against a *populated* database, which is what staging is for.

## Adding capacity for a new subscriber

Production runs with `ACTIVATION_SLA_HOURS=24` (US-054), so a paid account
waits up to a day while the box is resized for it rather than competing for
`MAX_CONCURRENT_SESSIONS` the moment its card clears. Nothing auto-activates:
the flag is set by hand, here, beside the resize it pays for.

You are mailed at `OPERATOR_EMAIL` the moment someone starts waiting, with the
deadline. Then:

```sh
# 1. who is waiting, and how long each has left
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run activate

# 2. resize the box for them — the actual work. Then raise the cap it bought:
#    .env: MAX_CONCURRENT_SESSIONS=…
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d

# 3. only now, let them in. They are emailed; the wall falls in their open tab.
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run activate -- them@example.com
```

Step 3 before step 2 is the one mistake worth naming: it hands a customer a box
nobody upgraded, which is the failure this window exists to prevent. **If the
deadline cannot be met, the lever is Stripe** — refund or cancel — not a flag
set on an empty room.

The address must match exactly (case and spacing aside); there is no fuzzy
match, because activating the wrong account is not something the script can
undo. Running it twice is harmless and mails nobody a second time.

**To stop rationing capacity altogether**, once the box is big enough: delete
`ACTIVATION_SLA_HOURS` from `.env` and bring the stack up. Everyone currently
in the window is released by that restart — there is no backlog to work
through, and no account is left half-provisioned.

## Staging

`staging.qassist.run` is **the same box and the same two compose files** as
production (US-038). It exists so that a release, a migration, a Stripe round
trip and the CI snippet can each be proven against something real before the
thing real users are on.

**Staging tracks a branch, production tracks a tag** (US-052). Every push to
`staging` publishes `ghcr.io/<owner>/qassist:staging`, so getting a change onto
the real box costs a merge rather than a version — and `main` is only reached
through staging, which makes a released tag by construction something staging
already ran. The full chain is [dev → staging → main](#promoting-staging-to-production).

The project name is what separates the two. `-p qassist-staging` gives it its
own network, its own `db` container, its own `pgdata` volume and — because the
Traefik router, middleware and service names are derived from
`${COMPOSE_PROJECT_NAME}` — its own certificate and router on the shared proxy.
Nothing in the overlay knows which environment it is, and nothing should: if it
ever needs an `if staging`, the overlay is wrong.

It is deliberately **not** a load-testing environment. Sharing the box means
staging borrows RAM from production, so its `MAX_CONCURRENT_SESSIONS` is 1–2.
The purpose is fidelity of the deploy, not capacity.

### Standing it up

**1. DNS.** An `A` record for `staging.qassist.run` → the same IP. (Added
alongside production's in step 1 above.)

**2. Configure.** `cp .env .env.staging`, then work through
[`.env.staging.example`](.env.staging.example) — it is the diff from
production, not a second copy, and it lists exactly the values that must change.
The ones that matter most:

- `SESSION_SECRET`, `NOTIFY_SECRET`, `KEY_ENCRYPTION_SECRET` and
  `WORKER_API_TOKEN` must be **distinct values**, not just a distinct file. A
  staging session cookie or API key is refused by production only because the
  secret that signs it differs.
- `STRIPE_*` are **test-mode** keys, a test price, and the signing secret of
  staging's own webhook endpoint — a Stripe endpoint's secret is per-endpoint,
  so reusing production's makes every event here fail verification.
- `NOTIFY_EMAILS` / `OPERATOR_EMAIL` are a maintainer-only address. No project
  on staging may carry a stranger's. `MAIL_DEV_CONSOLE` stays **off**: the point
  is to prove the Resend path works, and console-logging proves nothing.

**3. Up.** Name the env file once, in an **exported** shell variable, and pass
it to both `--env-file` and the container:

```sh
export ENV_FILE=.env.staging
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file "$ENV_FILE" up -d
```

Both are needed and they must agree. `--env-file` only feeds interpolation of
the compose files — it does not change which file is loaded *into* the
container. `ENV_FILE` is what does that, and passing one variable to both is
what stops them disagreeing. Production needs neither: `ENV_FILE` defaults to
`.env`.

`export` on its own line is load-bearing, and the obvious one-liner is wrong.
In `ENV_FILE=.env.staging docker compose … --env-file "$ENV_FILE"` the
assignment is a *command prefix*: it goes into the environment of the command
being run, but the shell expands that command's own arguments first, while
`ENV_FILE` is still unset. So `--env-file` receives an empty string,
interpolation falls back to `.env`, and you get a stack named
`qassist-staging` running **production's** hostname and secrets — the trap
below, rebuilt out of shell semantics instead of compose ones. Caught on the
box, 2026-07-25. `set -u` turns it into an error instead of a silent
production-config boot, which is a good reason to run the stand-up under it.

Confirm it took, because this is the failure that looks like success:

```sh
docker compose -p qassist-staging exec qassist printenv PUBLIC_BASE_URL
# https://staging.qassist.run — if this says production's URL, the container
# loaded production's .env and every secret above is production's too.
```

**4. Populate it.** A migration is only rehearsed if there are rows to migrate:

```sh
docker compose -p qassist-staging -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file "$ENV_FILE" \
  exec qassist node /app/server/scripts/seed-staging.mjs you@example.com
```

`--env-file` is needed even for `exec`: naming the compose files means they get
interpolated, and without it `APP_HOST` comes from `.env` — which on a box where
production is not up is unset, so the overlay's `APP_HOST:?` guard aborts.

That seeds a project, a module, four tests, a suite, a schedule and five
finished runs — the demo sandbox's dataset (US-036), minus the TTL, so the demo
reaper never touches it. It refuses to touch an account that already owns
anything, so re-running it is a no-op.

### Verifying the isolation

Worth doing once, since the whole value of staging is that these are true:

```sh
# separate databases: this destroys staging's and leaves production's alone
docker compose -p qassist-staging down -v
docker volume ls | grep pgdata          # qassist_pgdata still there

# separate credentials: a staging API key is refused by production
curl -sSo /dev/null -w '%{http_code}\n' https://app.qassist.run/api/runs \
  -H "Authorization: Bearer <a staging key>"        # 401

# not indexed
curl -sSI https://staging.qassist.run | grep -i x-robots-tag   # noindex, nofollow
```

### The two things staging exists to close

Both are items no test in the repo can stand in for, and both were pointing at
production until staging existed.

**A live Stripe round trip (US-022).** In the Stripe dashboard, add a webhook
endpoint at `https://staging.qassist.run/api/billing/webhook` subscribed to the
checkout and subscription events, and put *that endpoint's* signing secret in
`.env.staging`. Then sign in on staging, Subscribe, and pay with test card
`4242 4242 4242 4242` — a real Checkout and a real webhook, on test keys, with
production's live endpoint never seeing the event. `stripe listen` is a local
substitute and is not needed here; this is the real delivery path. The rest of
the lifecycle is `stripe trigger customer.subscription.deleted`, after which
starting a run returns 402. See [Billing](docs/api.md#billing) for what each
subscription status is allowed to do.

**The CI snippet (US-008).** Run [`docs/ci.md`](docs/ci.md)'s pipeline step for
real against `https://staging.qassist.run`, with a staging API key, over the
tests the seed created. Against production it would compete for
`MAX_CONCURRENT_SESSIONS` with whoever else is there — which is the reason the
snippet stayed unverified.

### Updating staging

Merge into `staging` and the image builds itself. On the box, `.env.staging`
already pins `:staging` and never changes, so a deploy is two words:

```sh
export ENV_FILE=.env.staging          # exported, not a command prefix — see above
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" \
  pull --policy always
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d
```

**`pull` is not optional here, and leaving it out looks like success.** With a
version tag, `up -d` fetching nothing is correct — the tag is immutable. With a
mutable tag, compose sees the same `qassist:staging` string it already has
locally, does not go to the registry, and reports the stack up to date while the
box keeps running last week's build. The version tag hid this; `:staging` does
not.

**`--policy always` is not decoration, and a bare `pull` rebuilds the same trap
one layer in.** `docker-compose.prod.yml` sets `pull_policy: missing` — it is
there for [preview](#preview), which must find the image the box just built and
never reach for a registry — and Compose applies that policy to the explicit
`pull` subcommand too, not only to the implicit pull inside `up`. So the bare
command prints `Skipped - Image is already present locally` and exits 0, and the
box stays on the previous build having reported success twice. The flag
overrides the policy for one invocation, which is the right shape here: the
setting belongs to preview and is correct there, so this is staging opting out
rather than the file being wrong. Seen on this box 2026-07-27, Compose v5.3.1 /
Engine 29.6.1, one deploy after `:staging` started tracking the branch.

So confirm what you actually got, by digest and not by tag:

```sh
docker compose -p qassist-staging images qassist
docker image inspect ghcr.io/<owner>/qassist:staging \
  --format '{{index .RepoDigests 0}}{{"\n"}}{{index .Config.Labels "org.opencontainers.image.revision"}}'
# the revision label is the commit — it should be the tip of `staging`
```

Rolling back does not mean rebuilding: every push also published an immutable
`:staging-<sha>`, so pin one of those in `.env.staging` and run the same two
commands. Put `:staging` back when the branch is healthy again.

### Promoting staging to production

**Staging green is what earns the merge**, and the merge is what earns a tag.
`main` is not a branch anyone pushes to directly — it is the record of what
survived staging, which is what makes "production runs something that was
proven" a property of the graph rather than a thing to remember.

```sh
# 1. staging has been running the candidate, healthy, against a populated
#    database — including its migrations
docker compose -p qassist-staging ps
docker compose -p qassist-staging logs qassist | grep -i migrat

# 2. promote the code: the commit staging proved becomes main
git checkout main && git merge --ff-only staging && git push origin main

# 3. cut the release from main — this is the only thing that moves :latest,
#    and the pin in docker-compose.release.yml must match the tag
git tag v1.4.0 && git push origin v1.4.0

# 4. production pins the version the tag published
#    .env: QASSIST_IMAGE=ghcr.io/<owner>/qassist:1.4.0
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Step 2 is `--ff-only` on purpose.** A fast-forward is the mechanical proof
that `main` is nothing but staging's history — the moment it needs a merge
commit, something reached `main` that staging never ran, and the command failing
is how you find out. That only holds if `main` starts out as an ancestor of
`staging`, which is a one-time reconciliation: merge `main` into `dev` (it
carries two old merge commits from before this chain existed), then branch
`staging` from there. After that the property maintains itself.

Step 3 rebuilds rather than re-tagging the digest staging ran. The tree is
identical — `main` receives staging's commits and nothing else — so what is
rebuilt is the image, not the code, and in exchange a released tag is one that
`release.yml`'s pin check and `latest` promotion have both been through.

**Production stays on version tags, deliberately.** It is what a rollback pins,
what a self-hoster reads in the README, and what makes "which build is prod on"
answerable without a `docker image inspect`. Rolling back is the previous
version through step 4. Note that a migration is not rolled back by rolling back
the image — there are no down-migrations, so what staging is really proving in
step 1 is that you will not need to.

## Preview

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

### What it costs

Three things, and none of them are free. Read them before standing it up:

1. **The box builds, for the first time.** US-032's `build: !reset null` exists
   so that a deployment never compiles what it serves. Preview is a deliberate
   exception and must stay confined to one — production and staging still
   cannot build — and it builds *unreviewed, untested* commits on the same
   Docker daemon as production. (The box already had a checkout before this:
   `~/qassist` holds the compose files and every stack's env file. What is new
   is building from one.)
2. **Disk — and the obvious prune is the wrong one.** Measured on the box,
   2026-07-26: `docker image prune -f` reclaims **nothing** across a rebuild.
   BuildKit moves the tag and drops the old manifest itself, so no dangling
   image is ever left. What grows is the **build cache** — two rebuilds took it
   from 5.05 GB to 7.81 GB, none of which `image prune` can see. Production
   shares that disk, and a full disk takes production down, so the bounded
   `buildx prune` below is part of the deploy. `--max-used-space` rather than a
   plain prune, because the cache is also what keeps a rebuild at seconds.
3. **RAM.** A fourth app container *and* a fourth Postgres.
   `MAX_CONCURRENT_SESSIONS=1`, and production's own budget may have to come
   down to pay for it — the worked example [above](#first-time-setup) already
   lands at 3 + 1 on 8 GB with no room spare.

### Standing it up

**1. DNS.** An `A` record for `preview.qassist.run` → the same IP. (Added
alongside production's in step 1 above.)

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
and work through [`.env.preview.example`](.env.preview.example) — the diff from
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

### Verifying it

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

With the bounded `buildx prune` in each cycle this is flat: three cycles on
2026-07-26 left Images at 19.48 GB, Build Cache at 5.75 GB and the filesystem at
31 G used, unchanged from the cycle before. Without it, two cycles alone added
2.8 GB that `docker image prune` could not reclaim.

### What preview must not become

**Revised 2026-07-26.** US-055 drew this line at "console mail, no Stripe keys",
reasoning that the day preview had both there would be two staging environments
and no preview. That turned out to bundle two unlike things, and the bundle cost
more than it saved.

The bill preview exists to skip is a CI run, an image push and a `pull`.
Environment variables cost none of it — preview still rebuilds in seconds with
Stripe and Resend configured. What the rule actually did was put every billing
and entitlement change (US-053, US-054, and everything after them) permanently
on the slow loop, which is the class of change where a live look is worth most.
So preview now runs Stripe in **test** mode and a real Resend key.

What still separates it from staging is the part that was always doing the work:

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

### CI on `dev` went with it

The same reasoning one layer up. `ci.yml` no longer runs on pushes to `dev`
(US-055): the gates are `staging.yml` and `release.yml`, both of which
`uses: ./.github/workflows/ci.yml` before publishing anything, so an image whose
tests never ran stays impossible either way. The `dev` run was informational,
about a branch that takes WIP pushes. A PR into `dev` still runs the full suite,
and so does a push to `staging`.

The tradeoff, stated rather than discovered: a broken test is now found at
merge-to-`staging` time, which is the slow round trip. Local `npm test` stops
being optional.

## The demo sandbox

`demo.qassist.run` is the product with no signup and no key: a visitor lands and
is already inside a working instance, seeded with fake data, where every run
replays a checked-in recording. It is the conversion surface — the whole point
is that the "Try the demo" button leads somewhere real in a second.

It is **the same box and the same two compose files** a third time, under
`-p qassist-demo`. Nothing in the overlay knows about it. What makes it a demo
is one variable, `AUTH_MODE=demo` (US-036): the app provisions an expiring
cookie tenant per visitor, seeds it, and intercepts every run into a replay.

**It is the cheapest of the app stacks to host.** A demo run spawns no
Chromium, claims no queue slot and makes no LLM call — `createRun` short-circuits
to the replay before the concurrency branch — and its artifacts are symlinks into
`/app/demo`, so `runs-demo/` never grows. A visitor costs a few rows and a
cookie. What has to be bounded is *tenants*, and `DEMO_MAX_TENANTS` /
`DEMO_IP_MAX` do that.

What has to be bounded second is **what a public, writable, unauthenticated
deployment can reach**. Read `.env.demo.example` in that light: mail off so a
visitor cannot make the box send a PDF to a stranger, Stripe empty so nobody
meets a paywall for an account they never made, and its own secrets so a demo
cookie is refused everywhere else.

### Standing it up

**0. The image must carry the fixtures.** `DEMO_DIR` defaults to `/app/demo`,
and the `COPY demo/ /app/demo/` line that puts them there landed after `v0.2.0`
— on an earlier tag the stack boots fine and every run fails at the fixture
read. So run a tag built from this commit or later, and check it before
believing the deployment:

```sh
docker compose -p qassist-demo exec qassist ls /app/demo
# discount-broken  register-account
```

**1. DNS.** An `A` record for `demo.qassist.run` → the same IP. (Added alongside
production's in step 1 above.)

**2. Configure.** Copy a *complete app* env and work through
[`.env.demo.example`](.env.demo.example) — the diff from that, not a second copy.
`cp .env .env.demo` is right only once production exists: on a box that runs the
proxy plus staging, `.env` holds `ACME_EMAIL` for the proxy project and nothing
else, so copying it yields an env missing everything. `--env-file` replaces
rather than merges, so start from whichever complete app env the box has.

Two to get right twice: `SESSION_SECRET`, because `demoMode()` ANDs it in and a
blank one means this hostname is not serving what you think it is; and
`TRUST_PROXY=1`, without which `DEMO_IP_MAX` counts Traefik's address rather
than each visitor's and the demo turns away its sixth stranger of the hour.

Every secret must be **freshly generated**, not inherited from the stack you
copied — the isolation check below is what catches it if not.

**3. Up.** Same shape as staging, and the exported `ENV_FILE` is load-bearing
for the same reason (see [Standing it up](#standing-it-up) under Staging — the
one-liner silently boots production's config):

```sh
export ENV_FILE=.env.demo
docker compose -p qassist-demo \
  -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file "$ENV_FILE" up -d

docker compose -p qassist-demo exec qassist printenv PUBLIC_BASE_URL TRUST_PROXY
# https://demo.qassist.run — anything else and it loaded another stack's .env
# 1 — blank means the per-visitor throttle is a deployment-wide one
```

`TRUST_PROXY` has no observable symptom from one machine (your sixth request is
refused either way), which is why it is checked here rather than below. The
behavioural proof needs two networks — a laptop and a phone off wifi — and the
parse itself is pinned in `server/test/trust-proxy.test.js`.

There is **no seed step**. The seeding is per visitor and happens on the first
request; `POST /api/demo/session` is the one unauthenticated endpoint, and it is
what mints and populates a tenant.

### Verifying it

```sh
# a visitor with no cookie gets a tenant, seeded and scoped to them
curl -sS -X POST https://demo.qassist.run/api/demo/session -c /tmp/demo.jar
curl -sS https://demo.qassist.run/api/runs -b /tmp/demo.jar | head -c 200

# it says it is the demo, and points somewhere to sign up
curl -sS https://demo.qassist.run/api/health   # auth_mode: "demo", cta_url set

# indexable, unlike staging
curl -sSI https://demo.qassist.run | grep -i x-robots-tag        # all
```

Then in a browser: History, Projects, Suites, Schedules and Settings are all
populated, Run streams a replay over the WebSocket and writes into *that*
tenant's history, and a second browser (or a private window) sees none of it.
While a demo run plays, no Chromium exists — the container is running `sh` and
`node` and nothing else.

To check the WebSocket from the shell instead, **force HTTP/1.1**. Over HTTP/2
curl negotiates away the upgrade, Express never matches `/ws`, and you get a 404
that reads like a broken route:

```sh
curl -sSi -N --http1.1 -b /tmp/demo.jar \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  "https://demo.qassist.run/ws?runId=<id>"
# 101 Switching Protocols, then the fixture's step events
```

**The reaper is the one thing only the box can prove.** Its rows-and-disk halves
are pinned assertion-first in the test suite, but the disk half is only real
here. After `DEMO_TTL_SECONDS`, an expired tenant's runs are gone from the
database *and* their directories are gone from `runs-demo/` — the reaper sweeps
quarter-hourly, so allow for that:

```sh
ls runs-demo/ | wc -l
docker compose -p qassist-demo logs qassist | grep -i reap
```

**And mail must stay silent.** Enable failure emails on a sandbox project, run a
failing test, and confirm nothing is sent — no `notifications` row reaches
`status=sent`. This is the criterion that says a stranger cannot use the demo to
mail a PDF to an address of their choosing.

### Isolation from the others

Same checks as staging, one stack over:

```sh
# its own database volume; this destroys the demo's and nothing else
docker volume ls | grep pgdata          # qassist-demo_pgdata alongside the others
docker compose -p qassist-demo down -v

# its own credentials: a demo cookie or key is refused by production and staging
curl -sSo /dev/null -w '%{http_code}\n' https://app.qassist.run/api/runs \
  -b /tmp/demo.jar                                              # 401
```

Which tag the demo runs is a separate decision from staging's: staging runs the
promotion candidate by definition, the demo tracks **production's** tag. It is a
public surface, and staging is where a bad tag is supposed to be found.

## Certificates

Traefik requests and renews them automatically. The store is the `acme` named
volume on the `qassist-proxy` project, and it is the only state on the box worth
backing up besides `.env` and the database. Deleting it means re-issuing every
certificate, and Let's Encrypt rate-limits that — so do not `down -v` the proxy
project casually.

## Cutting over from the pre-US-007 stack

The original deployment ran the base compose file alone under the project name
`qagent`, published 8080, and was reached over an SSH tunnel (`ssh -L
8090:localhost:8080`). **On our box there is nothing left to cut over from**
(checked 2026-07-25): it had no `pgdata` volume at all — only an empty
`qagent_default` network, a stale `qagent:latest` image and some `/tmp`
scratch, all since removed. So the first `up` here starts from an empty
database by design, and no migration step is owed.

The check is still worth keeping, because the trap it describes is real for
anyone standing this overlay up beside an older stack of their own. A project
name is what the `pgdata` volume is named after, so adding `-p qassist` to a
stack that used to run without it points at an **empty** database rather than
the old one:

```sh
docker volume ls | grep pgdata
```

If a populated volume exists under some other name, either dump and restore
(`pg_dump` from the old container, `psql` into the new one) or create
`qassist_pgdata` and copy the contents across — before serving traffic on the
new stack, and take the dump either way.
