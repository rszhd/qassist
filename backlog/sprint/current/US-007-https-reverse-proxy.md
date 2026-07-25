# US-007 — Public HTTPS via reverse proxy

**As a** user or CI pipeline, **I want** to reach the QAssist UI/API over HTTPS without an SSH tunnel, **so that** the service is usable from anywhere and integrations become possible.

- **Status:** 🧱 Repo side shipped, **DNS + mail done** (2026-07-25) —
  `docker-compose.prod.yml`, `docker-compose.proxy.yml` and `DEPLOY.md` are in
  and validated by rendering `docker compose config`. `app.qassist.run` and
  `staging.qassist.run` both resolve to the VPS, and qassist.run is **verified
  in Resend** (DKIM on `resend._domainkey`, SPF and the bounce MX on `send`), so
  mail is no longer limited to the account owner's own address. What is left is
  standing the stack up: the certificate, and the criteria below that only a
  running deployment can meet. DMARC (`_dmarc`) is not set — optional, worth
  adding at `p=none` once mail is flowing.
- **Priority:** P1 (current sprint) — hard dependency of US-008 tier 1 (CI must reach the API); unblocks any external users
- **Estimate:** ~2 h (plus domain/DNS)
- **Depends on:** app domain is **qassist.run** (decided 2026-07-22), and the app
  serves from **`app.qassist.run`**, not the apex (decided 2026-07-25) — the apex
  is a landing page built and served outside this repo, so `app.` and `staging.`
  are the only records pointing at the VPS. `arang.space` stays dedicated to
  US-013's catch-all test mail via Cloudflare Email Routing

## Approach: Traefik in compose, not host-installed Caddy (decided 2026-07-24)

The proxy is **Traefik running as a compose service**, not Caddy on the host.
Both auto-provision Let's Encrypt certs; Traefik wins here because it serves the
real goal — **an immutable server with the whole deployment described in the
repo**:

- **Routing lives on the service, in the repo.** Traefik reads Docker labels off
  the `qassist` service, so the domain, TLS and WS routing are `labels:` in
  compose — no separate proxy config file on the box to drift from the repo.
- **`app` stops publishing 8080 to the host.** Traefik reaches it over the
  compose network; only 443 (and 80, for the ACME/HTTP→HTTPS redirect) is
  exposed. That satisfies "8080 unreachable externally" by construction rather
  than by firewalling a published port.
- **The VPS holds almost no state.** Install Docker, drop `.env`, `docker compose
  -f docker-compose.yml -f docker-compose.prod.yml up -d`. Only durable bits are
  the ACME cert store (a named volume) and `.env`. Ansible (a later pass, see
  below) does just those steps.
- **WebSocket** (`/ws`) upgrades automatically once the service is labeled — no
  special config, but it is the one thing to actually verify after standing it
  up.
- Token auth stays mandatory (`WORKER_API_TOKEN` on every API/WS call) — HTTPS
  is transport, not auth.
- Consider Traefik's rate-limit middleware on `/api/runs`.

### Compose layout (decided 2026-07-24)

**Separate prod compose file.** `docker-compose.yml` stays as-is — dev/self-host,
publishes 8080, no proxy — so self-hosters are unaffected and `docker compose up`
still just works. A new `docker-compose.prod.yml` adds the Traefik service, the
TLS/router labels on `qassist`, and drops the host 8080 publish. Deploy is
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.

**Revised on implementation (2026-07-25): Traefik is its own compose project**
(`docker-compose.proxy.yml`), not a service inside the prod overlay. US-038 puts
a second stack on the same box behind the same proxy, and a proxy that belongs
to the production project would mean `down` on production takes staging's TLS
with it — and a second project defining the same service would race to bind
:443. As its own project it is shared infrastructure: the two app stacks meet it
on the external `qassist-edge` network, and because Traefik discovers backends
through the Docker socket, a new stack needs no change to the proxy at all.

The overlay itself is **parameterized rather than duplicated**, which is what
lets US-038 be `-p` + `--env-file` and nothing else. Three things were found by
rendering `docker compose config` rather than by reading the docs, and each
would have been a silent failure on the box:

- Compose merges list fields by **appending**, so omitting `ports` in the
  overlay keeps the base file's `8080` and `5433` published. `!override []` is
  what actually drops them — and 5433 is what two stacks would collide on.
- Compose interpolates label **values but not label keys**, so
  `${COMPOSE_PROJECT_NAME}` in the `key: value` map form renders literal. The
  labels are written in list form (`- key=value`) so each stack's router is
  named after its project and staging's cannot collide with production's.
- `--env-file` feeds **interpolation only** — it does not change which file the
  base file's `env_file:` loads into the container. Left alone, a stack started
  with `--env-file .env.staging` takes its hostname from staging and its
  `SESSION_SECRET`, Stripe keys and mail recipients from production. The overlay
  overrides `env_file` to `${ENV_FILE:-.env}`.

### Scope of this story vs later

This story is **compose + config only**: the Traefik service, TLS/labels,
confirming `PUBLIC_BASE_URL` is honoured (already wired in `config.js`,
`runs.js`, `notify.js`), and a `DEPLOY.md` runbook. The **Ansible playbook**
(install Docker, sync repo/`.env`, compose up) is a later pass, not this ticket.

Current workaround being replaced: `ssh -L 8090:localhost:8080 qagent-vps`.

## The DNS trip also finishes US-012 (added 2026-07-23)

[US-012](done/US-012-email-reports.md) shipped with one thing outstanding: no
mail has ever gone through Resend, because Resend only delivers to the account
owner's own address until the sender domain is verified — and verifying it
means adding SPF/DKIM records to qassist.run, which is the same DNS panel this
story is already in for the A record. (Those records sit on the apex even though
the app does not — mail sends as `…@qassist.run` regardless of the hostname the
stack answers on.) So the proof lands here rather than re-opening a finished
story: the story stays in `done/`, and the criteria below carry the send.

`PUBLIC_BASE_URL` needs setting to `https://app.qassist.run` in the same pass — it
is what puts a working recording link in the PDF and a working run link
([US-030](done/US-030-run-permalink.md)) in the mail, and until this story
there was no URL to give it.

## Acceptance criteria

- [ ] `https://app.qassist.run` serves the UI; API + WebSocket live view work through it
- [ ] Port 8080 is not published to the host (Traefik reaches `qassist` over the
      compose network); only 443 + 80 are exposed
- [ ] Unauthenticated requests still get 401
- [ ] Certificate auto-renews (Traefik ACME resolver; cert store on a named volume)
- [x] The prod overlay (`docker-compose.prod.yml`) and a `DEPLOY.md` runbook are
      in the repo; nothing about the deployment lives only on the box
- [ ] qassist.run is verified in Resend (SPF + DKIM), and a real failing run
      mails its report to an address that is **not** the Resend account owner's
- [ ] `PUBLIC_BASE_URL` is set, and the run link in that mail opens the run
