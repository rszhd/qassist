# Running QAssist from CI/CD

The pipeline step for US-008. A deploy finishes, the job asks QAssist to run
the tests that cover what changed against the URL that deploy just produced,
and fails the build if any of them fail.

There is no Action and no plugin — the whole integration is `curl` plus a
poll loop, because the API is already the interface. Copy
[the script](#the-script) into your repo, wire one job to it, done.

## Prerequisites

- **QAssist reachable over HTTPS** from the runner, with a token
  (`WORKER_API_TOKEN`). A runner can only reach a publicly routable endpoint.
- **The tests already exist**, created in the QAssist UI and grouped into a
  module or a suite. CI never describes a test — no goal strings in pipeline
  YAML. The definitions live server-side and can be rewritten without anyone
  touching the pipeline.
- `curl` and `jq` on the runner.

## What a pipeline may trigger

**A module or a suite — nothing else.** Both are *the set of tests that
covers a change*, which is the unit a job can gate on: a module maps to a
part of the app (`auth`, `checkout`), a suite is a curated selection across
modules (`smoke`, `pre-release`).

The other two targets exist in the API and are deliberately not documented
here. A **single test** is not a gate: a deploy check that runs one goal and
calls the build green is a false signal, and pipelines that want it end up
listing ten ids by hand, which is a suite spelled badly. A **whole project**
is every test there is — minutes of browser time and LLM spend on every push,
which is a nightly [schedule](api.md#schedules), not a per-deploy gate.

So the endpoint is one of:

```
POST /api/projects/<project>/modules/<module>/run    # by slug: checkout/modules/auth
POST /api/suites/<suiteId>/run                       # by uuid
```

Projects and modules carry slugs, so the module path reads as what it runs and
survives a rename. Suites don't have slugs yet, so a suite target carries its
uuid — copy it from the URL in the UI.

Both accept the same body and return the same shape:

```jsonc
// body -> {"start_url":"https://preview-abc123.example.com","variables":{"env":"prod"},"trigger":"ci"}
{
  "moduleId": "…",                                 // or "suiteId"
  "runs": [{ "runId": "…", "testId": "…", "status": "queued" }]
}
```

One run per member test, queued behind `MAX_CONCURRENT_SESSIONS` like every
other run — a ten-test module on a two-session worker takes five run-lengths
of wall clock, so size the job timeout accordingly.

## The three things the body does

**`start_url`** overrides the saved `start_url` of *every* test in the batch,
which is how one saved module tests a different preview deploy on each push.
It is a **full replacement, not a prefix** — a test saved against
`https://example.com/login` run with `start_url=https://preview-abc.app`
starts at that preview's root, not at its `/login`. Tests you intend to run
from CI should therefore be authored to navigate from the app root ("go to
the login page, then …"), which is what you want anyway: the navigation is
part of what's being tested.

**`variables`** overrides the named variables a test declares (US-035) — the
generalization of `start_url` to any per-environment value: a login user, an
API base, a coupon code, a tenant id. A test whose goal reads
`log in as {{user}} on {{env}}` runs against production when the body carries
`{"variables": {"user": "ci-bot", "env": "prod"}}`, and against staging from a
second pipeline that changes only those values — one saved test, one snippet,
no per-environment clones. The map is sprayed across *every* test in a batch;
each test substitutes the names it declares and fills the rest from its own
defaults, so a name a given test doesn't declare is simply ignored. A variable
the test marks required (referenced, no default) with no override rejects that
run with a 400 rather than running with a hole in the goal.

A **secret** variable can also carry a value stored (encrypted) on the test
itself — which is what lets a schedule type one. An override still wins, so a
pipeline that injects the credential from its own secret store behaves exactly
as before; sending `""` for one does not, and falls back to the stored value.

**`trigger: "ci"`** tags the runs, so History can filter to
`?trigger=ci` and answer "what did the pipeline run" separately from what a
human clicked.

## Polling and the verdict

`GET /api/runs/<runId>` returns `status`, one of `queued` and `running` (keep
waiting) or `passed`, `failed`, `completed`, `error`, `cancelled` (terminal).

**Gate on `passed`; treat everything else as a failure.** `failed` and `error`
are obvious. `completed` is the interesting one — the agent finished its steps
but produced no pass/fail verdict, which means the run answered nothing. A
build that goes green on "answered nothing" is exactly the false signal this
step exists to prevent.

**`cancelled` is the one exception, and it is deliberate.** A run reaches it
only because a person opened it in QAssist and pressed Stop (US-047) — it is
never something the agent, the worker or a timeout produces. Failing the build
on it would mean the pipeline reports a problem with the deploy when what
actually happened is that somebody watching decided the run wasn't worth
finishing, which they already know. So the script prints a `STOP` line with the
run's link and leaves the exit code alone.

Read the tradeoff before you copy it. A stopped run verified **nothing**, so a
job whose runs were all stopped exits 0 having proved nothing — anyone who can
reach the QAssist UI can turn a gate green by stopping its runs. That is
acceptable here because stopping is scoped to the run's own owner and takes a
deliberate click per run, while the alternative — a red build for an action
whose entire purpose is to *stop* spending on a run — makes the feature cost an
incident. If your pipeline gates a release on this, swap the `cancelled` branch
for the `*)` one and treat a stop as a failure; nothing else in the script
changes.

## The script

Commit this as `ci/qassist-run.sh` (`chmod +x`). It takes the run endpoint and
an optional URL to test against, and exits non-zero if any run didn't pass.

```bash
#!/usr/bin/env bash
# Trigger a QAssist module or suite and gate the job on its verdict.
# Usage: qassist-run.sh <run-endpoint> [start_url]
set -euo pipefail

: "${QASSIST_URL:?set QASSIST_URL, e.g. https://qa.example.com}"
: "${QASSIST_TOKEN:?set QASSIST_TOKEN}"
endpoint="$1"
start_url="${2-}"
vars="${QASSIST_VARS:-}"          # JSON object of variable overrides, e.g. {"env":"prod"}
poll="${QASSIST_POLL_SECONDS:-10}"
timeout="${QASSIST_TIMEOUT_SECONDS:-900}"   # per run, not for the batch

auth=(-H "Authorization: Bearer $QASSIST_TOKEN" -H "Content-Type: application/json")
body=$(jq -nc --arg u "$start_url" --argjson v "${vars:-null}" \
  '{trigger:"ci"}
   + (if $u == "" then {} else {start_url:$u} end)
   + (if $v == null then {} else {variables:$v} end)')

runs=$(curl -fsS -X POST "$QASSIST_URL$endpoint" "${auth[@]}" -d "$body")
ids=$(jq -r '.runs[].runId' <<<"$runs")
[ -n "$ids" ] || { echo "no runs started"; exit 1; }
echo "started $(wc -w <<<"$ids") run(s) against ${start_url:-the saved URLs}"

exit_code=0
for id in $ids; do
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    run=$(curl -fsS "$QASSIST_URL/api/runs/$id" "${auth[@]}")
    status=$(jq -r .status <<<"$run")
    case "$status" in queued|running) ;; *) break ;; esac
    if [ "$(date +%s)" -ge "$deadline" ]; then status="timed out"; break; fi
    sleep "$poll"
  done

  detail=$(jq -r '.result.final_result // .error // ""' <<<"$run")
  case "$status" in
    passed)
      echo "  PASS  $id  $detail"
      ;;
    cancelled)
      # Somebody stopped this run by hand. Not a verdict, and not a build
      # failure — see "Polling and the verdict" for why, and for when to move
      # this line down into the catch-all instead.
      echo "  STOP  $id  stopped before it finished"
      echo "        $QASSIST_URL/runs/$id"
      ;;
    *)
      echo "  FAIL  $id  [$status] $detail"
      echo "        $QASSIST_URL/runs/$id"
      exit_code=1
      ;;
  esac
done
exit $exit_code
```

Every run has a page at `$QASSIST_URL/runs/<runId>` — verdict, activity,
recording and report — so the failing line in the job log is a link somebody
can open instead of a run id they have to go and find.

For that link to survive the log, **the base URL must not be a secret.** CI
systems redact secret *values* wherever they appear in output, so a
`QASSIST_URL` held as a secret turns every permalink into `***/runs/<id>` — the
run id is still there, but the link is gone. It is a public hostname; the token
is the only credential. Store them accordingly: GitHub `vars` vs `secrets`
below, and on GitLab mask the token only.

## GitHub Actions

Trigger on **deploy success**, not on the merge, and pass the environment URL
that deploy published — the agent should test what users will actually hit.
`deployment_status` is what Vercel, Netlify and most CD integrations emit.

```yaml
name: QA smoke
on: deployment_status

jobs:
  smoke:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: |
          ci/qassist-run.sh \
            /api/projects/checkout/modules/auth/run \
            "${{ github.event.deployment_status.environment_url }}"
        env:
          QASSIST_URL: ${{ vars.QASSIST_URL }}        # a variable, not a secret — see above
          QASSIST_TOKEN: ${{ secrets.QASSIST_TOKEN }}
          QASSIST_VARS: '{"env":"prod","user":"ci-bot"}'   # overrides the test's declared variables
```

Set `QASSIST_URL` under **Settings → Secrets and variables → Actions →
Variables**, and `QASSIST_TOKEN` under **Secrets** on the same page. A value
that lives in both is still masked, so if you started with the URL as a secret,
delete it there after adding the variable.

Point a second environment at the same tests by changing only `QASSIST_VARS` —
a staging job is this job with `'{"env":"staging",…}'`.

A suite is the same job with the target swapped:

```yaml
          ci/qassist-run.sh /api/suites/8f3c…/run "${{ … }}"
```

If your deploy is a step in this same workflow rather than a separate
integration, drop the `on:`/`if:` pair and make the QAssist step `needs:` the
deploy job, passing whatever URL that job output.

## GitLab CI

Same script. The deploy job publishes its URL as a
[dotenv artifact](https://docs.gitlab.com/ci/yaml/artifacts_reports/#artifactsreportsdotenv)
so the test job can read it:

```yaml
deploy-preview:
  stage: deploy
  script:
    - PREVIEW_URL=$(./deploy.sh)          # your deploy prints the URL it made
    - echo "PREVIEW_URL=$PREVIEW_URL" >> deploy.env
  artifacts:
    reports:
      dotenv: deploy.env                  # -> $PREVIEW_URL in later jobs

qa-smoke:
  stage: test
  needs: [deploy-preview]
  image: alpine:3.20
  timeout: 30m
  variables:
    QASSIST_TARGET: /api/projects/checkout/modules/auth/run
    QASSIST_VARS: '{"env":"prod","user":"ci-bot"}'   # overrides the test's declared variables
  before_script:
    - apk add --no-cache bash curl jq
  script:
    - bash ci/qassist-run.sh "$QASSIST_TARGET" "$PREVIEW_URL"
```

`QASSIST_URL` and `QASSIST_TOKEN` are project CI/CD variables; mark the token
**masked** and **protected** so it never reaches a fork's pipeline, and leave
the URL unmasked so run permalinks stay readable in the job log. A suite is
the same job with `QASSIST_TARGET: /api/suites/<uuid>/run`.

## Seeing what happened

The job log gives you the verdict and each run's id. Everything else lives in
QAssist: open History, filter by trigger `ci`, and each run has its steps,
recording and PDF report.
