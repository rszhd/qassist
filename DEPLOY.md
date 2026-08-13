# Deploying QAssist

The runbook for the public deployment at **app.qassist.run** (US-007).
Everything here is in the repo — nothing about the deployment may live only on
the box, so a rebuilt server is this document plus `.env`.

The app is on a **subdomain, not the apex** (decided 2026-07-25): `qassist.run`
is a landing page built and served outside this repo, so the only hostnames that
resolve to this box are `app.qassist.run`, `staging.qassist.run`,
`demo.qassist.run` and `docs.qassist.run`. That is why
nothing here ever mentions the apex except for the mail records, which belong to
the domain rather than to any one stack.

Self-hosting does **not** need any of this: `cp .env.example .env && docker
compose up` still serves the app on :8080 with no proxy and no certificate. This
is the overlay for putting it on a public hostname over HTTPS.

## The runbooks

One per stack. Each is standalone — stand-up, verification and the traps that
stack has actually hit — so a question about one costs reading one.

| Runbook | For |
|---|---|
| [Production](docs/deploy/production.md) | First-time setup, verifying a deployment, deploying a new version, capacity for a new subscriber, per-account concurrency. |
| [Staging](docs/deploy/staging.md) | Standing staging up, seeding it, verifying the isolation, and promoting `dev → staging → main`. |
| [The demo sandbox](docs/deploy/demo.md) | `AUTH_MODE=demo`, per-visitor tenants, the reaper, and keeping mail silent. |
| [The docs site](docs/deploy/docs-site.md) | The manual, published without an image build: standing it up, publishing by hand, and what it must not become. |

Certificates are shared by all four hostnames and are below.

## What runs on the box

Five compose projects, deliberately separate:

| Project | Hostname | Files | What it is |
|---|---|---|---|
| `qassist-proxy` | — | `docker-compose.proxy.yml` | Traefik: TLS, ACME, hostname routing. Shared. |
| `qassist` | `app.qassist.run` | `docker-compose.yml` + `docker-compose.prod.yml` | [Production](docs/deploy/production.md): app + its Postgres. |
| `qassist-staging` | `staging.qassist.run` | the same two files | [Staging](docs/deploy/staging.md): the same stack, production's data swapped out. |
| `qassist-demo` | `demo.qassist.run` | the same two files | [The demo sandbox](docs/deploy/demo.md): the same stack, `AUTH_MODE=demo`. |
| `qassist-docs` | `docs.qassist.run` | `docker-compose.docs.yml` | [The docs site](docs/deploy/docs-site.md): nginx plus a builder that follows `manual/` on `main`. Not the app at all. |

Three of the five are the same two compose files with a different `-p` and
`--env-file`. That is the design, not a coincidence: an environment is a project
name and an env file, and the overlay never learns which one it is serving.

The two that are not are the two that are not the app: the proxy, and the docs
site. **Docs gets a file of its own precisely because it is a different
workload.** A per-environment overlay for the app itself stays banned: that
would be the same app *parameterized*, and an overlay that knew which
environment it served would be wrong.

What differs besides the env file is where each one's image comes from.
`qassist` pins an immutable `:x.y.z` cut from `main`, and `qassist-staging`
tracks the mutable `:staging`, rebuilt on every push to the `staging` branch.
That spread is the point — production moves at the speed of a release, staging
at the speed of a merge. `qassist-docs` runs no image of ours at all: it is
stock nginx over a volume a builder fills from `main`, so the manual moves at
the speed of a push and a publish recreates nothing.

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

## Certificates

Traefik requests and renews them automatically. The store is the `acme` named
volume on the `qassist-proxy` project, and it is the only state on the box worth
backing up besides `.env` and the database. Deleting it means re-issuing every
certificate, and Let's Encrypt rate-limits that — so do not `down -v` the proxy
project casually.
