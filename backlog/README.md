# Backlog

One file per user story. Status lives in each file's header; this README is
the overview (keep it in sync when a story changes state or moves folder).

Two root-level files are **not** stories but living reference docs that sit
here because they track the backlog as a whole: this README, and
[`correctness-critical.md`](correctness-critical.md) — the register of
correctness-critical, easy-to-get-subtly-wrong surfaces the assertion-first
Workflow rule (`CLAUDE.md`) applies to.

## Folder layout

- `sprint/current/` — stories scoped to the sprint being worked on now.
- `sprint/next/` — stories queued for the sprint after this one.
- `sprint/<name>/done/` — stories in that sprint that are finished. **What sits
  in the sprint folder itself is exactly the work left to do**, so a glance
  at `ls sprint/current/` answers "what's still open?". Move a story here (`git mv`
  + README table update) the moment it ships, not at sprint's end. A tiered
  story moves once the tier that this sprint owes is done, even if later
  tiers stay planned in its file.
- `unscheduled/` — stories with no sprint assigned yet.
- `released/<name>/` — shipped releases, moved here wholesale when the release
  goes out (e.g. `released/prototype/`), `done/` subfolder and all. Anything
  still sitting in the sprint folder root at that point never shipped: move
  it into `sprint/next/` (or `unscheduled/`) before the `git mv`, so
  a released folder only ever contains finished work. A story with follow-up
  tiers left over gets those spun into a new story in `unscheduled/`.

## Current sprint — `sprint/current/`

Scope decided 2026-07-22, extended the same day to include the hosted paid
tier, then **narrowed on 2026-07-23 to the release-plumbing stories** once
saved tests, projects and modules, recording, run history, scheduling,
failure emails and run permalinks had all shipped: what was left was the four
stories that turn a working app into a release someone else can run — public
HTTPS (US-007), a CI snippet proven against it (US-008), a licence on a
public repo (US-031), and a tested, published image (US-032).

Sprints aren't split along a self-host/hosted-tier line — `sprint/current/`
and `sprint/next/` are just now vs. later, reprioritized as needed. On
2026-07-24, US-021 (signup & login) and US-033 (live demo replay) were pulled
forward from `sprint/next/` into this sprint; on 2026-07-25, US-022 (Stripe
billing) followed, which empties the hosted tier out of `sprint/next/`. The
same day, **US-038** (staging) was written straight into the sprint — the four
release-plumbing stories turned out to share an unstated fifth.

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-007](sprint/current/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy (and the Resend sender domain) | 🧱 Repo side shipped (2026-07-25) — overlay, proxy, `DEPLOY.md`; DNS + the box left | domain (owned) |
| [US-040](sprint/current/US-040-demo-deployment.md) | Deploy the demo sandbox at `demo.qassist.run` | 🟢 **Live**, 10/11 (2026-07-26) — up at `demo.qassist.run` on `0.2.1`, the tag cut because `v0.2.0` predates the fixture `COPY` and would have failed every run. Replay streams over the WS through Traefik with no Chromium and no key; tenants are isolated; a visitor cannot make it mail a stranger; the reaper took an expired tenant's rows *and* its dirs without following the symlinks into `/app/demo`. The per-visitor throttle was proven by an actual stranger, found via the cert's CT-log entry within minutes. **Open: the CTA points at `qassist.run`, which has no DNS — the signup button is dead, so don't publicise it yet** | US-036, US-007, US-038 |
| [US-038](sprint/current/US-038-staging-environment.md) | Staging environment (`staging.qassist.run`) | 🟢 5/8 (2026-07-25) — **up and serving** on its own LE cert, seeded, WS live view proven; found two shipped bugs (Traefik v3.3 vs Docker 29, and `DEPLOY.md`'s own `ENV_FILE` prefix). **2026-07-26:** Stripe test keys are in, `billing:true`, and two non-operator accounts subscribed through real Checkout with every event applied — but the criterion stays open, because the round trip wrote `current_period_end` NULL (US-051) and the Portal schedules rather than cancels, so the 402 half never ran. The other two still need production, which was deliberately not stood up | US-007 |
| [US-051](sprint/current/done/US-051-subscription-dates-from-stripe.md) | The subscription dates Stripe sends and we don't read | ✅ **Done** 2026-07-26, 9/9, shipped in `v0.2.3` — found and closed the same day. The period end now reads `items.data[0].current_period_end` with the old top-level location as a fallback, and a scheduled cancellation is stored as `cancel_at` (migration `009`) rather than inferred from a boolean that was False on a genuine cancellation. Proven on staging by a real Portal cancel *and* resume: two new event ids, non-NULL period end for the first time, `cancel_at` written then cleared while the period end stood — the asymmetric write rule no fixture could establish. Entitlement deliberately unchanged | US-022 |
| [US-039](sprint/current/done/US-039-byok-only-no-server-key.md) | BYOK only: remove the server `OPENAI_API_KEY` | ✅ Shipped 2026-07-26 — the server key is gone from the product: a run is funded by its caller's key (per-request > stored) or refuses with 503, the scheduler skips keyless owners per slot, and `DATABASE_URL`/`KEY_ENCRYPTION_SECRET` are boot requirements. Assertion-first (`resolveRunKey` is correctness-critical); every spec runs with a live-looking server key in the env to prove the fallback is deleted, not unconfigured. Deployed to staging 2026-07-26 as v0.2.0, AC #6 re-proven on the box | US-005, US-021 |
| [US-052](sprint/current/US-052-staging-branch-continuous-deploy.md) | Staging deploys from a branch, not a release | 🟡 4/7 (2026-07-26) — **the pipeline works.** `staging` branched and pushed; the first build ran the full suite then published `:staging` and `:staging-15e7de3` at one digest in 3m5s, and `:latest` is provably untouched — still the same digest as `:0.2.3`, which is the criterion the tag split exists for. `main` was reconciled into `dev`, but **that first attempt did not take** — found 2026-07-26 while closing US-055: `15e7de3` merged a stale local `main` while `origin/main` had already moved to `32aa949`, so `git merge --ff-only staging` went on aborting. Fixed by `9f07713` (merge `origin/main` into `dev`, fast-forward `staging` onto it, no content change); the `--ff-only` promotion now succeeds. **2026-07-26, on the box:** `.env.staging` moved off `:0.2.3` onto `:staging` (backup at `.env.staging.bak-us053`) and US-053 deployed through it — `pull` then `up -d`, confirmed by digest and by the `org.opencontainers.image.revision` label reading `1c16eb9`, which is the check the mutable tag exists to need. Left: the `:staging-<sha>` rollback, still unexercised | US-032, US-038 |
| [US-053](sprint/current/done/US-053-onboarding-key-then-subscribe.md) | Onboarding: key, then subscribe, before the app | ✅ **Done** 2026-07-26 — on a billing instance an account that has never paid gets the checklist instead of the app, Subscribe is not offered until a key is stored, and a self-host is untouched (no wall, not one `/api/billing` request). `POST /checkout` refuses without a stored key and makes no request to Stripe when it does — assertion-first, reviewed before implementation (`checkout-key-gate.test.js`, correctness-critical). Deployed to staging on revision `1c16eb9` and walked through by hand there. Deliberately deferred: the key is still only shape-checked, never validated against OpenAI, so step 2 goes green for a revoked one | US-021, US-022, US-039, US-036 |
| [US-054](sprint/current/US-054-activation-window-after-subscribe.md) | The activation window: capacity before the first run | 📋 Planned (2026-07-26) — a paid account waits in a stated window (`ACTIVATION_SLA_HOURS`, unset = off) while the operator adds the capacity it just bought. A fourth step on US-053's checklist, an operator-owned sticky `users.activated_at`, a `npm run activate` script on the box, and 503 + `Retry-After` at every run-start path. Correctness-critical: assertion-first, reviewed before implementation. Deliberately no auto-flip at the deadline — a timer would hand the customer a box nobody upgraded | US-022, US-053 |
| [US-055](sprint/current/done/US-055-preview-environment.md) | A preview environment, off to the side of the chain | ✅ **Done** 2026-07-26 — **live**, `preview.qassist.run` on its own LE cert, `noindex`, `billing:false`, its own `pgdata`, built on the box from a `qassist:preview` tag no registry has held. Three loops end to end: a `wip/` branch never on `dev` was previewed, and `up -d` recreated from a new image ID with no tag change and no registry, confirmed by the revision label the build stamps (`dceb6c6` → `d4d4e42` → `41b3516`) — a registry-less image has no other way to say which commit it is. A preview cookie forced onto staging and demo with an explicit `Cookie:` header is 401 on both; a sign-in link for a stranger was printed to the log, not sent. `ci.yml` no longer runs on pushes to `dev`. **Three of the story's own claims were wrong and are corrected in it:** ~2 min is really 2–4 s; `docker image prune` reclaims *nothing* (BuildKit leaves no dangling image — the **build cache** grows, so it is `buildx prune --max-used-space`); and the box always had a working tree, so the new exception is *building*, which is also why preview needs a clone of its own. **The ninth criterion was failing on arrival and not because of preview:** `merge --ff-only staging` into `main` aborted, inherited from US-052's reconciliation having merged a stale local `main`. Fixed in `9f07713` — `origin/main` merged into `dev` for real, `staging` fast-forwarded onto it, no content change, and the promotion verified in a detached worktree rather than by moving `main` | US-038, US-052 |
| [US-008](sprint/current/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | 🧱 2/5 (2026-07-25) — `docs/ci.md`'s script run **verbatim against staging**: suite path, exit 0 green / exit 1 mixed, batching, queueing at cap, `start_url` override honoured. Still owed: module-by-slug, and execution from a real Actions/GitLab runner | US-007, US-009 |
| [US-031](sprint/current/done/US-031-license-and-public-repo.md) | License the code and open the repo | ✅ Shipped (2026-07-25) — AGPL `LICENSE`, DCO, gitleaks clean over all 114 commits, repo public and renamed to `qassist` | — |
| [US-032](sprint/current/US-032-release-pipeline-and-image.md) | CI on every push, a published image on every tag | 🧱 4/5 (2026-07-25) — `v0.1.0` published to ghcr, anonymously pullable; only the run-on-a-clean-machine check left, which lands on the box | US-031 |
| [US-022](sprint/current/done/US-022-stripe-billing.md) | Paid tier: Stripe billing | ✅ Shipped (2026-07-25) — live test-mode round trip still to smoke-test | US-021, US-005, US-007 |
| [US-028](sprint/current/done/US-028-per-user-concurrency-limit.md) | Per-user concurrent run limit (self-host org cap; env-gated) | ✅ Shipped (2026-07-25) | US-021, US-027 |
| [US-005](sprint/current/done/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) — account-stored (encrypted) + per-request | ✅ Shipped (2026-07-25) | US-009 |
| [US-036](sprint/current/done/US-036-demo-sandbox.md) | Demo sandbox: the whole app, per-visitor, on fake data | ✅ Shipped (2026-07-24) | US-021, US-033 engine |
| [US-033](sprint/current/done/US-033-live-demo-replay.md) | Live demo: a canned run that replays as if it were live | ⛔ Superseded by US-036 (2026-07-24) — shell removed | US-006, US-026 |
| [US-021](sprint/current/done/US-021-signup-auth.md) | Signup & login (magic-link auth + per-user API keys) | ✅ Done (2026-07-24) | US-009, US-007 |
| [US-035](sprint/current/done/US-035-run-variables.md) | Per-run variables (environment overrides) | ✅ Shipped (2026-07-24) — PDF display carved to US-020 | US-009 |
| [US-009](sprint/current/done/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done (2026-07-22) | — |
| [US-023](sprint/current/done/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done (2026-07-22) | US-009 |
| [US-006](sprint/current/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done (2026-07-22) — CPU overhead unmeasured | — |
| [US-011](sprint/current/done/US-011-run-history.md) | Run history | ✅ Done (2026-07-22) | US-009 |
| [US-010](sprint/current/done/US-010-scheduled-runs.md) | Scheduled runs | ✅ Done (2026-07-23) | US-009 |
| [US-012](sprint/current/done/US-012-email-reports.md) | Failure email notifications | ✅ Done (2026-07-23) — the real send is now a US-007 criterion | US-009 |
| [US-030](sprint/current/done/US-030-run-permalink.md) | A run has its own page (`/runs/<id>`) | ✅ Done (2026-07-23) | US-011, US-026 |
| [US-013](sprint/current/done/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done | — |
| [US-025](sprint/current/done/US-025-ui-consistency-pass-2.md) | UI consistency pass 2: type scale, sizes, dead space | ✅ Done (2026-07-23) | — |
| [US-026](sprint/current/done/US-026-history-run-activity.md) | Run activity in the History detail panel | ✅ Done (2026-07-23) | US-011 |
| [US-027](sprint/current/done/US-027-queued-run-visibility.md) | Tell the user their run is queued | ✅ Done (2026-07-23) | — |
| [US-034](sprint/current/done/US-034-testing-practice-and-coverage.md) | Testing practice: selective TDD, owed agent/frontend coverage, mutmut audit | ✅ Done (2026-07-24) | — |

**Sprint ordering, resolved 2026-07-25.** The five release-plumbing stories
turned out to reference each other in a circle, and it is worth writing down how
it was cut. US-038 (staging) needs an image to run, because US-007's prod
overlay deliberately cannot build — so it needs US-032. US-032 needs Actions and
ghcr on a public repo, so it needs US-031. And US-031 said "do it last, after
US-007/US-008 have finished editing the docs the public will read" — but
US-008's criterion closes *on staging*. The cut: **US-031 and US-032 go first**,
accepting that `docs/ci.md` may still gain a line after the repo is public,
because a public repo is not a frozen one. The remaining order is US-031 →
US-032 → stand up prod + staging → US-038 and US-008 close together, and the
first ghcr tag promoted through `DEPLOY.md` is itself the promotion rehearsal
US-038 exists for.

Added to the sprint 2026-07-26: **US-040** (deploy the demo at
`demo.qassist.run`). US-036 shipped the entire sandbox on 2026-07-24 and no
deployment sets `AUTH_MODE=demo`, so the provisioner, seeder, run interceptor
and reaper are all dead code today — the story is the gap between built and
live. It is US-038's shape a third time (same two compose files, a different
`-p` and `--env-file`), which is the evidence that shape was right; the
hostname is `demo.` and not `sandbox.` because every identifier the shipped
code already carries says demo. It also turned up the one thing the repo owes
before anything can stand up: `Dockerfile` never copies `demo/`, so a published
tag has no fixtures to replay.

**Repo side done 2026-07-26**: the `COPY demo/` line, `.env.demo.example` and
`DEPLOY.md`'s Demo section. Writing the runbook turned up a second thing the
repo owed, of a different kind — nothing set Express's `trust proxy`, so behind
Traefik `req.ip` was the proxy's address for every request and the demo's per-IP
mint throttle was silently a *deployment-wide* one. The demo would have refused
its sixth visitor of the hour, which is the story's entire purpose failing. Now
`TRUST_PROXY`, off by default because a self-host publishing its own port must
not believe `X-Forwarded-For`; it is a row in
[`correctness-critical.md`](correctness-critical.md) and was done assertion-first,
with the tests confirmed red against the shipped code before the fix existed.
What is left is the box.

Added to the sprint 2026-07-25: **US-038** (staging), the environment three
stories in this sprint were quietly assuming. US-022's live Stripe round trip,
US-008's unverified CI snippet and US-032's "runs on a machine that never saw
the source" all currently end with *verify against production* — and migrations,
which no story owns, get their first populated database the day one goes wrong
on prod. It is deliberately **the same VPS, a second compose project**
(`-p qassist-staging`, its own `pgdata` volume, its own `.env.staging`, a second
Traefik router on the shared proxy): fidelity of the deploy, not capacity, and
US-007's overlay parameterized rather than a second one.

Added to the sprint 2026-07-24: **US-035** (per-run variables) — the one
feature in the sprint beyond the four release-plumbing stories. It pairs with
US-008: CI already overrides `start_url` per environment, and this generalizes
that single override into named variables so one saved test covers dev/staging/
prod instead of being cloned per environment. Its secret-value handling was
assertion-first (redaction). **Shipped 2026-07-24** — backend, agent and UI
(non-secret + secret/optional declaration); the one carve-out is the report
(PDF) display of a run's non-secret variables, moved to US-020, which owns the
report-v2 layout it needs and which gates nothing.

Added to the sprint 2026-07-23: **US-031** and **US-032**, which is what the
narrowing exposed. The product was ready to self-host and the *release* was
not: no LICENSE (so nobody may legally run it), no CI (so nothing but memory
says `dev` is green), and no published image (so `docker compose up` means a
20-minute Chromium build from a repo nobody can see). `docs/repo-model.md`
already said the public repo's CI publishes a versioned image per tagged
release — US-032 is that sentence becoming a workflow.

Added to the sprint 2026-07-23: **US-027**, one half of concurrency being
invisible. `MAX_CONCURRENT_SESSIONS=4` queues everything past the cap, but the
Run view rendered a queued run identically to a starting one. The other half —
a per-user share of the queue ([US-028](sprint/current/done/US-028-per-user-concurrency-limit.md))
— is a no-op until real users exist, and today's single global queue is enough
until then.

Added to the sprint 2026-07-23: **US-026**, so a past run explains itself in
History rather than only in the PDF — the steps are already written to disk,
so it is a read path, not new persistence.

Added to the sprint 2026-07-23: **US-025**, the follow-up to that day's
spacing pass. It is polish, not new scope — but every UI story left in the
sprint inherits the type and size tokens it settles, so it is cheaper before
US-020/US-010/US-012 touch the frontend than after.

### Build order

0. **US-025** — UI consistency pass 2, first: it decides the type and size
   tokens the remaining frontend work will build on. **Shipped 2026-07-23**:
   five type steps (`11/12/13/16/20`, `--t-md` gone), `--col-side` /
   `--rail-strip` / `--scroll-cap` / `--dot` for the sizes that repeat, the
   Run view's activity panel stretched to the frame's height, and a light
   theme — which is what proved the palette really is swappable from `:root`,
   after moving the topbar tint, the modal scrim and `status.js`'s seven
   literal hexes into tokens.
1. **US-009** — foundation: Postgres, saved tests/suites, run APIs (everything
   else in the sprint hangs off it)
2. **US-023** — projects + modules on top of saved tests (pulled ahead
   2026-07-22 at the user's request; US-008 will document module triggering).
   Shipped 2026-07-22, backend and frontend: a `Run` / `Library` split that
   reveals grouping progressively — see the story's UI section.
3. **US-006** — recording (independent of US-009). Shipped 2026-07-22, backend
   and frontend.
4. **US-011** — run history: list endpoint + a third view beside Run and
   Library. Persistence already shipped with US-009, so what is left is the
   endpoint, the UI and artifact retention. **Pulled ahead of US-020 on
   2026-07-22** at the user's request: US-006 already gives the detail panel a
   recording to link and `GET /api/runs/:id` already reports `hasRecording`,
   so only step screenshots still want US-020 — add those to the detail panel
   when it lands. **Shipped 2026-07-22**: `GET /api/runs` with
   test/status/project/module/date filters and pagination, the History view
   (filters, paging, per-test pass/fail timeline, detail panel with PDF and
   recording), and retention — `ARTIFACT_RETENTION_DAYS` (default 7) prunes
   `runs/<id>/` at boot and every 6 h while keeping the history row.
5. **US-026** — **shipped 2026-07-23**, ahead of US-020 rather than inside it:
   `GET /api/runs/:id/steps` over the `report_data.json` the report already
   writes, and the activity list extracted into `Activity.jsx` so the live log
   and the historical one are one component.
6. **US-010** — scheduling on top of saved tests. **Pulled ahead of US-020 on
   2026-07-23** at the user's request: US-020 blocks nothing, while US-010 is
   what US-012 pairs with, so the two halves of unattended testing now sit
   next to each other. **Backend shipped 2026-07-23**: a `schedules` table
   targeting a test, module, suite or project; `src/schedule.js` (preset →
   next slot, via `Intl` so DST and midnight anchoring hold); `src/scheduler.js`
   (60 s tick, claim-then-fire, overlap skip); `/api/schedules` CRUD. **UI
   shipped the same day**: a fourth top-bar view listing every schedule by
   next fire, plus a `?trigger` filter on History so last night's unattended
   runs can be read as a group.
7. **US-012** — failure emails via Resend (pairs with scheduling; do the
   qassist.run SPF/DKIM DNS setup alongside step 8's DNS work). **Shipped
   2026-07-23**: prefs moved off `tests` onto `projects` (a recipient list is
   something a person owns, not something each of twenty tests repeats), one
   mail per finished run, PDF attached, instance-wide signed unsubscribe, and
   a prefs dialog on the project row. Only a send through Resend itself is
   left, which waits on step 8's DNS.
   - **US-030** falls out of it: the mail had no per-run URL to link to, so it
     named a run id and pointed at the app root. **Shipped 2026-07-23**: the
     frontend gained react-router (the four views got addresses alongside
     `/runs/<id>`, with `RunView` kept outside `<Routes>` so the live socket
     survives navigation), `GET /api/runs/:id` now answers in the list shape so
     `RunDetail` renders both History's panel and the page, and the mail links
     straight at the run.
8. **US-007 → US-038 → US-008** — public HTTPS, then staging, then the
   documented CI snippet run for real against *staging* rather than against the
   instance people are using. US-007's DNS visit also verifies the Resend sender
   domain (US-012's one outstanding item) and adds the `staging.` A record in
   the same sitting, so US-038 costs no second trip to the DNS panel.
   **US-007 and US-038's repo halves shipped together on 2026-07-25**, in that
   order and in one sitting, because US-038's premise — staging is the prod
   overlay *parameterized*, not a second one — is a constraint on how US-007's
   overlay is written, and it is cheaper to honour than to retrofit. So the
   overlay took its hostname, image tag, artifact directory, robots header and
   env file from variables from its first line, Traefik became its own compose
   project so one stack's `down` cannot take another's TLS, and staging needed
   no branch anywhere. Both stories stay open: every remaining criterion needs
   the box, and neither is done until it is standing.
9. **US-031 → US-032** — the licence and the public repo, then the CI and the
   published image. Last, and in that order: US-032 wants a public repo for
   free Actions minutes and a ghcr package, and both stories rewrite the README
   a stranger will read, so they are cheaper once US-007 and US-008 have
   finished editing it. Cut `v1.0.0` when US-032's workflow goes green — that
   tag *is* the release.
10. **US-021** — signup & login, pulled in from `sprint/next/` on 2026-07-24.
    **Done 2026-07-24** (magic-link auth, tenant isolation, per-user API keys).
    Code-complete against US-009; still needs US-007 (public HTTPS, open above)
    before the magic-link redirect works over a real domain in production.
11. **US-033** — the live demo replay, pulled in alongside US-021. **Superseded
    by US-036 (2026-07-24)**, which kept its fixture reader + fixtures but replaced
    the rest: the demo is now the whole app run as a per-visitor sandbox, not one
    canned `/demo` clip. US-036 shipped 2026-07-24 and removed the US-033 shell
    (`DemoView`, `/demo` route, the `/ws?demo` branch, `routes/demo.js`, the WS
    `replayDemo`); every demo run is the interceptor's replay instead.
12. **US-022** — Stripe billing, pulled in from `sprint/next/` on 2026-07-25.
    Last in the order and specifically **after US-007**: Stripe posts webhooks to
    a public HTTPS URL, so it cannot be verified end-to-end before the domain is
    up. Its per-user caps read US-028's cap lookup rather than reinventing one,
    and billing gates are the one row in
    [`correctness-critical.md`](correctness-critical.md) that is assertion-first
    from its first line. **Shipped 2026-07-25**, backend and frontend: the gate
    on all seven start paths plus the scheduler's fire, and a Settings panel and
    402 CTA that exist only where `/api/health` says `billing`. What US-007 still
    owes it is the live round trip — a real card through Checkout and a real
    webhook back — which no test here can stand in for. That round trip is now
    **US-038**'s job: it happens on staging in Stripe *test* mode, rather than by
    pointing test keys at the instance real users are on.

**US-027** (queued-run visibility) sat outside this order: it depended on
nothing, and every story above makes the queue busier. **Shipped 2026-07-23**,
straight after US-026 while the Run view was already open: `startNext()` now
tells each waiting run its new position, the position rides the WebSocket as
live-only state (like frames — replaying it would be a stale countdown), and
the Run view has a queued state distinct from "Agent is starting…". US-028
inherits that position and has to keep it honest once the dequeue stops being
strict FIFO.

**US-051 (written into the sprint 2026-07-26)** is a defect, and it is in this
sprint because staging did exactly what US-038 built it to do. The first Stripe
round trip against a real account showed `current_period_end` arriving NULL on
every subscription: Stripe moved the field onto the subscription *item* in API
version `2025-03-31.basil`, and `applySubscriptionEvent` still reads it from the
top level. The gate behind it is US-022's decision 3, so today a `past_due`
customer is cut off on the first failed retry rather than at the end of the
period they paid for. The test suite is green because the webhook fixture we
wrote encodes the shape Stripe stopped sending — which is the reusable lesson: a
fixture is evidence about our parser, never about the wire format. Testing the
cancel path the same day turned up a second instance of it: the Customer Portal
*schedules* a cancellation, and this API version expresses that as a `cancel_at`
timestamp while leaving the `cancel_at_period_end` boolean False. We store
neither, so a customer who has cancelled sees a panel identical to one who has
not. Both gaps share an event, a migration and a panel, so they are one story.
Covered by the existing billing row in
[`correctness-critical.md`](correctness-critical.md); no new row needed.

It also lands on US-038's own scorecard: that story's remaining Stripe criterion
is a round trip proving Checkout → webhook → entitlement, and the round trip we
ran left a column NULL. The criterion is not honestly tickable until this is
fixed and re-run.

**Closed the same day.** The fix shipped in `v0.2.3` and was re-run on staging
through the Customer Portal: cancel, then resume. Both wrote a non-NULL
`current_period_end`; the first stored `cancel_at`, the second cleared it while
leaving the period end standing. That last detail is the one worth keeping —
the two columns are written by deliberately different rules (`cancel_at`
authoritative, `current_period_end` coalesced so an unreadable event cannot cut
every `past_due` customer off at once), and a resume through a real Portal is
the only thing that could demonstrate it. The whole sequence is the argument for
staging in one paragraph: a defect no fixture here could have found, closed by
the environment that found it.

**US-052 (written into the sprint 2026-07-26)** is the bill for that paragraph.
Everything above happened by cutting version tags — `v0.2.1` because the demo
fixtures weren't in the image, `v0.2.2` for the Stripe date, `v0.2.3` because
v0.2.2's release run never reached the build step. None of those were releases;
they were deploys to staging wearing a version number, because a published tag
was the only way to get code onto the box. Each one moved `:latest`, which is
what a self-hoster gets by typing the obvious thing.

The fix is a second transport rather than a rule to follow: `staging` becomes a
branch, a push to it publishes `:staging`, and the box tracks that. `main` then
earns a job it did not have — it holds what staging survived — which also closes
a quiet drift, since `release.yml` says tags are cut from `main` while every
`v0.2.x` tag sits on `dev` and `main` has received nothing since `v0.1.0`. The
rule was right and was skipped because routing through `main` bought nothing.
Give it something to hold and it stops being ceremony.

**US-054 (written into the sprint 2026-07-26)** comes from the constraint the
rest of the sprint has been dancing around: the box is sized to a budget, and
it grows when I resize it by hand. Entitlement currently means "you may run
now", which is a claim about capacity that nothing here is in a position to
make — the second subscriber of a day competes for whatever `MAX_CONCURRENT`
the first one left. The story turns the gap between a cleared card and an
upgraded server into a stated activation window rather than a queued run that
never starts, and gives the operator the hour it actually takes.

It is one condition on the wall US-053 just built, which is why it is cheap:
a fourth checklist step, a sticky operator-owned `activated_at`, a script on
the box, and a 503 that says come back rather than a 402 that says pay again.
Off by default (`ACTIVATION_SLA_HOURS` unset), so no instance acquires a hold
on its next customer as a side effect of ours needing one. The thing it
refuses to do is the interesting half: nothing flips the flag on a timer,
because activating on schedule without having done the work is the failure the
window exists to prevent, performed silently at 3am.

**US-055 (written into the sprint 2026-07-26)** is US-052's remainder. That
story removed the version tag from a deploy; what it left is the merge's own
price — full CI, a Chromium-carrying image build, a push to ghcr and a pull on
the box — charged for every look at a change, including the cosmetic ones. The
price is correct for staging, because replicating production is what makes green
there mean anything. It is simply the wrong loop to iterate in.

So preview does not join the chain, it hangs off it: force-push anything to
`preview`, the box builds it from source and restarts, and nothing ever merges
out. `dev → preview → staging → main` was considered and rejected — it makes the
optional environment mandatory, and puts rewritten history upstream of the
`--ff-only` promotion US-052 exists to guarantee. The keeping-honest constraint
is written into `.env.preview.example` rather than assumed: no Stripe, no real
mail, one session. A preview that acquires those is a second staging, and then
the round trip is back.

The same reasoning ends the CI run on pushes to `dev`. It never gated anything —
`staging.yml` and `release.yml` both run the suite before publishing — so what
it bought was a notification per WIP push, and what it costs is that local
`npm test` stops being optional.

**Closed the same day it was written, 9/9, and it paid for itself twice on the
way.** Three of its own estimates were wrong and are corrected in the story: a
rebuild is 2–4 seconds rather than two minutes; `docker image prune` reclaims
nothing, because BuildKit leaves no dangling image and it is the *build cache*
that grows; and the box already had a working tree, so the exception being
bought is *building*, which is also why preview needs a clone of its own rather
than the shared one three stacks run from. Then the criterion it could most
easily have been blamed for — `merge --ff-only staging` into `main` — turned out
to be failing already, from US-052's reconciliation having merged a stale local
`main`. Preview is the one branch permitted to rewrite history, so it is the one
that could have hidden that; the ancestry check is what proved it had not, and
`9f07713` fixed it.

## Next sprint — `sprint/next/`

Split out of the current sprint on 2026-07-23: the hosted-tier stories plus
the report improvement that was never gating anything. All three hosted-tier
stories have since been pulled back into `sprint/current/` — US-021 and US-033
on 2026-07-24, US-022 on 2026-07-25 — so what remains here is the report v2
polish alone.

Paid-tier ground rules (decided 2026-07-22, still standing): nothing extra
beyond what payment requires. One plan, Stripe Checkout, **BYOK for LLM
tokens** (payment covers hosting, not OpenAI usage). Billing code lives in this
repo **env-gated** (`STRIPE_*` unset = everything free); the full repo/boundary
rules live in [`docs/repo-model.md`](../docs/repo-model.md). Email provider:
**Resend** (US-012, US-021 magic links).

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-020](sprint/next/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned (P2) | US-006 |

### Build order

1. **US-020** — the screenshots, into the report and hanging off a step in
   US-026's activity list. P2 since 2026-07-23: it makes a good report better
   rather than making anything possible, which is also why it left the current sprint.
   Its step section renders `Step {n}`, which is why `progress` events were
   left out of `report_data.json`; revisit that if the section stops being
   step-keyed.

## Unscheduled — `unscheduled/`

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-013](sprint/current/done/US-013-registration-flow-verification.md) | Registration-flow tiers 2 (SMS) + 3 (social) | 📋 Planned | P3 | — |
| [US-029](unscheduled/US-029-cicd-action-and-github-app.md) | CI/CD: reusable Action + GitHub App | 📋 Planned | P2 | US-008 |
| [US-014](unscheduled/US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-015](unscheduled/US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |
| [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |
| [US-024](unscheduled/US-024-memory-watchdog-pss-metric.md) | Memory watchdog: measure PSS, not summed RSS | 📋 Planned | P2 | — |
| [US-037](unscheduled/US-037-enterprise-stack-and-readiness.md) | Enterprise stack & readiness: what to adopt, what to refuse | 📋 Planned (tiered) | P2 | US-021, US-007 |
| [US-041](unscheduled/US-041-judge-verdict-and-ground-truth.md) | The judge decides the verdict, and a test can state what it must prove | 📋 Planned | P1 | — |
| [US-042](unscheduled/US-042-agent-navigation-confinement.md) | Confine where the agent may navigate | 📋 Planned | P1 | US-021 |
| [US-043](unscheduled/US-043-reusable-authenticated-sessions.md) | Test what is behind the login (reusable sessions) | 📋 Planned | P2 | US-035, US-021 |
| [US-044](unscheduled/US-044-network-and-console-evidence.md) | Say *why* it failed: network and console evidence | 📋 Planned | P2 | US-020, US-026 |
| [US-045](unscheduled/US-045-model-provider-choice.md) | Bring your own key, to your own provider (incl. local) | 📋 Planned | P2 | US-005, US-039 |
| [US-046](unscheduled/US-046-token-usage-and-cost.md) | What did that run cost? (token usage + cost) | 📋 Planned | P3 | US-039 |
| [US-047](unscheduled/US-047-stop-a-run.md) | Stop a run | 📋 Planned | P3 | — |
| [US-048](unscheduled/US-048-file-upload-in-test-flows.md) | Test a flow that uploads a file | 📋 Planned | P3 | US-035, US-023 |
| [US-049](unscheduled/US-049-typed-assertions.md) | Assert on a value, not on a paragraph | 📋 Planned | P3 | US-041 |
| [US-050](unscheduled/US-050-fast-run-mode.md) | A fast, cheap mode for tests that already pass | 📋 Planned | P3 | US-046 |

A tiered story keeps one file while its later tiers are still hypothetical:
US-013's email tier shipped, so the file sits in `sprint/current/done/` with the
SMS and social tiers recorded inside it. It gets split once the out-of-scope
tiers are real enough to plan, which is what happened to **US-008 on
2026-07-23** — two of its three tiers were work the current sprint does not owe, and a
story whose acceptance criteria are mostly out of scope makes `ls sprint/current/`
overstate what is left. US-008 is now the CI step alone; [US-029](unscheduled/US-029-cicd-action-and-github-app.md)
carries the Action and the App.

**US-041..US-050 (added 2026-07-26)** came out of one question — *what is
browser-use already capable of that we do not use?* — answered by reading the
installed 0.13.6 against `agent/run_agent.py` rather than the docs. They are
unscheduled on purpose: the current sprint is release plumbing, and this is
product. Two of them are P1 and are pull-forward candidates the moment the
sprint clears.

The headline is **US-041**, which is closer to a defect than a feature.
`Agent(use_judge=…)` defaults to `True` and we never override it, so every run
already pays for a vision-heavy judge call over the trace and the last ten
screenshots — and then reports `history.is_successful()`, which is the *agent's
self-report*, and drops the judgement on the floor. browser-use is explicit that
the two are separate values and that the judge deliberately does not override
the self-report. So the product's leading claim ("judges pass/fail") is
currently the agent grading its own homework, at the cost of a judge call we buy
and discard. `ground_truth` — per-test acceptance criteria the judge grades
against — is the feature that follows from fixing it, and it is what turns a
goal into a specification.

**US-042** is the one with a security shape. `BrowserProfile` carries
`allowed_domains`, `prohibited_domains` and `block_ip_addresses` (default
`False`), enforced by a `SecurityWatchdog` that is written to survive redirect
chains; we pass none of them, and `POST /api/runs` checks `start_url` for
presence only. Note what this is *not*: the demo is unaffected, because
US-036's interceptor replays a fixture for every trigger path and never launches
Chromium. The exposure is the ordinary multi-user instance — staging is publicly
registrable today. US-039 raises the bar considerably (an attacker must bring
and spend their own key), which is why this is P1-unscheduled rather than a
hotfix, but funding is not a fence.

The rest, briefly: **US-043** (`storage_state`) is the largest expansion of what
the product can test, because most software worth testing is behind a login and
every run currently logs in from cold. **US-044** turns "the goal failed" into
"the goal failed and `POST /api/checkout` returned 500", off CDP subscriptions
the screencast machinery already makes cheap. **US-045** notices that having
just made BYOK the only funding path (US-039), *which* provider is the obvious
next question — and that `ChatOllama` makes a fully-local instance a claim no
competitor can match. **US-047** is a plain absence: there is no stop endpoint
anywhere in `server/src`, so a user watching a run go wrong can only wait, and
the only kill we have is the watchdog's `SIGKILL`, which destroys the recording
it was about to finalize.

Three of these owe rows in [`correctness-critical.md`](correctness-critical.md)
when scheduled — US-041 and US-049 define what "pass" means, US-042 is a fence
that is worse than useless if it is believed and leaky. Rows are deliberately
*not* added yet: the register's own rule is that a row is added as part of doing
the work, and a table of speculative rows is what makes it stop being read.

**US-037 (added 2026-07-25)** is a decision as much as a story: it settles which
"enterprise standard" stack pieces we adopt and — more usefully — which we
refuse, on the premise that what blocks an enterprise deal is SSO, an audit log,
RBAC and a security questionnaire, none of which are framework choices. Its
tiers 1–3 (observability, Zod at the boundary, audit log + RBAC) are additive to
today's stack and need no migration; tier 4 (TypeScript) is the only rewrite and
would rewrite a **Stack decisions (settled)** line in `CLAUDE.md`; tier 5 (SSO/
SCIM) waits for a named customer and is env-gated like Stripe. Tiers 3 and 5 are
assertion-first and owe rows in [`correctness-critical.md`](correctness-critical.md)
when scheduled.

**Desktop track (US-016..019, sketched 2026-07-21, on hold):** candidate
strategy — free version runs entirely on the user's machine (their CPU/RAM,
their OpenAI key), hosted features become the paid tier. Not prioritized yet;
decision deferred. If picked up: US-016 → US-017 → US-018 → US-019, Windows
before macOS, and `server.js` stays dual-mode (container + Electron) — never
fork it. US-018 would realize US-005 (BYOK) on desktop.

## Released — `released/`

### `released/prototype/` (shipped 2026-07-21)

| ID | Story | Outcome |
|---|---|---|
| [US-001](released/prototype/US-001-chromium-memory-flags.md) | Reduce per-session Chromium memory | ✅ Done |
| [US-002](released/prototype/US-002-viewer-gated-screencast.md) | Viewer-gated live screencast | ✅ Done |
| [US-004](released/prototype/US-004-per-run-memory-watchdog.md) | Per-run memory watchdog | ✅ Done |
| [US-003](released/prototype/US-003-drop-per-step-screenshots.md) | Stop saving per-step screenshots | ❌ Superseded by US-020 (report now uses them) |

## Conventions

- File name: `US-NNN-short-slug.md`; never reuse an ID, even across folders.
- Header: user story sentence, then Status / Priority / Estimate / Depends on.
- Body: Details, Acceptance criteria (checkboxes), plus Results/Tradeoffs for
  finished work. Record measured numbers — they drive sizing decisions.
- Moving a story between folders is a `git mv` + README table update. Finish a
  story ⇒ same commit moves it into `sprint/<name>/done/` and flips its Status.
- Fix relative links after a move: links between stories in the same sprint
  cross the `done/` boundary (`done/US-0xx-….md` from the root, `../US-0xx-….md`
  from inside `done/`).
