# QAssist HTTP API

Everything the UI does, QAssist does over this API — starting runs, saving
tests, grouping and scheduling them, reading history, and (where it is turned
on) billing. The README shows the handful of calls that get you a first run;
this is the whole surface.

**Every call carries the bearer token**, `Authorization: Bearer
$WORKER_API_TOKEN`, with two deliberate exceptions noted where they appear: the
recording endpoint also accepts `?token=`, and the unsubscribe link takes no
token at all. Leaving `WORKER_API_TOKEN` unset disables the check entirely,
which is fine on localhost and nowhere else.

Anything backed by the control plane answers `503` without `DATABASE_URL`.
Ad-hoc runs keep working without it.

## Runs

```bash
# start a run
curl -X POST http://<host>:8080/api/runs \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"Search for a laptop and add the first result to cart","start_url":"https://example.com"}'
# -> {"runId":"...","status":"running"}

# poll status + result (the history row's columns, plus runId/result/status
# for polling; the run's own page is http://<host>:8080/runs/<runId>)
curl http://<host>:8080/api/runs/<runId> -H "Authorization: Bearer $WORKER_API_TOKEN"

# download the PDF report (202 while generating, 200 when ready)
curl -L http://<host>:8080/api/runs/<runId>/report.pdf \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o report.pdf

# download the session recording (mp4; 404 if the run wasn't recorded).
# Supports range requests, and — alone among the endpoints — ?token=<token>
# instead of the header, so a <video> element can stream it directly.
curl -L http://<host>:8080/api/runs/<runId>/recording \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o recording.mp4

# health
curl http://<host>:8080/api/health

# live feed: ws://<host>:8080/ws?runId=<runId>&token=<WORKER_API_TOKEN>
```

## Saved tests, projects and modules

A saved test is the reusable unit. Grouping is optional: a test can sit in a
**project**, and within it in at most one **module** (`auth`, `payment`, …).
A **suite** is the cross-cutting alternative — an arbitrary many-to-many
selection inside one project, so the same test can be in `smoke` and
`nightly`. Projects, modules and suites are all runnable in one call.

```bash
# save a test, then run it (start_url is overridable per run — point CI at a
# fresh preview deploy without editing the test)
curl -X POST http://<host>:8080/api/tests \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"login smoke","goal":"log in and see the dashboard","start_url":"https://example.com"}'
curl -X POST http://<host>:8080/api/tests/<testId>/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"start_url":"https://preview.example.com","trigger":"ci"}'

# organize: a project, a module in it, then file the test under the module
# (project_id is derived from the module — you never set both)
curl -X POST http://<host>:8080/api/projects \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Checkout"}'          # -> {"id":"...","slug":"checkout",...}
curl -X POST http://<host>:8080/api/projects/checkout/modules \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Auth"}'              # -> {"id":"...","slug":"auth",...}
curl -X PUT http://<host>:8080/api/tests/<testId> \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"module_id":"<moduleId>"}'

# run a whole module or project. Paths take a slug or a uuid, so CI configs
# don't have to carry ids; one run is started per member test.
curl -X POST http://<host>:8080/api/projects/checkout/modules/auth/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"trigger":"ci"}'
# -> {"moduleId":"...","runs":[{"runId":"...","testId":"...","status":"queued"}, ...]}

# list/filter: ?project_id=<id>, ?module_id=<id>, or project_id=none (Ungrouped)
curl "http://<host>:8080/api/tests?project_id=<projectId>" \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

Suites work the same way but belong to a project, and their members must too:

```bash
curl -X POST http://<host>:8080/api/suites \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"smoke","project_id":"<projectId>","test_ids":["<id>","<id>"]}'
curl -X POST http://<host>:8080/api/suites/<suiteId>/run \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

Deleting a module or project never deletes tests — they fall back to
Ungrouped. Deleting a project does take its suites with it.

## Schedules

`POST /api/schedules` runs any of those four things on a repeating slot. The
schedule names exactly one target — `test_id`, `module_id`, `suite_id` or
`project_id` — and fires the same way the matching `/run` endpoint does: one
run per member test, queued behind `MAX_CONCURRENT_SESSIONS` like any other.

```bash
# every 6 hours: slots are anchored to local midnight, so this fires at
# 00:15 / 06:15 / 12:15 / 18:15 in the schedule's own timezone
curl -X POST http://<host>:8080/api/schedules \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"suite_id":"<suiteId>","kind":"hourly","interval_hours":6,"minute":15,
       "tz":"Europe/Berlin"}'
# -> {"id":"...","kind":"hourly","interval_hours":6,"enabled":true,
#     "next_run_at":"2026-07-23T04:15:00.000Z", ...}

# nightly, and weekly on a Tuesday
-d '{"test_id":"<testId>","kind":"daily","hour":2,"minute":30,"tz":"Europe/Berlin"}'
-d '{"project_id":"<id>","kind":"weekly","weekday":2,"hour":9,"tz":"Europe/Berlin"}'

# list (filter by any target column), pause, re-time, remove
curl "http://<host>:8080/api/schedules?suite_id=<suiteId>" -H "Authorization: Bearer $WORKER_API_TOKEN"
curl -X PUT http://<host>:8080/api/schedules/<id> -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"enabled":false}'
curl -X DELETE http://<host>:8080/api/schedules/<id> -H "Authorization: Bearer $WORKER_API_TOKEN"
```

`kind` is `hourly` (with `interval_hours` ∈ 1, 2, 3, 4, 6, 8, 12), `daily`
(`hour`/`minute`) or `weekly` (plus `weekday`, 0 = Sunday). `tz` is an IANA
name and defaults to the server's; times mean wall-clock time there, so a
daily slot keeps its hour across a DST change. Every write recomputes
`next_run_at`, which is what the scheduler claims each minute.

A slot fires once even if the server was down for several — missed slots are
not replayed. A test with a run still `queued` or `running` is skipped for
that slot while its siblings in the same suite go ahead. Deleting the target
deletes its schedules.

## From CI/CD

A pipeline triggers a **module or a suite** — the set of tests that covers a
change — passing the fresh preview URL as `start_url`, then polls each run and
fails the job unless every one comes back `passed`. That's `curl` plus a poll
loop, no Action and no plugin: **[ci.md](ci.md)** has the script and
ready-made GitHub Actions and GitLab CI jobs.

## Run history

`GET /api/runs` lists finished and in-flight runs newest first. Every row
carries the test's name and grouping, so a history table renders from one
request.

```bash
# filters combine: test_id, project_id, module_id, status (comma-separated),
# since/until (ISO timestamps on created_at), limit (≤200) and offset
curl "http://<host>:8080/api/runs?test_id=<testId>&status=failed,error&limit=20" \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"runs":[{"id":"...","status":"failed","test_name":"login smoke",
#              "success":false,"created_at":"...","has_recording":true, ...}],
#     "total":37,"limit":20,"offset":0}
```

`total` is the unpaginated count, for paging. A run's project is its test's,
reached by join — so a run whose test was later deleted keeps its history row
(goal and start_url were copied at enqueue time) but matches no project
filter. Once retention prunes `runs/<id>/`, `artifacts_deleted_at` is set and
the row reports no recording or report while the verdict survives.

## Confining where a run may navigate

Every run is fenced twice (US-042): the `start_url` is judged before a row is
written, and the same policy arms the browser so a **redirect** into a blocked
host is stopped mid-run. Instance-wide settings are `QA_BLOCK_PRIVATE_NETWORKS`
and `QA_DENIED_HOSTS` (`.env.example`); per project, an allowlist:

```bash
# this project's tests may only visit our staging host and nothing else.
# `*.x` matches the apex as well as its subdomains. [] removes the allowlist.
curl -X PUT http://<host>:8080/api/projects/checkout \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"allowed_domains":["*.staging.example.com"]}'
```

A refused `start_url` answers **400** with a machine-readable `reason` —
`blocked_ip_address`, `blocked_host`, `not_in_allowed_domains`,
`unsupported_scheme` or `invalid_url` — so CI can branch without parsing prose:

```json
{ "error": "navigation to 169.254.169.254 is blocked: this instance does not visit IP addresses. Set QA_BLOCK_PRIVATE_NETWORKS=0 to allow it.",
  "reason": "blocked_ip_address" }
```

On the **batch** routes (suite, project, module) a blocked member is reported
inside the 200 as `{ testId, blocked: true, error, reason }` and the rest of
the batch still runs — one test pointed at localhost does not cost a suite its
other results, the same partial-accept US-028 uses for the concurrency cap.

An allowlist that would defeat the instance floor is refused when you try to
store it (`"db" is blocked by this instance and cannot be allowed per-project`),
because a project allowlist otherwise takes precedence over the denylist inside
the browser. A run stopped mid-flight by the fence ends `failed` with
`failure_reason: "navigation_blocked"` on the run detail and a named section in
the PDF; `failure_reason` is null on every other run.

## Files a run may upload

A project holds **fixtures** — files its tests may attach, uploaded once and
reused (US-048). A goal names one by filename ("upload cv.pdf and submit") and
the agent gets the paths.

The bytes go up as the raw request body, with the name in the query string —
there is no multipart form:

```bash
curl -X POST "http://<host>:8080/api/projects/careers/fixtures?filename=cv.pdf" \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/pdf" --data-binary @cv.pdf

curl http://<host>:8080/api/projects/careers/fixtures \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# { "fixtures": [ { "id": "...", "filename": "cv.pdf", "size_bytes": 48213, ... } ],
#   "used_bytes": 48213, "quota_bytes": 52428800, "max_bytes": 10485760 }

curl -X DELETE http://<host>:8080/api/projects/careers/fixtures/cv.pdf \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

**A run can only ever attach its own project's fixtures.** That whitelist is a
security boundary, not a convenience: it is what browser-use gates both
`upload_file` and `read_file` on, so without it an agent that could be argued
into calling either would be a file-read primitive pointed at the container.
The project comes off the saved test's row and is never read from a request
body — an ad-hoc `POST /api/runs` has no project and so may attach nothing.

Filenames must start with a letter or digit and contain only letters, digits,
spaces, dots, dashes and underscores; anything else is **400**. A duplicate
name is **409** (delete it first — silently replacing would change what a saved
test attaches with nothing in the history to say so), and either cap is **413**.
Caps are `FIXTURE_MAX_BYTES` and `FIXTURE_PROJECT_QUOTA_BYTES`.

Fixtures live under `FIXTURES_DIR`, **not** under `ARTIFACTS_DIR`, so
`ARTIFACT_RETENTION_DAYS` never removes them; the app refuses to boot if the two
overlap. They are deleted with their project.

## Email notifications

Off unless `RESEND_API_KEY` and `MAIL_FROM` are both set — `GET /api/health`
answers `mail` so you can tell "not configured" from "nothing failed yet".
Prefs live on the **project**, so one recipient list covers every test in it:

```bash
# who hears about this project's runs, and when.
# notify: failure (default) | always | never — "failure" is anything that is
# not a pass, so an errored or unjudged run mails too.
curl -X PUT http://<host>:8080/api/projects/checkout \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"notify":"failure","notify_emails":["qa@example.com","lead@example.com"]}'
```

Prefs are settable on `PUT` only, never on create. An empty `notify_emails`
falls through to `NOTIFY_EMAILS`, then to `OPERATOR_EMAIL`. Each finished run
decides for itself, one mail per recipient with the PDF attached; a run
started ad-hoc from the Run view never mails, having no test and no project.

Every mail carries a signed unsubscribe link — the one route in the app that
takes no bearer token, because the person clicking it was mailed a report and
does not have the instance's token. Suppression is by address and instance-
wide, so being added to a second project cannot quietly re-subscribe someone:

```bash
# who has opted out, and putting one back
curl http://<host>:8080/api/notifications/suppressions \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
curl -X DELETE http://<host>:8080/api/notifications/suppressions/qa@example.com \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

## Billing

**Off unless you turn it on, and self-hosting is always free.** With
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` unset there
is no billing UI, no gating and no `/api/billing` — the instance behaves as if
this feature did not ship. `GET /api/health` answers `billing` either way.

Turning it on gates **starting a run** and nothing else: an account without an
active subscription gets `402` from every run trigger, and its schedules stop
firing (they are never deleted, and resume on resubscribe). Reading stays open
— history, run detail, steps, reports and recordings all keep working, so
cancelling is never a data-loss event. LLM tokens remain BYOK on every tier: a
subscription pays for hosting, not for the model.

It also requires `AUTH_ENABLED` and `PUBLIC_BASE_URL`. Billing charges *users*,
so an instance with no real users — single-token or open — is never gated, and
Stripe needs somewhere to send the customer back to.

`active` and `trialing` may run. `past_due` keeps running until
`current_period_end`, because Stripe retries a declined card for around two
weeks and cutting off a paying customer on the first failed retry is the worse
bug. `canceled`, `unpaid`, `incomplete` and "never subscribed" are refused.

Only one plan exists: one recurring Stripe price, taken through Checkout, with
changes and cancellation handled by the Stripe Customer Portal. There is no
payment UI of our own, and no `stripe` dependency — the integration is three
form-encoded `POST`s and one HMAC.

### The activation window

A run is a real Chromium on a box you sized to a budget, not to demand. So
`ACTIVATION_SLA_HOURS` lets a subscription mean *"you may run once this
instance has room for you"* — a paid account waits that many hours while you
add the capacity it just bought, and is told so before it pays.

**Unset or `0` is off, and that is the default**: accounts run the moment they
are entitled, exactly as they did before this existed. Turning it off again
releases everyone currently waiting, so an instance that has outgrown rationing
just drops the line and restarts.

With it on, an account that has paid but has no capacity yet sees a fourth
onboarding step with its deadline instead of the app, and every run trigger
answers `503` with `Retry-After` and `activation_pending: true` — not the
`402`: they have paid, nothing is wrong with the request, and the right
instruction to a CI runner is come back later. Reads stay open throughout. Its
schedules are claimed but do not fire, so no backlog builds up to fire at once.

Your half is a script, run where the work already is — on the box, beside the
resize:

```bash
npm run activate                    # who is waiting, and how long each has left
npm run activate -- you@example.com # give that one account its capacity
```

You are mailed at `OPERATOR_EMAIL` when someone starts waiting, with the
deadline; they are mailed when you activate them. **Nothing auto-activates at
the deadline** — a timer that flipped the flag would hand a customer a box
nobody upgraded, which is the failure this exists to prevent. If the window
cannot be met, the honest lever is Stripe: refund or cancel.

Activation is sticky and is written by nothing but that script: a customer who
cancels and resubscribes is not re-provisioned, and no webhook can put an
account that has been running for a month back behind the wall.

### Testing billing locally

Stripe test mode — nothing here touches live money.

```bash
# 1. a test-mode price to sell, and the endpoint's signing secret
stripe login
stripe listen --forward-to localhost:8080/api/billing/webhook   # prints whsec_…

# 2. .env: the test keys, plus billing's other preconditions
#    STRIPE_SECRET_KEY=sk_test_…   STRIPE_WEBHOOK_SECRET=whsec_…
#    STRIPE_PRICE_ID=price_…       PUBLIC_BASE_URL=http://localhost:8080
#    AUTH_ENABLED=1                SESSION_SECRET=…   DATABASE_URL=…

# 3. sign in, hit Subscribe in Settings, pay with Stripe's test card
#    4242 4242 4242 4242, any future expiry, any CVC.

# 4. drive the rest of the lifecycle without waiting for a renewal
stripe trigger customer.subscription.deleted    # → runs start returning 402
```

`stripe listen` is not optional for local work: the webhook is what records the
subscription, and it authenticates by signature over the exact bytes Stripe
sent — so it cannot be faked with a hand-rolled `curl`.
