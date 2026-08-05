# Triggering from CI

A deploy finishes, the pipeline asks QAssist to run the tests that cover what
changed **against the URL that deploy just produced**, and fails the build if
any of them fail.

There is no Action and no plugin. The whole integration is `curl` plus a poll
loop, because the API is already the interface.

## Before you start

- **QAssist reachable from the runner**, normally over HTTPS, with an API key or
  token. A self-hosted runner may instead reach it over a private network.
- **The tests already exist**, made in the app and grouped into a
  [module or a suite](./organizing.md). CI never describes a test — no
  instruction text in pipeline YAML. The definitions stay server-side and can
  be rewritten without anyone touching the pipeline.
- `curl` and `jq` on the runner.

## Trigger a module or a suite — nothing else

Both are *the set of tests that covers a change*, which is the unit a job can
gate on. A module maps to a part of the app (`auth`, `checkout`); a suite is a
curated selection across modules (`smoke`, `pre-release`).

```
POST /api/projects/<project>/modules/<module>/run    # by slug: checkout/modules/auth
POST /api/suites/<suiteId>/run                       # by id
```

The API also supports the other two target sizes, but they are usually weaker
defaults for a deploy gate:

- **A single test is usually too narrow.** Pipelines that accumulate a list of
  test IDs are better represented by a named suite.
- **A whole project is every test there is** — minutes of browser time and model
  spend on every push. That is a nightly [schedule](./schedules.md).

Both endpoints take the same body and return the same shape: one run per member
test, queued behind the instance's concurrency cap. A ten-test module on a
two-session instance takes five run-lengths of wall clock, so size the job
timeout accordingly.

## The three things the body does

**`start_url`** replaces the saved start URL of *every* test in the batch. This
is how one saved module tests a different preview deploy on each push. It is a
[full replacement, not a prefix](./saved-tests.md#running-one).

**`variables`** overrides the [named values](./variables.md) the tests declare —
a login user, an API base, a coupon code, a tenant id. The map is sprayed across
every test in the batch; each substitutes the names it declares and ignores the
rest. This is what lets a staging pipeline be the production pipeline with two
strings changed.

**`trigger: "ci"`** tags the runs, so History can answer "what did the pipeline
run" separately from what a human clicked.

## What to gate on

`GET /api/runs/<runId>` answers `queued` or `running` (keep waiting), or one of
the terminal statuses.

**Gate only on `passed`. Treat every other terminal status as a failure.** That
includes `completed`, which means the agent finished without a verdict, and
`cancelled`, which means somebody stopped the run before it verified the
requested outcome.

## The script

Commit this as `ci/qassist-run.sh` (`chmod +x`). It takes the run endpoint and an
optional URL to test against, and exits non-zero if any run did not pass.

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
    *)
      echo "  FAIL  $id  [$status] $detail"
      echo "        $QASSIST_URL/runs/$id"
      exit_code=1
      ;;
  esac
done
exit $exit_code
```

Every run has a page at `$QASSIST_URL/runs/<runId>`, so the failing line in the
job log is a link somebody can open instead of an id they have to go and find.

::: warning Do not store the base URL as a secret
CI systems redact secret *values* wherever they appear in output, so a
`QASSIST_URL` held as a secret turns every permalink into `***/runs/<id>`. It is
a public hostname; the token is the only credential. Store them accordingly.
:::

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
          QASSIST_URL: ${{ vars.QASSIST_URL }}        # a variable, not a secret
          QASSIST_TOKEN: ${{ secrets.QASSIST_TOKEN }}
          QASSIST_VARS: '{"env":"prod","user":"ci-bot"}'
```

`QASSIST_URL` goes under **Settings → Secrets and variables → Actions →
Variables**, `QASSIST_TOKEN` under **Secrets** on the same page. A value that
lives in both is still masked, so if you started with the URL as a secret,
delete it there after adding the variable.

Point a second environment at the same tests by changing only `QASSIST_VARS`. A
suite is the same job with the target swapped:

```yaml
          ci/qassist-run.sh /api/suites/8f3c…/run "${{ … }}"
```

If your deploy is a step in this same workflow rather than a separate
integration, drop the `on:`/`if:` pair and make the QAssist step `needs:` the
deploy job, passing whatever URL that job output.

## GitLab CI

Same script. The deploy job publishes its URL as a dotenv artifact so the test
job can read it:

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
    QASSIST_VARS: '{"env":"prod","user":"ci-bot"}'
  before_script:
    - apk add --no-cache bash curl jq
  script:
    - bash ci/qassist-run.sh "$QASSIST_TARGET" "$PREVIEW_URL"
```

`QASSIST_URL` and `QASSIST_TOKEN` are project CI/CD variables. Mark the token
**masked** and **protected** so it never reaches a fork's pipeline, and leave the
URL unmasked so run permalinks stay readable in the job log.

## Seeing what happened

The job log gives you the verdict and each run's id. Everything else is in the
app: open History, filter to trigger `ci`, and each run has its steps, its
recording and its report.
