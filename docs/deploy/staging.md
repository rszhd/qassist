# Staging — `staging.qassist.run`

The same box and the same two compose files as production, with production's
data swapped out — and the gate every release passes through. Orientation and
the other stacks: [`DEPLOY.md`](../../DEPLOY.md).

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

## Standing it up

**1. DNS.** An `A` record for `staging.qassist.run` → the same IP. (Added
alongside production's in step 1 above.)

**2. Configure.** `cp .env .env.staging`, then work through
[`.env.staging.example`](../../.env.staging.example) — it is the diff from
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

## Verifying the isolation

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

## The two things staging exists to close

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
starting a run returns 402. See [Billing](../api.md#billing) for what each
subscription status is allowed to do.

**The CI snippet (US-008).** Run [`manual/ci.md`](../../manual/ci.md)'s pipeline step for
real against `https://staging.qassist.run`, with a staging API key, over the
tests the seed created. Against production it would compete for
`MAX_CONCURRENT_SESSIONS` with whoever else is there — which is the reason the
snippet stayed unverified.

## Updating staging

Merge into `staging` and the image builds itself. On the box, `.env.staging`
already pins `:staging` and never changes, so a deploy is usually two words:

```sh
export ENV_FILE=.env.staging          # exported, not a command prefix — see above
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" \
  pull --policy always
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d
```

**The image is not the only thing the merge moved.** `~/qassist` is a checkout,
and it is where Compose reads the two YAML files from — so a promotion that
touched `docker-compose.yml` or `docker-compose.prod.yml` needs the checkout
updated too, before the `up -d` above:

```sh
cd ~/qassist && git fetch origin && git checkout -B staging origin/staging
git diff --stat <previous tip>..HEAD -- 'docker-compose*.yml' .env.example
```

Nothing pins the checkout to a branch — it holds every stack's compose files and
env files, so moving it moves what `demo` and the proxy would get on *their*
next `up -d`, which is why this is a step and not a `git pull` in a cron. The
stacks already running are untouched until each is recreated.

**This failure is silent, not loud** (seen promoting US-048): the new image
wants a `${FIXTURES_HOST_DIR}:/app/fixtures` mount that the old compose file
does not have, and `FIXTURES_DIR` defaults to that same path *inside* the
container — so the app boots clean, accepts fixture uploads, and loses them the
next time the container is recreated. A missing mount looks exactly like a
working one until something restarts. So diff the compose files against what
the box has, and read `.env.example` in the same pass for variables the merge
added that `.env.staging` now needs.

**`pull` is not optional here, and leaving it out looks like success.** With a
version tag, `up -d` fetching nothing is correct — the tag is immutable. With a
mutable tag, compose sees the same `qassist:staging` string it already has
locally, does not go to the registry, and reports the stack up to date while the
box keeps running last week's build. The version tag hid this; `:staging` does
not.

**`--policy always` is not decoration, and a bare `pull` rebuilds the same trap
one layer in.** `docker-compose.prod.yml` sets `pull_policy: missing` — it is
there for [preview](preview.md), which must find the image the box just built and
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

## Promoting staging to production

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
unset ENV_FILE          # this shell exported it for staging — see below
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Step 4 begins by undoing step 1's export**, and it is this page's job to say
so because this page is where the two stacks meet. Updating staging exports
`ENV_FILE=.env.staging`; production relies on that variable being *unset* so
`${ENV_FILE:-.env}` falls back. Follow the chain top to bottom in one shell and
production gets staging's secrets, its hostname and its test-mode Stripe keys
against production's database — a stack that pulls the right image and reports
healthy while serving the wrong configuration. Caught on the box 2026-08-05.
What it costs to recover, and the one-line check that catches it:
[Deploying a new version](production.md#deploying-a-new-version).

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
