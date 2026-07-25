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
| [US-038](sprint/current/US-038-staging-environment.md) | Staging environment (`staging.qassist.run`) | 🧱 Repo side shipped (2026-07-25) — needed no overlay branch; DNS + the box left | US-007 |
| [US-008](sprint/current/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | 📝 Docs written, unverified | US-007, US-009 |
| [US-031](sprint/current/done/US-031-license-and-public-repo.md) | License the code and open the repo | ✅ Shipped (2026-07-25) — AGPL `LICENSE`, DCO, gitleaks clean over all 114 commits, repo public and renamed to `qassist` | — |
| [US-032](sprint/current/US-032-release-pipeline-and-image.md) | CI on every push, a published image on every tag | 🧱 CI green, release path unexercised (2026-07-25) — `ci.yml` passing on `dev`; no tag cut, nothing on ghcr | US-031 |
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

A tiered story keeps one file while its later tiers are still hypothetical:
US-013's email tier shipped, so the file sits in `sprint/current/done/` with the
SMS and social tiers recorded inside it. It gets split once the out-of-scope
tiers are real enough to plan, which is what happened to **US-008 on
2026-07-23** — two of its three tiers were work the current sprint does not owe, and a
story whose acceptance criteria are mostly out of scope makes `ls sprint/current/`
overstate what is left. US-008 is now the CI step alone; [US-029](unscheduled/US-029-cicd-action-and-github-app.md)
carries the Action and the App.

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
