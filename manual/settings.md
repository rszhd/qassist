# Settings

The settings a self-hosted instance turns, with defaults. These go in `.env`
beside the compose file; a restart applies them.

**This page is for someone running their own instance.** On a hosted account
none of it is yours to set — the things you configure there are per project and
per test, and they are covered by the pages this one links to.

## The two that matter most

| | |
|---|---|
| **`KEY_ENCRYPTION_SECRET`** | **Required.** Encrypts stored OpenAI keys, [secret variables](./variables.md), and [saved sessions](./saved-sessions.md) at rest. Generate once (`openssl rand -hex 32`) and keep it — losing it makes all of them undecryptable. |
| **`MAX_CONCURRENT_SESSIONS`** (`4`) | The real throttle. Runs over the cap queue and are told their position. [How to size it](./self-hosting.md#sizing-it-for-your-box). |

There is deliberately **no server-wide OpenAI key setting**. Every run is funded
by the key its caller stored, so a shared instance can never spend the
operator's tokens on someone else's runs.

## Access

| Setting | Default | |
|---|---|---|
| `WORKER_API_TOKEN` | — | Bearer token required on every API and WebSocket call. Blank = no token required, which is fine on localhost and nowhere else. |
| `AUTH_ENABLED` | — | Magic-link sign-in instead of a shared token. Refuses to start without the control plane, a mail sender and `SESSION_SECRET`. With it on, `WORKER_API_TOKEN` stops working and each user makes their own API keys. |
| `SESSION_SECRET` | — | Signs session cookies. No default on purpose: a blank one signs everyone out on restart, a shared one forges sessions across instances. |
| `OPERATOR_EMAIL` | `operator@qassist.local` | Seeds the first account, and is the last-resort notification recipient. The default is not a deliverable address. |
| `TRUST_PROXY` | — | How many proxies sit in front of the app, which decides whose address the per-IP guards count. Set it to `1` behind the Traefik overlay; leave it unset when publishing 8080 directly, where believing `X-Forwarded-For` would let any caller claim any address. |

## Limits on a run

| Setting | Default | |
|---|---|---|
| `MAX_STEPS` | `60` | Ceiling on agent steps per run. |
| `RUN_TIMEOUT_SECONDS` | `600` | Wall-clock ceiling. `MAX_STEPS` bounds steps, not time — this is what stops a rate-limited key squatting a browser slot. |
| `MAX_RUN_MEMORY_MB` | `1000` | Per-run memory ceiling over the run's whole process tree; over it the run is killed and reported failed. A recording run peaks around 700 MB, which is where the sizing rule comes from. |
| `STOP_GRACE_SECONDS` | `10` | How long a stopped run has to end itself — finalizing its recording and report — before the process tree is killed anyway. |
| `MAX_CONCURRENT_PER_USER` | — | Per-user fair-use cap on a **shared** instance, so one person cannot hold every slot. Over it a run is refused rather than queued. Unset = off, one global queue. |

## Where a run may navigate

Covered in full by [Where a run may go](./navigation-fence.md).

| Setting | Default | |
|---|---|---|
| `QA_BLOCK_PRIVATE_NETWORKS` | on | Refuses IP literals in every spelling, and private and loopback addresses. Set `0` if your whole use case is testing your own machine — it clears the denylist below with it, so you are not left unable to reach localhost after setting the flag that says you may. |
| `QA_DENIED_HOSTS` | `localhost,db,metadata.google.internal,metadata.goog,metadata` | Hostnames refused by name. Not redundant with the flag: the IP block stops address *literals*, so it does not stop `http://localhost:8080` or `http://db:5432`. Setting this replaces the default list entirely. |

Per-project confinement is not a setting here — it is
[`allowed_domains` on the project](./navigation-fence.md#a-project-allowlist).

## Artifacts

| Setting | Default | |
|---|---|---|
| `QA_RECORD` | `1` | Record every session to mp4. `0` turns it off and skips frame capture entirely while nobody is watching. |
| `REPORTS_ENABLED` | off | Render a PDF for every finished run. Off while the renderer is being reworked: no download is offered and mail carries no attachment. Step lists and diagnostics are unaffected. |
| `CAPTURE_HAR` | off | Write a full HAR for every run. Large, and [the one artifact redaction does not reach](./reading-a-verdict.md#when-the-summary-is-not-enough). A caller can also ask per run. |
| `ARTIFACT_RETENTION_DAYS` | `7` | How long `runs/<id>/` is kept, including recordings, reports, screenshots, detailed Activity, and HAR files. The History row remains. `0` = never sweep. |
| `FIXTURE_MAX_BYTES` | 10 MB | Per-[file](./files.md) cap. |
| `FIXTURE_PROJECT_QUOTA_BYTES` | 50 MB | Per-project total. |

## Email

Covered by [Email notifications](./notifications.md).

| Setting | Default | |
|---|---|---|
| `RESEND_API_KEY` | — | Both this and `MAIL_FROM` must be set or the feature is off: preferences still save, nothing sends. |
| `MAIL_FROM` | — | Sender address, on a domain verified with Resend. |
| `NOTIFY_EMAILS` | — | Comma-separated fallback recipients, used when a project names none. |
| `NOTIFY_MODE` | `failure` | Default for tests in no project. `failure` covers failed, errored and unjudged runs, but not runs stopped by hand. Projects carry their own mode. |
| `NOTIFY_SECRET` | `WORKER_API_TOKEN` | Signs unsubscribe links. Falls back to a per-boot random value if the token is blank too, which invalidates links already mailed. |

## The rest

| Setting | Default | |
|---|---|---|
| `PORT` | `8080` | What the app listens on **inside** the container. Change the compose port mapping instead. |
| `PUBLIC_BASE_URL` | — | Where this instance is reachable from outside. Makes the report's recording link and the mail's run link resolvable, and with auth on it is what sign-in links redirect to and what makes the session cookie secure — so on a real deployment it must be the `https://` URL. |
| `BROWSER_USE_MODEL` | `gpt-4.1` | The OpenAI model runs use. |
| `RUN_TTL_SECONDS` | `3600` | How long a finished run stays in the worker's live in-memory registry after it ends. The durable history row and its artifacts are unaffected. |
| `SESSION_MAX_BYTES` | 1 MB | Cap on a pasted [saved session](./saved-sessions.md) blob; a bigger one is refused with the limit in the message. |
| `DATABASE_URL` | — | **Required** — the Postgres control plane. Set for you by both shipped compose paths. Without it the server refuses to boot. |

## Billing, if you are running a paid instance

**All three `STRIPE_*` values blank is billing entirely off — no billing UI, no
gating, every run free.** That is the self-host default, and the switch is the
absence of configuration rather than a flag. Setting them also needs
`PUBLIC_BASE_URL`, the control plane and `AUTH_ENABLED`; missing any one leaves
the instance free.

Turning it on gates **starting a run** and nothing else. Reading stays open, so
cancelling is never a data-loss event. Model tokens stay bring-your-own on every
tier: a subscription pays for hosting, not for the model.

| Setting | |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | One recurring price, taken through Stripe Checkout, with changes and cancellation handled by the Stripe Customer Portal. |
| `BILLING_EXEMPT_EMAILS` | Accounts that run without subscribing. Defaults to `OPERATOR_EMAIL`. |
| `ACTIVATION_SLA_HOURS` | Hours a paid account waits while you add the capacity it just bought. Unset or `0` = off, and off is the default. Turning it off later releases everyone waiting. |

## Settings this page does not cover

Values read only by the reverse-proxy overlay — `APP_HOST`, `ACME_EMAIL`,
`QASSIST_IMAGE`, `RUNS_DIR`, `ROBOTS_TAG` — belong to the deployment rather than
to the app, and a plain `docker compose up` ignores them entirely. They are in
[`DEPLOY.md`](https://github.com/rszhd/qassist/blob/main/DEPLOY.md).

The demo sandbox's settings (`AUTH_MODE=demo` and friends) are for running a
public try-it deployment, and path or developer overrides (`PYTHON_BIN`,
`FIXTURES_DIR`, `MAIL_DEV_CONSOLE` and kin) are for working on the code. Both
are documented in
[`.env.example`](https://github.com/rszhd/qassist/blob/main/.env.example) itself,
which carries the reasoning for every value on this page.
