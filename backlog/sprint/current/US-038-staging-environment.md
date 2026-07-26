# US-038 — A staging environment that rehearses the real deploy

**As the** maintainer, **I want** a staging deployment at `staging.qassist.run` that is the production stack with production's data swapped out, **so that** a release, a migration, a Stripe round trip and a CI snippet can all be proven against something real before the thing real users are on.

- **Status:** 🟢 **Staging is up and serving** (2026-07-25) —
  `https://staging.qassist.run` runs `ghcr.io/rszhd/qassist:0.1.0` behind the
  shared Traefik proxy on its own Let's Encrypt certificate, with its own
  Postgres, its own `runs-staging/` artifacts and a seeded tenant. Five of the
  eight criteria below are met, including the two this story exists to close:
  **US-008's CI snippet now passes for real against staging** (`docs/ci.md`'s
  script, verbatim, exit 0 on a green suite and exit 1 on a mixed one) and a
  failing run **mailed its report through Resend** from staging's own config.

  **Production was deliberately not stood up** (maintainer's call, 2026-07-25),
  so the box currently runs `qassist-proxy` + `qassist-staging` and nothing else.
  Three criteria stay open because of that, not because of staging: the
  cross-stack cookie/API-key refusal, production's half of the `down -v` proof,
  and the Stripe test-mode round trip (staging's `STRIPE_*` are deliberately
  **empty** rather than placeheld — `config.js` reads all three unset as billing
  off, whereas a placeholder key switches billing *on* with a broken secret).

  **Update 2026-07-26 — staging carries Stripe test keys, and the round trip
  found a defect.** `STRIPE_*` are filled in (test key, test price, staging's
  own endpoint secret), `/api/health` reports `billing:true`, and two
  non-operator accounts subscribed through real Checkout with every event
  delivered, verified and applied. The subscribe half of the criterion holds.
  It is still unticked for two reasons, both recorded on the criterion itself:
  every subscription landed with `current_period_end` NULL, which is
  [US-051](US-051-subscription-dates-from-stripe.md) and means the `past_due`
  grace path was never actually exercised; and the Customer Portal schedules a
  cancellation rather than performing one, so `customer.subscription.deleted`
  has not fired and the 402-after-cancel half has not run. Turning billing on
  also closes the registration hole this story recorded below — `requireEntitled`
  now gates every run-start path on staging. Two facts above are stale as of
  this date: the box runs `0.2.0`, not `0.1.0` (US-039), and `qassist-demo` now
  shares it (US-040).
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
| `PUBLIC_BASE_URL` | `https://app.qassist.run` | `https://staging.qassist.run` |
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

## What is on the box (2026-07-25)

Recorded here because nothing about the deployment may live only on the box. The
box had **no QAssist on it at all** before this — no `qassist-edge` network, no
proxy, no `pgdata` volume, no checkout. It shares a 4 vCPU / 8 GB VPS with an
unrelated MySQL stack, which is why staging's cap is 1.

| | |
|---|---|
| Checkout | `~/qassist`, `main` at `eb07990` — the three compose files are byte-identical to `dev`'s, so the tracked branch is a docs detail, not a deploy one |
| Projects up | `qassist-proxy` (Traefik v3.7.9) and `qassist-staging`. **No `qassist` project** |
| Image | `ghcr.io/rszhd/qassist:0.1.0`, pulled anonymously — the box has never built the source |
| Env files | `.env.staging` (complete, 0600) and a `.env` carrying **only** `ACME_EMAIL`, commented as the proxy's file rather than production's |
| Seeded | `seed-staging.mjs` against the operator address: 1 project, 1 module, 4 tests, 1 suite, 1 schedule, 5 finished runs. Idempotent — a second run reported "already owns tests or projects". `demo_expires_at` is null, so the demo reaper cannot sweep it |
| Verification leftovers | `.staging-api-key` (0600, a real `qak_` key labelled "US-038 stand-up verification" — **revocable from Settings**), `~/qassist-run.sh`, two extra tests and two suites named `US-038 …`, and the runs with their artifacts |

**The magic-link path works too**, proven by accident and worth keeping: the
maintainer signed up on staging with a second address (`mharith.dev@…`) while the
stand-up was running, received the login mail, and started a run from the Run
view. So `AUTH_ENABLED=1` + Resend delivers login links from staging's config to
an address that is not the Resend account owner's — the same claim US-012 and
US-007 each owe, evidenced here on a second recipient.

**A consequence to be deliberate about:** signup *is* login, so staging accepts
registrations from anyone who finds the hostname, and with `STRIPE_*` empty
`requireEntitled` gates nothing — a stranger could register and spend the
server's `OPENAI_API_KEY`. `noindex` keeps it out of search results, which is
obscurity, not a control. Tolerable while the hostname is unadvertised and the
cap is 1, and it disappears the moment staging carries Stripe test keys (the
criterion below) because the gate turns on. If staging is ever left up and idle,
the cheap mitigation is `BILLING_EXEMPT_EMAILS` narrowed to the maintainer plus
test keys present, not a second auth layer — "one door, not two" still holds.
**Both halves are now true (2026-07-26):** US-039 removed the server key, and
staging carries test keys, so `requireEntitled` gates every run-start path here.

**Mitigated on the box, same day, and then escalated into its own story.**
Waiting for Stripe test keys was judged the wrong shape — it makes *not being
robbed* contingent on billing being configured, which is never true on a free
self-host. So `OPENAI_API_KEY` was **blanked in `.env.staging`** (backup at
`.env.staging.bak-20260725`, 0600, which still holds the value) and the stack
recreated; `/api/health` now reports `agent_ready:false`, and staging is
BYOK-only — `KEY_ENCRYPTION_SECRET` is set there, so the Settings key field
works and users add their own. The proper fix is
[US-039](done/US-039-byok-only-no-server-key.md), which removes the server key from
the product entirely.

Two side effects of the blanking lived until US-039 landed (2026-07-26), which
removed the server key from the product and with it both symptoms:

- **Staging's scheduler did not start.** `startScheduler()` returned before
  `setInterval` when the server key was unset, so *no* schedule fired —
  including one whose owner had their own key, which the guard predated. US-039
  replaced the boot-time global check with a per-schedule skip: the ticker
  always runs, and a slot whose owner has no stored key is claimed, skipped and
  logged.
- **The Run view showed "Add it to `.env` and restart"** — operator advice
  shown to a registrant who has no `.env`. US-039 rewired the banner onto the
  caller's own key state (`GET /api/account/openai-key`) and it now says to add
  a key in Settings.

Deploying US-039 (`v0.2.0`, 2026-07-26) retired the blanking itself: the old
key was deliberately restored into the container env and staging still refused
a keyless run with the Settings message — the story's own acceptance test for
the fallback being gone, observed on this box. The variable is blank again
only for tidiness; it is inert either way.

`MAX_CONCURRENT_SESSIONS=1`, and after two concurrent-ish suites the box still
had ~6.4 GB available and 53 GB free — staging is not what will run it out.

## What the stand-up turned up (2026-07-25)

Two more failures of the same family as the `--env-file` trap above — both were
in the shipped repo, and neither could have been caught without a real box.

**1. `docker-compose.proxy.yml` pinned `traefik:v3.3`, which cannot talk to
Docker Engine 29.** Traefik pinned Docker API version 1.24 until v3.7; Engine 29
refuses anything below 1.40. The provider never initialised, so there were no
routers and no ACME — and because entrypoint redirects are *static* config, the
HTTP→HTTPS redirect kept working while HTTPS served `TRAEFIK DEFAULT CERT`. That
reads as a DNS or Let's Encrypt problem and is neither. Pinned to `v3.7` (running
v3.7.9), with the symptom written into `DEPLOY.md` next to the ACME note, because
the log line (`client version 1.24 is too old`) is the only thing that says so.

**2. `DEPLOY.md`'s own stand-up command rebuilt the trap this story documents.**
It read `ENV_FILE=.env.staging docker compose … --env-file "$ENV_FILE"`. A
command *prefix* assignment lands in the environment of the command being run,
but the shell expands that command's own arguments first — while `ENV_FILE` is
still unset. So `--env-file` gets an empty string, interpolation falls back to
`.env`, and you get a stack named `qassist-staging` wearing **production's**
hostname and secrets: precisely the silent failure the trap section warns about,
rebuilt out of shell semantics instead of compose ones. Now `export ENV_FILE=…`
on its own line, in both the stand-up and the promotion snippets. It surfaced
only because the stand-up ran under `set -eu`, which turned a silent
production-config boot into `ENV_FILE: unbound variable` — so `DEPLOY.md` now
recommends `set -u` for the stand-up.

The seed command had a milder version of the same thing: naming the compose files
means they get interpolated, so `exec` needs `--env-file` too, or `APP_HOST:?`
aborts on a box where production is not up.

## Acceptance criteria

- [x] `https://staging.qassist.run` serves the UI over its own certificate, and
      the API + WebSocket live view work through it — Let's Encrypt cert issued
      (`CN = staging.qassist.run`, expires 2026-10-23), `http` 308s to `https`,
      `/api/health` OK, `/api/runs` 401 unauthed and 200 with a per-user key, JS
      and CSS bundles 200, and react-router paths (`/history`, `/runs/<id>`) fall
      back to `index.html`. The WebSocket was the part to distrust: a run started
      through the public API upgraded in **28 ms** through Traefik and streamed
      `status`/`start`/`frame`/`step`/`recording`/`done`. Report PDF and `.mp4`
      recording both serve over TLS
- [x] Staging and production run from the **same** compose files — the only
      difference is `-p`, `--env-file`, and the image tag. Verified by rendering
      `docker compose config` both ways: distinct routers, networks, `pgdata`
      volumes and artifact directories, no published ports, no build context,
      and no production value reaching the staging container. Re-confirmed on the
      box: `printenv PUBLIC_BASE_URL` inside the running container returns
      staging's, and `ss -tlnp` finds nothing on 8080 or 5433 — only 22, 80, 443
- [ ] `docker compose -p qassist-staging down -v` destroys staging's database
      and leaves production's untouched (proves the volumes are separate).
      **Half-proven, and by a better test:** a *third* stack from the same two
      files (`-p qassist-scratch`) got its own `qassist-scratch_pgdata`, and
      `down -v` on it removed only that volume — `qassist-staging_pgdata`
      survived with all its rows and staging never stopped serving. That is the
      project-scoping this criterion is really about, and it cost no wipe. The
      production half needs production
- [ ] A staging session cookie and a staging API key are both refused by
      production, and vice versa — **needs production.** What holds so far: the
      four signing secrets are distinct values (generated separately on the box),
      the two stacks have separate databases, and API keys are rows in one of
      them. Staging also refuses the legacy shared `WORKER_API_TOKEN` with 401,
      which is `userFromCredentials` deliberately not consulting it in multi-user
      mode
- [x] A run on staging that fails mails its report from staging's config, and no
      production recipient receives it — two failing runs each produced one
      `notifications` row, `status=sent`, no error, to the maintainer-only
      address, from staging's `MAIL_FROM` with the PDF attached. One mail per
      (run, recipient), so the idempotency guard holds. No production recipient
      exists to receive it, and none is configured on staging
- [ ] A **Stripe test-mode** subscription completes end-to-end on staging:
      Checkout → webhook → entitlement, closing US-022's outstanding round trip
      without touching live keys — and production's webhook endpoint never sees
      the test event. **Mostly done (2026-07-26), deliberately not ticked.** The
      subscribe path is proven: two Checkouts by two **non-operator** addresses
      (`BILLING_EXEMPT_EMAILS` defaults to `OPERATOR_EMAIL`, so the operator
      account would have bypassed the gate and proven nothing), six events
      delivered, verified, applied and ledgered, both users entitled, and the
      live endpoint never involved. Two things keep it open: the round trip
      wrote `current_period_end` NULL, so "entitlement" was only proven for the
      `active` path and not for the `past_due` grace behind it
      ([US-051](US-051-subscription-dates-from-stripe.md)); and cancellation is
      unproven, because the Customer Portal *schedules* rather than cancels — no
      `customer.subscription.deleted` has been generated, so the 402-after-cancel
      half has never run. Needs US-051, an immediate cancel, and a re-run
- [x] US-008's CI snippet is run for real against staging (not production) and
      the story's criterion is satisfied there — `docs/ci.md`'s `qassist-run.sh`
      extracted **verbatim** from the doc (not retyped) and run against two
      suites: a green one exited **0**, a mixed one exited **1** and printed the
      failing run's permalink. It batched two runs from one `POST
      /api/suites/<id>/run`, polled `/api/runs/<id>`, and the second run queued
      behind the first at `MAX_CONCURRENT_SESSIONS=1`
- [x] `DEPLOY.md` documents standing staging up, promoting a tag from staging to
      production, and the config table above; nothing about staging lives only
      on the box
