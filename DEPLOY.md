# Deploying QAssist

The runbook for the public deployment at **qassist.run** (US-007). Everything
here is in the repo — nothing about the deployment may live only on the box, so
a rebuilt server is this document plus `.env`.

Self-hosting does **not** need any of this: `cp .env.example .env && docker
compose up` still serves the app on :8080 with no proxy and no certificate. This
is the overlay for putting it on a public hostname over HTTPS.

## What runs on the box

Three compose projects, deliberately separate:

| Project | Files | What it is |
|---|---|---|
| `qassist-proxy` | `docker-compose.proxy.yml` | Traefik: TLS, ACME, hostname routing. Shared. |
| `qassist` | `docker-compose.yml` + `docker-compose.prod.yml` | Production: app + its Postgres. |
| `qassist-staging` | the same two files | Staging — see [Staging](#staging). |

They meet on one external Docker network, `qassist-edge`. The proxy is its own
project so that taking an app stack down does not take everyone's TLS with it,
and so a second stack needs no change to the proxy at all — Traefik reads router
labels off containers through the Docker socket.

The app publishes **no host port**. Only Traefik binds anything (80 and 443), so
"8080 is unreachable from outside" is true by construction rather than by
firewall rule.

## First-time setup

**1. DNS.** An `A` record for `qassist.run` → the box's public IP. Add the
`staging.qassist.run` record in the same sitting even if staging comes later —
it costs nothing now and saves a second trip to the panel.

While in the DNS panel, add Resend's **SPF and DKIM** records for the domain and
verify it in the Resend dashboard. Until that is done Resend only delivers to the
account owner's own address, which is US-012's one outstanding item.

**2. Docker.** Install Docker Engine + the compose plugin, then create the shared
network once:

```sh
docker network create qassist-edge
```

**3. Configure.** Copy `.env.example` to `.env` and set, at minimum:

```sh
APP_HOST=qassist.run
PUBLIC_BASE_URL=https://qassist.run    # must agree with APP_HOST
ACME_EMAIL=you@example.com
QASSIST_IMAGE=ghcr.io/<owner>/qassist:<tag>
OPENAI_API_KEY=sk-...
```

`PUBLIC_BASE_URL` is not cosmetic: it is what puts a working recording link in
the PDF, a working run link in notification mail, and — because it is how the
app knows it is on HTTPS — what makes the session cookie `Secure`.

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

## Verifying a deployment

```sh
curl -sS https://qassist.run/api/health                     # {"ok":true,...}
curl -sSo /dev/null -w '%{http_code}\n' https://qassist.run/api/runs   # 401
curl -sSI http://qassist.run | head -1                      # 301 → https
docker compose -p qassist ps                                # app healthy
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

A deploy is a tag change:

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

## Certificates

Traefik requests and renews them automatically. The store is the `acme` named
volume on the `qassist-proxy` project, and it is the only state on the box worth
backing up besides `.env` and the database. Deleting it means re-issuing every
certificate, and Let's Encrypt rate-limits that — so do not `down -v` the proxy
project casually.

## Cutting over from the pre-US-007 stack

The original deployment ran the base compose file alone, published 8080, and was
reached over an SSH tunnel (`ssh -L 8090:localhost:8080`). Its database lives in
a volume named after the directory Compose ran in, not `qassist_pgdata`, so
adding `-p qassist` points the new stack at an **empty** database rather than
migrating the old one.

Check what is actually there before the first `up`:

```sh
docker volume ls | grep pgdata
```

If the existing volume is not `qassist_pgdata`, either dump and restore
(`pg_dump` from the old container, `psql` into the new one) or stop and rename by
creating `qassist_pgdata` and copying the contents across. Do this before
serving traffic on the new stack, and take the dump either way.
