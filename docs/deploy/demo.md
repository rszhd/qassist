# The demo sandbox — `demo.qassist.run`

The product with no signup and no key, where every run replays a checked-in
recording. Orientation and the other stacks: [`DEPLOY.md`](../../DEPLOY.md).

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

## Standing it up

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
production's in [its first-time setup](production.md#first-time-setup).)

**2. Configure.** Copy a *complete app* env and work through
[`.env.demo.example`](../../.env.demo.example) — the diff from that, not a second copy.
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
for the same reason (see [Standing it up](staging.md#standing-it-up) under Staging — the
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

## Verifying it

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

## Isolation from the others

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
