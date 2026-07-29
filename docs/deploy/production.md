# Production — `app.qassist.run`

Standing up and running the production stack. Orientation, the box layout and
the other stacks: [`DEPLOY.md`](../../DEPLOY.md).

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
alone would suggest — and standing [preview](preview.md) up as well means that 3
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
curl -sSI http://app.qassist.run | head -1                      # 308 → https
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
survived [staging](staging.md), because `main` is only reachable through it
([the full chain](staging.md#promoting-staging-to-production)):

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

## Giving one account more (or less) of the box

`MAX_CONCURRENT_PER_USER` in `.env` is the number *everyone* gets, and changing
it needs a restart that kills every run in flight. US-058 adds a per-account
override that needs neither:

```sh
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run concurrency
#   → the instance default, the whole-box cap, and every account that differs

# give one team more of the box
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run concurrency -- them@example.com 4

# throttle one account back — the direction there was previously no lever for
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run concurrency -- noisy@example.com 1

# put them back on the instance default
docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
  exec qassist npm --prefix /app/server run concurrency -- them@example.com -
```

**A change takes effect on that account's next submitted run, not instantly and
not at the next restart.** The script runs in its own process and cannot reach
the server's memory, so the server re-reads the caller's own override on every
run-start request. Runs already queued keep going under whatever was in force
when they were admitted.

Three things the lever deliberately will not do. It **cannot raise anyone past
`MAX_CONCURRENT_SESSIONS`** — a bigger number is accepted and simply never
binds, because the whole-box cap is still the real throttle and resizing is
still the only way to move it. It **cannot be set to 0**: that is an account
suspension rather than a capacity limit, and the refusal a capped user sees
says "wait for one to finish", which for 0 would never come true. And it is
**not a plan entitlement** — nothing in billing writes this column, so a
subscription change never moves a number you set by hand.

Same exact-match rule as `activate`: no fuzzy matching, because throttling the
wrong account is not something the script can undo.

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
