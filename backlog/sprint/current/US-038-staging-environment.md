# US-038 — A staging environment that rehearses the real deploy

**As the** maintainer, **I want** a staging deployment at `staging.qassist.run` that is the production stack with production's data swapped out, **so that** a release, a migration, a Stripe round trip and a CI snippet can all be proven against something real before the thing real users are on.

- **Status:** 🧱 Repo side shipped (2026-07-25) — `.env.staging.example`, the
  `DEPLOY.md` staging + promotion sections, the `noindex` middleware and
  `server/scripts/seed-staging.mjs`. The overlay needed no staging branch, as
  planned. What is left is the box: the DNS record, standing the stack up, and
  the criteria below that only a running staging environment can meet.
- **Priority:** P1 (current sprint, added 2026-07-25) — it blocks nothing by
  itself, but it is where three other stories in this sprint finish: each of
  US-022, US-008 and US-032 currently has "verify against production" as its
  last step, and that is the step this replaces
- **Estimate:** ~2–3 h once [US-007](US-007-https-reverse-proxy.md)
  is up (it is that story's compose overlay parameterized, not a second one)
- **Depends on:** US-007 (the Traefik prod overlay and the DNS panel this reuses).
  Pairs with [US-032](US-032-release-pipeline-and-image.md) — a
  published image is what staging should run, so a promotion is a tag change.

## Why now, and why it isn't just "test on prod"

Three shipped or in-flight stories end with an item no test in this repo can
close, and all three of them currently point at production:

- [US-022](done/US-022-stripe-billing.md) owes a live
  round trip — a real card through Checkout and a real webhook back. Doing that
  on production means either charging a real card or flipping the live instance
  to Stripe **test** keys, which is a config change on the box people are using.
- [US-008](US-008-cicd-integration.md)'s documented pipeline
  step is unverified, and verifying it means a CI job firing real runs against a
  real API — on prod that competes for `MAX_CONCURRENT_SESSIONS` with whoever
  else is there.
- US-032's image is meant to be promoted, not hoped at: `docker compose -f
  docker-compose.release.yml up` on a machine that has never seen the source is
  an acceptance criterion, and staging is that machine on every tag rather than
  once.

Add to that the thing no story owns: **migrations**. `db/migrations/*.sql` are
applied at boot against whatever schema is there. The first migration that is
fine on an empty dev DB and wrong on a populated one will be discovered on
production unless a populated non-production DB exists first.

## Approach: a second compose project on the same VPS (decided 2026-07-25)

Staging is **the same box, a second isolated stack**, not a second server:

- **Same overlay, different env.** `docker-compose.prod.yml` gains no staging
  branch. Staging is `docker compose -p qassist-staging -f docker-compose.yml -f
  docker-compose.prod.yml --env-file .env.staging up -d`. The `-p` project name
  is what gives it its own network, its own `db` container and its own `pgdata`
  volume; the hostname in the Traefik router label comes from the env file. If
  the overlay needs an `if staging` anywhere, that is a sign the overlay is
  wrong, not that staging is special.
- **Traefik is shared.** One proxy, one ACME cert store, two routers — a second
  certificate for `staging.qassist.run` costs a DNS A record and a label.
- **Separate database and separate artifacts.** Staging's `pgdata` volume and
  its `runs/` bind mount are its own. Nothing in staging may reach production's
  Postgres, and nothing in production may be pointed at staging's.
- **Not a load-testing environment.** Sharing the box means staging borrows
  RAM from production, so its `MAX_CONCURRENT_SESSIONS` is small (1–2). The
  purpose is *fidelity of the deploy*, not capacity. If we ever need to prove
  throughput, that is a different, temporary box and a different story
  ([US-015](../../unscheduled/US-015-horizontal-scaling-100-concurrent.md) territory).

**The alternative considered:** a second VPS. It buys true isolation — a
staging Chromium storm cannot touch production's memory — for a second monthly
bill and a second machine to patch. Not worth it while production is one box
serving a handful of users; revisit the day staging's noise is what takes
production down, which is a measurable event and not a guess.

## The config that must differ

Staging is production's `.env` with the values that reach the outside world
replaced. Getting one of these wrong is how a staging environment mails real
users or charges real cards, so the runbook lists them explicitly:

| Setting | Production | Staging |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://qassist.run` | `https://staging.qassist.run` |
| `STRIPE_*` | live keys, live price, live webhook secret | **test-mode** keys, test price, that endpoint's own signing secret |
| `NOTIFY_EMAILS` / `OPERATOR_EMAIL` | real recipients | a maintainer-only address; no project on staging may carry a stranger's address |
| `SESSION_SECRET`, `NOTIFY_SECRET`, `KEY_ENCRYPTION_SECRET`, `WORKER_API_TOKEN` | production's | **distinct values** — a staging session or API key must never authenticate against production |
| `MAX_CONCURRENT_SESSIONS` | the box's real cap | 1–2 (staging borrows RAM from prod) |
| `DEMO_*` / `AUTH_MODE` | unset (magic-link app) | unset — the demo sandbox is its own deployment concern, not staging's |
| image | the pinned `:x.y.z` tag | the tag being promoted (or `:latest`) |

`MAIL_DEV_CONSOLE` is deliberately **not** the answer for staging mail: the
point of staging is to prove the Resend path works, and console-logging it
proves nothing. Real sends, maintainer-only recipients.

## Details

- `.env.staging.example` in the repo beside `.env.example`, carrying the table
  above as its comments — the diff, not a second full copy of every setting.
- `DEPLOY.md` (US-007's runbook) gains a **Staging** section: the `-p` command,
  the DNS record, and the promotion step (staging green ⇒ retag prod ⇒ same
  command without `-p`).
- Staging is **not** indexed and **not** advertised: a Traefik `noindex` header
  middleware on that router. It is behind the same token/auth as production, so
  no extra basic-auth layer — one door, not two.
- A seeded staging tenant with a handful of saved tests and projects, so the
  environment is populated enough for a migration to be tested against
  something. Cheap version: run the demo fixtures' seed once against staging.
  **Shipped as `server/scripts/seed-staging.mjs`**, which exports and reuses
  US-036's `seedTenant()` rather than growing a second dataset — same project,
  module, four tests, suite, schedule and five finished runs, minus the TTL. The
  tenant's `demo_expires_at` stays null and the reaper only selects rows where
  it `is not null`, so nothing sweeps it. The email is a required argument
  rather than defaulting to `OPERATOR_EMAIL` (a default is what would let a
  mistyped `-p` seed production's operator), and it refuses an account that
  already owns anything, so re-running is a no-op.

**The trap this story turned up (2026-07-25):** `--env-file` feeds *compose-file
interpolation only*. It does not change what the base file's `env_file:`
directive loads into the container, which is `.env` by name — so the first
render of a `--env-file .env.staging` stack took its hostname from staging and
its `SESSION_SECRET`, Stripe keys and mail recipients from **production**. That
is three of the criteria below failing silently, in the exact shape this story
exists to prevent. The prod overlay now overrides `env_file` to
`${ENV_FILE:-.env}`, named once in a shell variable and passed to both, and
`DEPLOY.md` makes `printenv PUBLIC_BASE_URL` in the running container a
stand-up step.

## Acceptance criteria

- [ ] `https://staging.qassist.run` serves the UI over its own certificate, and
      the API + WebSocket live view work through it
- [x] Staging and production run from the **same** compose files — the only
      difference is `-p`, `--env-file`, and the image tag. Verified by rendering
      `docker compose config` both ways: distinct routers, networks, `pgdata`
      volumes and artifact directories, no published ports, no build context,
      and no production value reaching the staging container
- [ ] `docker compose -p qassist-staging down -v` destroys staging's database
      and leaves production's untouched (proves the volumes are separate)
- [ ] A staging session cookie and a staging API key are both refused by
      production, and vice versa
- [ ] A run on staging that fails mails its report from staging's config, and no
      production recipient receives it
- [ ] A **Stripe test-mode** subscription completes end-to-end on staging:
      Checkout → webhook → entitlement, closing US-022's outstanding round trip
      without touching live keys — and production's webhook endpoint never sees
      the test event
- [ ] US-008's CI snippet is run for real against staging (not production) and
      the story's criterion is satisfied there
- [x] `DEPLOY.md` documents standing staging up, promoting a tag from staging to
      production, and the config table above; nothing about staging lives only
      on the box
