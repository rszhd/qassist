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

# download the PDF report (202 while generating, 200 when ready).
# 404 on every run unless the instance sets REPORTS_ENABLED — reports are off
# by default while the renderer is being reworked, and /api/health says which
# (`reports`). The step list below is unaffected.
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

### Steering a run in flight

Four writes act on a run that has not finished. All four are scoped to the run's
owner and answer `404` — never `403` — for anyone else, so a refusal cannot
confirm another tenant's run exists. A run that has already ended, or is not in
the state the call needs, answers `409`.

None of them sit behind the billing gate or require a stored key: they are how a
user stops or redirects spending, so they have to work for an account whose
subscription lapsed or whose key was removed mid-run.

```bash
# stop early (US-047). The agent finishes its recording and report, so the
# partial evidence survives — the run ends `cancelled`, carrying no verdict.
curl -X POST http://<host>:8080/api/runs/<runId>/stop \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"runId":"...","status":"running","stopping":true}

# hold the run before its next action (US-079). A queued run has no browser to
# hold: 409. The screencast keeps working while paused.
curl -X POST http://<host>:8080/api/runs/<runId>/pause \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"runId":"...","paused":true}

# let it carry on. 409 if the run is not paused.
curl -X POST http://<host>:8080/api/runs/<runId>/resume \
  -H "Authorization: Bearer $WORKER_API_TOKEN"

# tell it what to do. Additive: the original goal survives and the run
# continues from the step it was on. Sent to a paused run, this also resumes it.
curl -X POST http://<host>:8080/api/runs/<runId>/hint \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"the confirm button is in the account menu"}'
# -> {"runId":"...","paused":false}
```

`text` is required and capped at 1000 characters; empty or longer is `400`.

**A pause is bounded.** It suspends the run's wall-clock limit — otherwise a
paused run would be killed as a resource failure — and starts its own
`PAUSE_MAX_SECONDS` budget (default 600). A pause nobody resumes ends the run
`cancelled`, with the steps and recording it produced. A resumed run gets back
the wall clock it had left, not a fresh ceiling, so pausing repeatedly cannot
buy a run more time.

**A hint is evidence.** It appears in `GET /api/runs/<runId>/steps` as `hints`,
and in `report_data.json` as `hints` plus `assisted: true`, which the PDF states
on its cover. What that costs a verdict is
[Steering a live run](https://docs.qassist.run/steering-a-run) in the manual.

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

`GET /api/projects/:project` returns the project with its modules and a count
of everything else it holds — `test_count`, `suite_count`, `session_count`,
`fixture_count` — so a caller can tell what a project contains without four
more requests.

```bash
curl http://<host>:8080/api/projects/checkout \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"id":"...","slug":"checkout","modules":[...],"test_count":12,
#     "suite_count":2,"session_count":1,"fixture_count":0, ...}
```

Deleting a module or project never deletes tests — they fall back to
Ungrouped. Deleting a project does take its suites with it.

### Variables, and the secret ones

A test declares `variables`; the goal and `start_url` reference them as
`{{name}}`, and a run overrides any of them
([`manual/ci.md`](../manual/ci.md) covers the CI body).

```bash
curl -X POST http://<host>:8080/api/tests \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"admin login","goal":"log in as {{user}} with {{pw}}",
       "start_url":"https://example.com/login",
       "variables":[{"name":"user","value":"admin"},
                    {"name":"pw","value":"hunter2","secret":true}]}'
# -> "variables":[{"name":"user","value":"admin","secret":false,"optional":false},
#                 {"name":"pw","value":"","secret":true,"optional":false,"value_set":true}]
```

A `secret`'s value is stored **encrypted** and is never returned by any
endpoint — reads carry `value_set` instead, and that is the only thing they say
about it. It reaches the browser as `sensitive_data`, so it is never in the
run's goal, its history row, or a report.

On a write, the secret's box is therefore three-state: **blank (or absent)
keeps** what is stored, a **non-empty value replaces** it, and
`{"name":"pw","secret":true,"clear":true}` **removes** it. Dropping the
declaration, or unticking `secret`, removes the stored value too.

At run time the order is **override > stored > declared default**, except that
an empty override never displaces a stored secret. A required secret with none
of the three rejects the run with a 400. Why the states are shaped this way is
argued on [the manual's Variables page](https://docs.qassist.run/variables.html).

### What a test remembers between runs

A saved test keeps a small notebook: what worked, what to avoid next time, and
where the flow ended. Every passing run adds to it, and a later run is given it
as fallible advice about a previous pass. It is on by default, cannot be turned
off, and needs no setup — these endpoints exist to inspect it and to throw it
away.

```bash
curl http://<host>:8080/api/tests/<testId>/memory \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"learned":{"successful_approach":[{"id":"a1b2c3d4e5f6",
#       "text":"Open Billing from the account menu","steps":[4],
#       "run_id":"...","learned_at":"...","hinted":false}]},
#     "supplied":{...},"learned_at":"..."}
```

`supplied` is **exactly** what the next run is handed, or `null` when it will run
cold. There is no memory the model sees and this endpoint does not.

`learned` is what is stored, and `supplied` is what the next run gets. They are
the same unless the notebook is empty: **nothing withholds a notebook**. An edit
does not, a failing run does not, a model change does not. Only a person takes
one away.

An edit that changes the test's **instructions** or **start URL** does offer,
though, because that is the one judgement a person can make and the system
cannot — a typo fixed in the instructions is not a different flow. `PUT
/api/tests/<testId>` answers with `"memory":{"changed":true,"lessons":2}`, and
the UI asks. Nothing acts on it: keep the lessons, or clear them with the call
below.

**A run that does not pass changes nothing.** The commonest reason a test fails
is that it found the bug it exists to find, so a failure is not evidence against
the advice — and making the next run cold would replace a notebook none of whose
lessons had failed. A wrong lesson is removed, or the notebook is cleared.

Each lesson carries its own provenance: the run that found it, when, and whether
a person hinted the run that led to it.

Two things a person may do, and both are deletions:

```bash
# drop one lesson that is wrong
curl -X DELETE http://<host>:8080/api/tests/<testId>/memory/lessons/<lessonId> \
  -H "Authorization: Bearer $WORKER_API_TOKEN"

# throw the whole notebook away; run history is untouched and the next run
# starts as if the test had never learned anything
curl -X DELETE http://<host>:8080/api/tests/<testId>/memory \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
```

A lesson can be removed and **not written**. `learned` means "derived from a
trace this test produced", so there is no endpoint that adds one — hand-written
advice must not be able to claim provenance it does not have. Durable
instructions belong in the test's own **Instructions** field, which is also what
the verdict is judged against. The notebook is only what a run worked out for
itself.

Every run says which it was: `memory_used` on a history row is `true` when
learned lessons reached the agent. A run that was given the notebook may still
add to it — what stops advice confirming itself is the shape of the write, not
silence. An assisted run adds what it found, and can only erase a lesson its own
steps show failing; a cold run, having had no advice, replaces the notebook
outright.

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

A schedule has nobody to ask for a secret, so it uses the value stored on the
test, and a write is **refused** if any target test needs one it hasn't got —
naming the test and the variable. Turning a schedule off is exempt: a disabled
schedule fires into nothing, and refusing that edit would put the fix behind
the refusal.

`last_run_at` means a run actually started, not that the slot came round:
taking the slot advances `next_run_at` alone, and a slot that started nothing —
an empty target, every member already running, none able to resolve — leaves
`last_run_at` where it was. A schedule whose `next_run_at` keeps moving while
`last_run_at` stands still has stopped testing anything. The list says why:
each row carries `target_tests`, the number of tests the target holds *now*,
resolved the same way the scheduler resolves it. A target can be emptied
without the schedule being touched, and `0` there is a schedule firing into
nothing.

Each row also carries `recent`: up to 20 past slots, newest first, as
`{ scheduled_for, status, runs, failed }`. **A slot is one firing, not one
run** — a suite schedule starts one run per member and they are a single entry,
whose `status` is the worst of them. Green means every member passed; a slot
still in flight reads as `running` or `queued`, never as passed. Nothing here
is a new state: every `status` is a `runs.status` value.

What `recent` cannot show is a slot that started nothing at all — an empty
target, every member already running, a lapsed subscription. Those write no run
row, so they are absent rather than marked, and `firing_into_nothing` below is
the tell for them. Runs made before the attribution columns existed are absent
for the same reason: they carry no `schedule_id`.

The comparison itself is on the row too: `firing_into_nothing` is true when the
slot before `next_run_at` — one the claim has certainly been through — is newer
than `last_run_at`, and newer than the schedule's own `created_at`. That last
clause is what separates "has been failing to start for a week" from "was made
this afternoon and is not due until 02:00". A disabled or never-dated schedule
is never marked.

## From CI/CD

A pipeline triggers a **module or a suite** — the set of tests that covers a
change — passing the fresh preview URL as `start_url`, then polls each run and
fails the job unless every one comes back `passed`. That's `curl` plus a poll
loop, no Action and no plugin: **[the manual's CI
page](https://docs.qassist.run/ci.html)** ([`manual/ci.md`](../manual/ci.md))
has the script and ready-made GitHub Actions and GitLab CI jobs.

## Run history

`GET /api/runs` lists finished and in-flight runs newest first. Every row
carries the test's name and grouping, so a history table renders from one
request.

```bash
# filters combine: test_id, schedule_id, project_id, module_id, trigger and
# status (comma-separated), since/until (ISO on created_at), limit (≤200), offset
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

### What a run cost

Every run row carries `prompt_tokens`, `completion_tokens`, `total_tokens`,
`total_cost` and `cost_known`. Tokens and cost are **two separate questions**,
and the second one has an answer only sometimes:

- `total_tokens` is a measurement whenever it is non-null. Null means nobody
  counted — a run from before this shipped, or one that crashed before the
  agent could summarise itself.
- `total_cost` is an **estimate**, priced from a table browser-use fetches and
  caches, not from the provider's billing API. It drifts, it does not know
  negotiated rates, and it is `null` unless `cost_known` is true.

**Never render a null cost as `$0.00`, and never sum a set that contains one
without saying so.** `cost_known` is false in three unrelated cases — the
operator set `CALCULATE_COST=0`, the pricing table could not be fetched, or the
model has no published price — and only a `cost_known: true` zero means the run
was free. A total over a filtered page that quietly skips the unpriced runs
looks authoritative and is wrong downwards, which is the direction nobody
questions.

The per-model breakdown — a run bills against the agent, the judge, page
extraction and message compaction, each of which may be a different model — is
in `runs/<id>/report_data.json` under `usage.by_model`, not in the row. Each
entry carries its own `cost_known`, so an unpriced total can be traced to the
model that caused it.

`CALCULATE_COST=0` turns the whole thing off, including the pricing fetch.
Tokens are still counted; they cost nothing to collect.

`schedule_id` narrows to the runs one schedule started. It is the filter to
reach for when two schedules point at the same target — an hourly smoke and a
nightly regression on one test are indistinguishable under `test_id` and under
`trigger=schedule`. Runs made before the schedule was deleted stay in history
and stop matching it, and runs made before this filter existed match nothing.

## Why a run failed: network and console evidence

A verdict says the goal was not reached; the diagnostics say what broke. Every
run captures the **failed requests** (status ≥ 400 and transport failures), the
**console errors and warnings** and the **uncaught exceptions** the browser
reported, each stamped with the step it happened during (US-044). They ride on
the step endpoint, because they are the same read for the same view:

```bash
curl http://<host>:8080/api/runs/<runId>/steps \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# -> {"steps":[…],
#     "diagnostics":[
#       {"kind":"request","step":2,"url":"https://api/order","status":500,"error":null,"count":1},
#       {"kind":"console","step":2,"level":"error","text":"TypeError: …","count":7},
#       {"kind":"exception","step":3,"text":"Error: submit handler died","count":1}],
#     "diagnostics_dropped":0}
```

`kind` is `request`, `console` or `exception`. A `request` with a null `status`
never came back at all and carries the transport `error` instead — a CORS
rejection or a DNS failure, neither of which a screenshot can show. `count` is
how many times an identical finding repeated. `step` is null for a finding that
predates the first step, which is where a page's own failed assets land.

The list is deliberately a **summary, not an archive**: the agent keeps at most
five distinct findings per kind per step, counts the rest into
`diagnostics_dropped`, and truncates each line to 300 characters — all before
anything crosses its stdout, so a page emitting thousands of console lines per
step cannot stall the run. Everything captured is scrubbed of the run's secret
variables first, so nothing here leaks into the PDF that US-012 emails.

Same data, same shape, in `runs/<id>/report_data.json` and as a named section in
the PDF report.

### The full archive (opt-in)

When the summary is not enough, a run can also write a complete HAR:

```bash
curl -X POST http://<host>:8080/api/runs \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"…","start_url":"https://example.com","har":true}'

# 404 unless that run asked for one
curl -L http://<host>:8080/api/runs/<runId>/network.har \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -o network.har
```

`CAPTURE_HAR=1` turns it on for every run on the instance; an explicit
`"har": false` on the request still turns it off for one run. Headers and
bodies are **not** recorded (`record_har_content: omit`, `record_har_mode:
minimal`), so no `Bearer` or `Cookie` value reaches the file.

> **The HAR is the one artifact redaction does not reach.** Chromium writes it,
> not the agent, so a secret in a query string appears in it verbatim. That is
> why it is off by default and why it is a download rather than something the
> report embeds or an email attaches. It lives in `runs/<id>/` and
> `ARTIFACT_RETENTION_DAYS` prunes it with the recording and the PDF.

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

**A run can only ever attach its own project's fixtures.** The whitelist is a
security boundary ([architecture.md §9](architecture.md#9-secrets-and-containment)):
the project comes off the saved test's row and is never read from a request
body — an ad-hoc `POST /api/runs` has no project and so may attach nothing.

Filenames must start with a letter or digit and contain only letters, digits,
spaces, dots, dashes and underscores (any alphabet), must not end with a dot
or a space, and must fit in 255 bytes; anything else is **400**. A duplicate
name is **409** — delete it first, replacing is deliberately not offered — and
either cap is **413**. Caps are `FIXTURE_MAX_BYTES` and
`FIXTURE_PROJECT_QUOTA_BYTES`; the reasoning is
[the manual's Files page](https://docs.qassist.run/files.html).

Fixtures live under `FIXTURES_DIR`, **not** under `ARTIFACTS_DIR`, so
`ARTIFACT_RETENTION_DAYS` never removes them; the app refuses to boot if the two
overlap. They are deleted with their project.

## Starting a run already logged in

A project holds **sessions** — a saved, signed-in browser state its tests can
start from (US-043), so a suite tests the product instead of testing the login
form once per test per night. Which strategy to reach for, and what social
login and confirmation codes can and cannot do, is
[auth-in-tested-flows.md](auth-in-tested-flows.md).

```bash
# the usual way: name a session and point it at the test that logs in.
# `storage_state` is optional — the next PASSING run of that test fills this.
curl -X POST http://<host>:8080/api/projects/shop/sessions \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"staging login","login_test_id":"<test id>","verify_url_contains":"/dashboard"}'

# or, if you already have one, paste a Playwright storageState.json
curl -X POST http://<host>:8080/api/projects/shop/sessions \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"from playwright","storage_state":'"$(cat storageState.json)"'}'

curl http://<host>:8080/api/projects/shop/sessions \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# { "sessions": [ { "id": "...", "name": "staging login", "cookie_count": 14,
#     "origin_count": 2, "source": "pasted", "captured_at": "...", ... } ] }

# a test opts in
curl -X PUT http://<host>:8080/api/tests/<id> \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"browser_session_id":"<session id>"}'
```

`PUT /api/projects/:project/sessions/:id` renames, re-points or replaces one
(send `storage_state` again); `DELETE` removes it and leaves its tests running
signed out.

**No read ever returns the stored session.** A `storageState` *is* the
credential, so it is encrypted at rest and decrypted only to write one spawn's
temp file; the counts and `captured_at` exist so a session can be described
without being readable. The full handling discipline is
[auth-in-tested-flows.md](auth-in-tested-flows.md).

**Three ways to produce one, and you need no Playwright for any of them.** Set
`login_test_id` to a test whose job is to log in and leave `storage_state` out:
the session is created empty and the next *passing* run of that test saves the
browser's session into it, so a nightly schedule (US-010) keeps it fresh. Or
create it with `{"capture_method":"extension"}` and fill it with the browser
extension (below) — the route for logins a test can never drive, chiefly social
login. Or paste a `storageState.json` if you already have one — the developer
shortcut. A failing login run never touches the stored session.

Until it has been captured, a session reads `"captured_at": null`, and a test
that opts into it is **refused at run start** (400, nothing enqueued) rather
than run signed out. A session with none of a blob, a login test or
`capture_method: "extension"` is refused at creation, since nothing could ever
fill it.

### Capturing with the browser extension (US-063)

The extension (`extension/`, published on the Chrome Web Store — see
`extension/README.md`) has no
QAssist login of its own. It trades a short-lived, single-use **capture
token** for permission to fill exactly one session, once:

```bash
# create an empty session that declares it'll be filled by the extension
curl -X POST http://<host>:8080/api/projects/shop/sessions \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"google sso","capture_method":"extension"}'

# mint a capture token for it — shown to a human, pasted into the extension
# popup as part of a "setup code", never typed by hand
curl -X POST http://<host>:8080/api/projects/shop/sessions/<id>/capture-token \
  -H "Authorization: Bearer $WORKER_API_TOKEN"
# { "token": "qsc_...", "instance_url": "http://<host>:8080", "expires_at": "..." }
```

The extension itself calls `POST /api/capture` — deliberately **not** behind
`WORKER_API_TOKEN` or any other login, since it has none; the capture token in
its `Authorization` header is its entire credential:

```bash
curl -X POST http://<host>:8080/api/capture \
  -H "Authorization: Bearer qsc_..." -H 'Content-Type: application/json' \
  -d '{"storage_state": {"cookies":[...],"origins":[...]}}'
# 204 No Content on success — the response never echoes the blob back
```

A capture token authenticates nothing else: it is a `session_capture_tokens`
row, not an `api_keys` one, checked by this one route and consumed atomically
on first use. It expires 15 minutes after minting, matching the login-link TTL
in `auth.js`.

**An expired session is a verdict, not a mystery.** Set `verify_url_contains`
and/or `verify_text` and the run checks them *before* its first LLM step; if the
session is dead the run ends `failed` with `failure_reason: "session_expired"`
and a named section in the PDF, instead of wandering into the login page and
blaming the goal.

### A preamble before the first step

A project can also carry `initial_actions` — deterministic browser actions run
before the agent's first LLM step, at no token cost. Useful with or without a
session: dismissing a cookie dialog is otherwise two wasted steps on every run
in the project, forever.

```bash
curl -X PUT http://<host>:8080/api/projects/shop \
  -H "Authorization: Bearer $WORKER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"initial_actions":[{"send_keys":{"keys":"Escape"}},{"wait":{"seconds":2}}]}'
```

Only `navigate`, `wait`, `send_keys` and `scroll` are allowed — everything else
browser-use offers needs an element index that does not exist before the page
has been looked at, and `upload_file`/`read_file` are the fixture whitelist's
boundary. A `navigate` URL is checked against the same navigation fence a
`start_url` is, when you save it. The preamble is recorded as step 0, so the
steps a run is charged for still start at 1.

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
decides for itself, one mail per recipient — with the PDF attached where the
instance renders one (`REPORTS_ENABLED`); a run started ad-hoc from the Run
view never mails, having no test and no project.

Every mail carries a signed unsubscribe link — the one route in the app that
takes no bearer token, because the person clicking it was mailed a report and
does not have the instance's token. Suppression is by address and
instance-wide:

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
— history, run detail, steps, reports and recordings all keep working. LLM
tokens remain BYOK on every tier; the user-facing account is
[the manual's Settings page](https://docs.qassist.run/settings.html#billing-if-you-are-running-a-paid-instance).

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
