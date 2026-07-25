# Deploying QAssist

The runbook for the public deployment at **app.qassist.run** (US-007).
Everything here is in the repo — nothing about the deployment may live only on
the box, so a rebuilt server is this document plus `.env`.

The app is on a **subdomain, not the apex** (decided 2026-07-25): `qassist.run`
is a landing page built and served outside this repo, so the only hostnames that
resolve to this box are `app.qassist.run` and `staging.qassist.run`. That is why
nothing here ever mentions the apex except for the mail records, which belong to
the domain rather than to either stack.

Self-hosting does **not** need any of this: `cp .env.example .env && docker
compose up` still serves the app on :8080 with no proxy and no certificate. This
is the overlay for putting it on a public hostname over HTTPS.

## What runs on the box

Three compose projects, deliberately separate:

| Project | Hostname | Files | What it is |
|---|---|---|---|
| `qassist-proxy` | — | `docker-compose.proxy.yml` | Traefik: TLS, ACME, hostname routing. Shared. |
| `qassist` | `app.qassist.run` | `docker-compose.yml` + `docker-compose.prod.yml` | Production: app + its Postgres. |
| `qassist-staging` | `staging.qassist.run` | the same two files | [Staging](#staging): the same stack, production's data swapped out. |

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
`staging.qassist.run` record in the same sitting even if staging comes later —
it costs nothing now and saves a second trip to the panel. The apex is not one
of them: it points wherever the landing page is hosted, which is not here.

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
OPENAI_API_KEY=sk-...
```

`PUBLIC_BASE_URL` is not cosmetic: it is what puts a working recording link in
the PDF, a working run link in notification mail, and — because it is how the
app knows it is on HTTPS — what makes the session cookie `Secure`.

`MAX_CONCURRENT_SESSIONS` deserves a thought rather than the default.
`.env.example`'s rule — `floor((RAM_GB − 1.5) / 1)` — assumes the box is yours
alone. Subtract anything else living on it, and subtract staging, which borrows
from the same RAM. A 4 vCPU / 8 GB box already running an unrelated database
lands at **3 for production and 1 for staging**, not the 6 the rule alone would
suggest.

If this instance runs multi-user auth, also set `AUTH_ENABLED=1`,
`SESSION_SECRET`, `KEY_ENCRYPTION_SECRET`, `RESEND_API_KEY` and `MAIL_FROM`; the
app refuses to boot with auth on and any of the first three missing. Generate
each secret with `openssl rand -hex 32`, and generate them *separately* —
`KEY_ENCRYPTION_SECRET` is deliberately not `SESSION_SECRET`, so that rotating
sessions never makes every stored BYOK key undecryptable.

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

A deploy is a tag change — and, once [staging](#staging) exists, one that the
same tag has already survived there:

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

## Staging

`staging.qassist.run` is **the same box and the same two compose files** as
production (US-038). It exists so that a release, a migration, a Stripe round
trip and the CI snippet can each be proven against something real before the
thing real users are on.

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
starting a run returns 402. See [Billing](README.md#billing) for what each
subscription status is allowed to do.

**The CI snippet (US-008).** Run [`docs/ci.md`](docs/ci.md)'s pipeline step for
real against `https://staging.qassist.run`, with a staging API key, over the
tests the seed created. Against production it would compete for
`MAX_CONCURRENT_SESSIONS` with whoever else is there — which is the reason the
snippet stayed unverified.

### Promoting a tag

Staging green is what earns a tag production's `.env`:

```sh
# 1. staging runs the candidate
#    .env.staging: QASSIST_IMAGE=ghcr.io/<owner>/qassist:1.4.0
export ENV_FILE=.env.staging          # exported, not a command prefix — see above
docker compose -p qassist-staging \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d

# 2. it comes up healthy against a populated database, and migrations applied
docker compose -p qassist-staging ps
docker compose -p qassist-staging logs qassist | grep -i migrat

# 3. same tag into production's .env, same command without -p qassist-staging
#    .env: QASSIST_IMAGE=ghcr.io/<owner>/qassist:1.4.0
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Rolling back is the previous tag through step 3. Note that a migration is not
rolled back by rolling back the image — there are no down-migrations, so what
staging is really proving in step 2 is that you will not need to.

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
