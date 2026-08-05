# Self-hosting

From nothing to a passing test on your own box, in about ten minutes. **Docker
is the only thing you install** — Node, Python and Chromium all live inside the
image.

Self-hosting is free for anything, forever: no seat count, no feature gate, no
key to buy. The only bill is the one you already have with OpenAI, because every
run is funded by the key you paste in, on every tier.

## Before you start

- **Docker** with Compose v2 (`docker compose version`).
- **An OpenAI API key.** There is deliberately no server-wide key setting — you
  paste yours into the app after first boot.
- **A box with room to run a browser.** Each concurrent run is a real Chromium
  and peaks around 700 MB. 2 vCPU / 4 GB is enough for two at a time; 4 vCPU /
  8 GB is comfortable for four.

You do not need to clone the repository, install a toolchain, or run a build.

## 1. Two files

```bash
mkdir qassist && cd qassist
curl -O https://raw.githubusercontent.com/rszhd/qassist/main/docker-compose.release.yml
curl -o .env https://raw.githubusercontent.com/rszhd/qassist/main/.env.example
```

The compose file pins an exact published image, so you always know which version
is running, and it is standalone — it references no other file in the repository.

## 2. One secret

```bash
sed -i "s/^KEY_ENCRYPTION_SECRET=$/KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)/" .env
```

`KEY_ENCRYPTION_SECRET` encrypts your stored OpenAI key, and your [saved
sessions](./saved-sessions.md), at rest. **Generate it once and keep it** —
losing it makes every stored key and session undecryptable.

Everything else in `.env` has a working default. Leave the rest alone for now.

## 3. Start it

```bash
docker compose -f docker-compose.release.yml up -d
```

Two containers come up: the app on port 8080, and a Postgres control plane that
holds your saved tests, run history and schedules. The schema creates and
migrates itself at boot — there is no separate migrate step.

```bash
curl -s http://localhost:8080/api/health
# {"ok":true,"active":0,"queued":0,"max_concurrent":4,"db":true,"auth":false,…}
```

`db: true` means the control plane is connected. `false` means the app is still
starting; give Postgres a few seconds and ask again.

Open `http://localhost:8080`, then follow [Your first run](./first-run.md) from
step 2.

## Before you expose it to anything

A fresh install has **no token**: the API needs no credential, and the server
logs a warning at startup saying so. That is fine on localhost and nowhere else.

```bash
openssl rand -hex 32   # paste into WORKER_API_TOKEN= in .env
docker compose -f docker-compose.release.yml up -d
```

The app then asks for the token once and keeps it. Every API and WebSocket call
carries it.

**Put it behind HTTPS.** The release compose publishes 8080 in the clear, which
is a localhost arrangement. The repository ships a Traefik overlay that serves a
public hostname with automatic Let's Encrypt certificates — the runbook is
[`DEPLOY.md`](https://github.com/rszhd/qassist/blob/main/DEPLOY.md). Two settings
go with it: `PUBLIC_BASE_URL` (the `https://` address, which makes the report's
recording link and the notification mail resolvable) and `TRUST_PROXY=1` (so the
per-IP guards count the visitor rather than the proxy container).

**If more than one person will use it**, turn on magic-link sign-in
(`AUTH_ENABLED`) instead of sharing a token. It needs a mail sender; `.env.example`
documents the three settings it refuses to boot without.

## Sizing it for your box

The real throttle is `MAX_CONCURRENT_SESSIONS` (default `4`). Runs over the cap
wait in a queue and are told their position.

> **Rule of thumb:** `floor((RAM_GB − 1.5) / 0.7)`

That comes from the ~700 MB a run peaks at, and 1.5 GB kept back for Postgres,
Node and the OS. It is a ceiling to size **down** from, not a target — the
700 MB was measured on one page with no model in the loop. It also assumes the
box is yours alone; subtract anything else running on it.

Two more caps are worth knowing before a run surprises you: `MAX_STEPS`
(default `60`) bounds how many actions one run may take, and
`RUN_TIMEOUT_SECONDS` (default `600`) bounds its wall clock, so a rate-limited
key cannot squat a browser slot.

::: warning The queue is in memory, not durable
A restart marks everything still waiting as errored. Drain before restarting if
that matters.
:::

## What to back up

Three things, with deliberately different lifetimes:

| What | Where | Why |
|---|---|---|
| `.env` | beside the compose file | Holds `KEY_ENCRYPTION_SECRET`. Lose it and every stored key and session is unreadable. |
| The `pgdata` volume | Docker named volume | Saved tests, suites, schedules and run verdicts. Kept forever. |
| `./runs` | bind mount | Per-run PDFs and recordings. Swept after `ARTIFACT_RETENTION_DAYS` (default 7) anyway. |

A swept run keeps its verdict, timings and step count — it simply stops offering
the report and the recording. **The database is the thing worth a real backup;
`runs/` is a cache with a deadline.**

## Upgrading

Edit the image tag in `docker-compose.release.yml`, then:

```bash
docker compose -f docker-compose.release.yml up -d
```

Pending migrations apply themselves at boot. **Pin the exact version** rather
than floating on `:latest` — a tag that changes under you is not a release.

## Turning on the optional parts

Each of these is off, or defaulted, on a fresh install. Set them in `.env` and
restart. The full list is [Settings](./settings.md).

- **PDF reports** — `REPORTS_ENABLED=1`. Off by default while the renderer is
  being reworked.
- **[Email notifications](./notifications.md)** — `RESEND_API_KEY` **and**
  `MAIL_FROM`, both, or the feature is simply off.
- **Testing something on a private network** — `QA_BLOCK_PRIVATE_NETWORKS=0`.
  See [Where a run may go](./navigation-fence.md) for what that floor is
  protecting.
- **Full HAR capture** — `CAPTURE_HAR=1`, or per run. The curated diagnostics
  are always on and need no setting.

`curl /api/health` reports which of these the instance actually has: `reports`,
`mail`, `billing`, `db`, `auth_mode`.

## When something is wrong

Start with [When a run goes wrong](./troubleshooting.md). Beyond that, the logs
carry the agent's own stdout:

```bash
docker compose -f docker-compose.release.yml logs -f qassist
```

**Port 8080 already taken?** Edit the left side of the `ports` mapping in the
compose file (`"9090:8080"`). Leave `PORT` alone — it is what the app listens on
*inside* the container, and changing it breaks the mapping.

## Changing it rather than running it

QAssist is **AGPL-3.0-only**. Self-hosting is free for anything, forever, and
running it is not what the licence asks anything about — the obligation attaches
to distributing a modified version, or offering one to others as a network
service.

The source, the contributor guide and the roadmap are
[on GitHub](https://github.com/rszhd/qassist).
