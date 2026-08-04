# Self-hosting quickstart

From nothing to a passing test on your own box, in about ten minutes. Docker is
the only thing you install — Node, Python and Chromium all live inside the
image.

Self-hosting is free for anything, forever, with no seat count and no feature
gate. The only bill is the one you already have with OpenAI: every run is funded
by the key you paste in, on every tier.

## Before you start

- **Docker** with Compose v2 (`docker compose version`).
- **An OpenAI API key.** There is deliberately no server-wide key setting — you
  paste yours into the app after first boot.
- **A box with room to run a browser.** Each concurrent run is a real Chromium
  and peaks around 700 MB. 2 vCPU / 4 GB is enough for two at a time; 4 vCPU /
  8 GB is comfortable for four.

Nothing else is a prerequisite. You do not need to clone the repo, install a
toolchain, or run a build.

## 1. Get the two files

```bash
mkdir qassist && cd qassist
curl -O https://raw.githubusercontent.com/rszhd/qassist/main/docker-compose.release.yml
curl -o .env https://raw.githubusercontent.com/rszhd/qassist/main/.env.example
```

The compose file pins an exact published image (`ghcr.io/rszhd/qassist:x.y.z`),
so you always know which version is running. It is standalone: it references no
other file in the repo.

## 2. Generate the one required secret

```bash
sed -i "s/^KEY_ENCRYPTION_SECRET=$/KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)/" .env
```

`KEY_ENCRYPTION_SECRET` encrypts your stored OpenAI key at rest. Generate it
once and keep it — losing it makes every stored key undecryptable.

Everything else in `.env` has a working default. Leave the rest alone for now.

## 3. Start it

```bash
docker compose -f docker-compose.release.yml up -d
```

Two containers come up: the app on port 8080, and a Postgres control plane that
holds saved tests, run history and schedules. The schema creates and migrates
itself at boot — there is no separate migrate step.

Check it is up:

```bash
curl -s http://localhost:8080/api/health
# {"ok":true,"active":0,"queued":0,"max_concurrent":4,"db":true,"auth":false,…}
```

`db: true` means the control plane is connected. If it is `false`, the app is
still starting — give Postgres a few seconds and ask again.

Open <http://localhost:8080>.

## 4. Add your OpenAI key

Open **Settings → OpenAI key** and paste yours. It is stored encrypted, and
every run you start is funded by it.

This is not optional: until a key is stored, starting a run answers
`503 no OpenAI key: add yours in Settings`. The server holds no key of its own,
which is what stops an instance you share from spending your tokens on someone
else's runs.

## 5. Run your first test

In the Run view, enter a URL and a goal in plain English:

- **URL** — `https://example.com`
- **Goal** — `Confirm the page shows the heading "Example Domain"`

Press Run. The browser session streams to the page live while the agent works.
When it finishes you get a verdict, a written rationale, the step list, and the
session recording.

Start with a goal that is easy to judge. A goal that describes an *outcome*
("the cart shows one item") gives the judge something to check; a goal that
describes *clicking* ("click the blue button") does not.

That is the whole loop. Everything below is what you do once it works.

## Before you expose it to anything

A fresh install has **no token**: the API needs no credential, and the server
logs a warning at startup saying so. That is fine on localhost and nowhere else.

Set one in `.env` and restart:

```bash
openssl rand -hex 32   # paste into WORKER_API_TOKEN=
docker compose -f docker-compose.release.yml up -d
```

The UI then asks for the token once and keeps it. Every API and WebSocket call
carries it as `Authorization: Bearer <token>`.

**Put it behind HTTPS.** The release compose publishes 8080 in the clear, which
is a localhost arrangement. To serve a public hostname with automatic Let's
Encrypt certificates, use the Traefik overlay in the repo — the runbook is
[`DEPLOY.md`](../DEPLOY.md), and the details of what the overlay reads are in
[`docs/deploy/production.md`](deploy/production.md). Two things go with it:
set `PUBLIC_BASE_URL` to the `https://` address (it makes the report's
recording link and notification mail resolvable), and set `TRUST_PROXY=1` so
the per-IP guards count the visitor rather than the proxy container.

If more than one person will use the instance, turn on magic-link login
(`AUTH_ENABLED`) instead of sharing a token. It needs a mail sender — see
`.env.example`, which documents the three settings it refuses to boot without.

## Size it for your box

The real throttle is `MAX_CONCURRENT_SESSIONS` (default `4`). Runs over the cap
wait in a FIFO queue and are told their position live.

Rule of thumb: `floor((RAM_GB − 1.5) / 0.7)`, from the ~700 MB a run peaks at
and 1.5 GB kept back for Postgres, Node and the OS. It is a ceiling to size
down from, not a target — the 700 MB was measured on one page with no LLM in
the loop, so the numbers above are the comfortable read of it. The queue is in
memory, not durable — a restart marks everything still waiting as `error`, so
drain before restarting if that matters.

Two more caps are worth knowing about before a run surprises you:
`MAX_STEPS` (default `60`) bounds how many actions one run may take, and
`RUN_TIMEOUT_SECONDS` (default `600`) bounds its wall clock, so a rate-limited
key cannot squat a browser slot. The full list of settings is the
[Configuration table in the README](../README.md#configuration).

## What to back up

Three things, and they have different lifetimes on purpose:

| What | Where | Why |
|---|---|---|
| `.env` | beside the compose file | Holds `KEY_ENCRYPTION_SECRET`. Lose it and every stored key is unreadable. |
| The `pgdata` volume | Docker named volume | Saved tests, suites, schedules, and run verdicts. Kept forever. |
| `./runs` | bind mount | Per-run PDFs and recordings. Deleted after `ARTIFACT_RETENTION_DAYS` (default 7) anyway. |

A pruned run keeps its verdict, timings and step count — it simply stops
offering the report and the recording. So the database is the thing worth a
real backup; `runs/` is a cache with a deadline.

## Upgrading

Edit the image tag in `docker-compose.release.yml`, then:

```bash
docker compose -f docker-compose.release.yml up -d
```

Pending migrations apply themselves at boot. Pin the exact version rather than
floating on `:latest` — a tag that changes under you is not a release.

## Turning on the optional parts

Each of these is off (or defaulted) on a fresh install. Set them in `.env` and
restart.

- **PDF reports** — `REPORTS_ENABLED=1`. Off by default while the renderer is
  being reworked, so `report.pdf` 404s and no download is offered. Step lists
  and diagnostics do not depend on it.
- **Email notifications** — `RESEND_API_KEY` + `MAIL_FROM`, both, or the
  feature is simply off. `NOTIFY_MODE` decides whether you hear about every run
  or only the ones that did not pass.
- **Testing something on a private network** — `QA_BLOCK_PRIVATE_NETWORKS=0`.
  The agent refuses private and loopback addresses by default, because on a
  shared instance "point the tester at a URL" must not become "read the host's
  cloud metadata endpoint". If your whole use case is testing
  `http://localhost:3000`, turn the floor off; it is one switch, and `0`
  clears the hostname denylist with it.
- **Full HAR capture** — `CAPTURE_HAR=1`, or `"har": true` on a single run. The
  curated diagnostics (failed requests, console errors, uncaught exceptions)
  are always on and need no setting.

`curl /api/health` reports which of these the instance actually has:
`reports`, `mail`, `billing`, `db`, `auth_mode`.

## When something goes wrong

- **A run is refused with `503 no OpenAI key`** — no key is stored yet. Settings
  → OpenAI key.
- **The site fails to load from the server but works in your browser** —
  some sites (Reddit, Cloudflare-heavy pages) block datacenter IPs. Expected,
  not a bug. When the site is yours, allowlist the box:
  [`docs/waf-allowlisting.md`](waf-allowlisting.md).
- **Port 8080 is taken** — edit the left side of the `ports` mapping in the
  compose file (`"9090:8080"`). Leave `PORT` alone; it is what the app listens
  on *inside* the container, and changing it breaks the mapping.
- **Chromium crashes on heavy pages** — it needs shared memory. Both compose
  files already set `shm_size: 1gb`; if you wrote your own, add it.
- **Anything else** — `docker compose -f docker-compose.release.yml logs -f
  qassist`. The agent's stdout is relayed into the server log.

## Where to go next

- **[README → Configuration](../README.md#configuration)** — every environment
  variable, with defaults.
- **[docs/api.md](api.md)** — the whole HTTP surface: saved tests, projects and
  modules, suites, schedules, history, recordings.
- **[docs/ci.md](ci.md)** — gating a deploy on a module or a suite. It is
  `curl` plus a poll loop; there is no plugin to install.
- **[docs/auth-in-tested-flows.md](auth-in-tested-flows.md)** — reaching what is
  behind *your app's* login: saved sessions, email codes, social login, and
  what is out of reach.
- **[DEPLOY.md](../DEPLOY.md)** — public hostname, HTTPS, and the runbook per
  stack.
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** — if you want to change it rather
  than run it.
