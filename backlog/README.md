# Backlog

One file per user story. Status lives in each file's header; this README is
the overview (keep it in sync when a story changes state or moves folder).

## Folder layout

- `release-1/` … `release-N/` — stories scoped to that upcoming release. The
  lowest-numbered folder is the one being worked on.
- `release-N/done/` — stories in that release that are finished. **What sits
  in the release folder itself is exactly the work left to do**, so a glance
  at `ls release-1/` answers "what's still open?". Move a story here (`git mv`
  + README table update) the moment it ships, not at release time. A tiered
  story moves once the tier that this release owes is done, even if later
  tiers stay planned in its file.
- `unscheduled/` — stories with no release assigned yet.
- `released/<name>/` — shipped releases, moved here wholesale when the release
  goes out (e.g. `released/prototype/`), `done/` subfolder and all. Anything
  still sitting in the release folder root at that point never shipped: move
  it into the next release folder (or `unscheduled/`) before the `git mv`, so
  a released folder only ever contains finished work. A story with follow-up
  tiers left over gets those spun into a new story in `unscheduled/`.

## Release 1 (the open-source self-host release) — `release-1/`

Scope decided 2026-07-22, extended the same day to include the hosted paid
tier, and **narrowed back on 2026-07-23: Release 1 is the self-host release
alone.** Saved tests, projects and modules, recording, run history,
scheduling, failure emails and run permalinks are all shipped; what is left is
not a feature at all but the four stories that turn a working app into a
release someone else can run — public HTTPS (US-007), a CI snippet proven
against it (US-008), a licence on a public repo (US-031), and a tested,
published image (US-032).

Why the split: everything still open in the release was **hosted**-tier work
(signup, Stripe, BYOK, per-user concurrency) plus one report improvement, and
none of it is what a self-hoster is waiting on. Holding the free release until
billing works would ship it months late for no self-hoster's benefit. The
hosted tier keeps its decisions and its stories intact — they move together
into [Release 2](#release-2-the-hosted-paid-tier--release-2).

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-007](release-1/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy (and the Resend sender domain) | 📋 Planned | domain (owned) |
| [US-008](release-1/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | 📝 Docs written, unverified | US-007, US-009 |
| [US-031](release-1/US-031-license-and-public-repo.md) | License the code and open the repo | 📋 Planned | — |
| [US-032](release-1/US-032-release-pipeline-and-image.md) | CI on every push, a published image on every tag | 📋 Planned | US-031 |
| [US-009](release-1/done/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done (2026-07-22) | — |
| [US-023](release-1/done/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done (2026-07-22) | US-009 |
| [US-006](release-1/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done (2026-07-22) — CPU overhead unmeasured | — |
| [US-011](release-1/done/US-011-run-history.md) | Run history | ✅ Done (2026-07-22) | US-009 |
| [US-010](release-1/done/US-010-scheduled-runs.md) | Scheduled runs | ✅ Done (2026-07-23) | US-009 |
| [US-012](release-1/done/US-012-email-reports.md) | Failure email notifications | ✅ Done (2026-07-23) — the real send is now a US-007 criterion | US-009 |
| [US-030](release-1/done/US-030-run-permalink.md) | A run has its own page (`/runs/<id>`) | ✅ Done (2026-07-23) | US-011, US-026 |
| [US-013](release-1/done/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done | — |
| [US-025](release-1/done/US-025-ui-consistency-pass-2.md) | UI consistency pass 2: type scale, sizes, dead space | ✅ Done (2026-07-23) | — |
| [US-026](release-1/done/US-026-history-run-activity.md) | Run activity in the History detail panel | ✅ Done (2026-07-23) | US-011 |
| [US-027](release-1/done/US-027-queued-run-visibility.md) | Tell the user their run is queued | ✅ Done (2026-07-23) | — |

Added to the release 2026-07-23: **US-031** and **US-032**, which is what the
narrowing exposed. The product was ready to self-host and the *release* was
not: no LICENSE (so nobody may legally run it), no CI (so nothing but memory
says `dev` is green), and no published image (so `docker compose up` means a
20-minute Chromium build from a repo nobody can see). `docs/repo-model.md`
already said the public repo's CI publishes a versioned image per tagged
release — US-032 is that sentence becoming a workflow.

Added to the release 2026-07-23: **US-027**, one half of concurrency being
invisible. `MAX_CONCURRENT_SESSIONS=4` queues everything past the cap, but the
Run view rendered a queued run identically to a starting one. The other half —
a per-user share of the queue ([US-028](release-2/US-028-per-user-concurrency-limit.md))
— went to Release 2 with the hosted tier: it is a no-op until real users exist,
and self-host keeps today's single global queue.

Added to the release 2026-07-23: **US-026**, so a past run explains itself in
History rather than only in the PDF — the steps are already written to disk,
so it is a read path, not new persistence.

Added to the release 2026-07-23: **US-025**, the follow-up to that day's
spacing pass. It is polish, not new scope — but every UI story left in the
release inherits the type and size tokens it settles, so it is cheaper before
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
   else in the release hangs off it)
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
8. **US-007 → US-008** — public HTTPS, then the documented CI snippet run for
   real against it. US-007's DNS visit also verifies the Resend sender domain,
   which is US-012's one outstanding item.
9. **US-031 → US-032** — the licence and the public repo, then the CI and the
   published image. Last, and in that order: US-032 wants a public repo for
   free Actions minutes and a ghcr package, and both stories rewrite the README
   a stranger will read, so they are cheaper once US-007 and US-008 have
   finished editing it. Cut `v1.0.0` when US-032's workflow goes green — that
   tag *is* the release.

**US-027** (queued-run visibility) sat outside this order: it depended on
nothing, and every story above makes the queue busier. **Shipped 2026-07-23**,
straight after US-026 while the Run view was already open: `startNext()` now
tells each waiting run its new position, the position rides the WebSocket as
live-only state (like frames — replaying it would be a stale countdown), and
the Run view has a queued state distinct from "Agent is starting…". US-028
inherits that position and has to keep it honest once the dequeue stops being
strict FIFO.

## Release 2 (the hosted paid tier) — `release-2/`

Split out of Release 1 on 2026-07-23, unchanged in content: the four hosted
stories plus the report improvement that was never gating anything. Release 1
ships the app; Release 2 turns it into a service other people pay for at
qassist.run.

Paid-tier ground rules (decided 2026-07-22, still standing): nothing extra
beyond what payment requires. One plan, Stripe Checkout, **BYOK for LLM
tokens** (payment covers hosting, not OpenAI usage). Billing code lives in this
repo **env-gated** (`STRIPE_*` unset = everything free) — the private cloud
repo is deferred until real cloud-only infra exists; the full repo/boundary
rules live in [`docs/repo-model.md`](../docs/repo-model.md). Email provider:
**Resend** (US-012, US-021 magic links).

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-005](release-2/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) | 📋 Planned | — |
| [US-021](release-2/US-021-signup-auth.md) | Signup & login (magic-link auth) | 📋 Planned | US-009, US-007 |
| [US-022](release-2/US-022-stripe-billing.md) | Paid tier: Stripe billing | 📋 Planned | US-021, US-005 |
| [US-028](release-2/US-028-per-user-concurrency-limit.md) | Per-user concurrent run limit (hosted) | 📋 Planned | US-021, US-022, US-027 |
| [US-033](release-2/US-033-live-demo-replay.md) | Live demo: a canned run that replays as if it were live | 📋 Planned (P2) | US-006, US-026 |
| [US-020](release-2/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned (P2) | US-006 |

Added to the release 2026-07-23: **US-033**, because "try before you
subscribe" has no cheap answer otherwise. A real free trial spends a browser
slot and LLM tokens per visitor, and BYOK (US-005) puts an API key in front of
the evaluation anyway. The live stage is already fed by an event stream rather
than by the agent, so a recorded run replayed at its original pace costs
nothing per visitor — the story's work is mostly about keeping it honest and
keeping it out of the database.

### Build order

1. **US-005** — BYOK, before anyone but the operator can run tests
2. **US-021 → US-022 → US-028** — signup, then billing, then the per-user
   concurrency cap; launch when US-022 lands (US-028 can follow the launch —
   it only bites once several subscribers share the box)
3. **US-033** — the demo, beside US-022 rather than before it: it depends on
   neither signup nor billing technically, but the replay ends on a "subscribe"
   CTA that has nowhere to point until there is something to buy. Record the
   fixtures earlier if convenient — they only need US-006, which shipped.
4. **US-020** — the screenshots, into the report and hanging off a step in
   US-026's activity list. P2 since 2026-07-23: it makes a good report better
   rather than making anything possible, which is also why it left Release 1.
   Its step section renders `Step {n}`, which is why `progress` events were
   left out of `report_data.json`; revisit that if the section stops being
   step-keyed.

US-020 is the odd one out here — it is self-host work sitting in the hosted
release, kept because P2 polish shouldn't hold the free launch and it is the
next thing worth doing once it doesn't. Move it forward if a self-hoster asks
for it before the hosted tier is real.

## Unscheduled — `unscheduled/`

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-013](release-1/done/US-013-registration-flow-verification.md) | Registration-flow tiers 2 (SMS) + 3 (social) | 📋 Planned | P3 | — |
| [US-029](unscheduled/US-029-cicd-action-and-github-app.md) | CI/CD: reusable Action + GitHub App | 📋 Planned | P2 | US-008 |
| [US-014](unscheduled/US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-015](unscheduled/US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |
| [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |
| [US-024](unscheduled/US-024-memory-watchdog-pss-metric.md) | Memory watchdog: measure PSS, not summed RSS | 📋 Planned | P2 | — |

A tiered story keeps one file while its later tiers are still hypothetical:
US-013's email tier shipped, so the file sits in `release-1/done/` with the
SMS and social tiers recorded inside it. It gets split once the out-of-scope
tiers are real enough to plan, which is what happened to **US-008 on
2026-07-23** — two of its three tiers were work Release 1 does not owe, and a
story whose acceptance criteria are mostly out of scope makes `ls release-1/`
overstate what is left. US-008 is now the CI step alone; [US-029](unscheduled/US-029-cicd-action-and-github-app.md)
carries the Action and the App.

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
  story ⇒ same commit moves it into `release-N/done/` and flips its Status.
- Fix relative links after a move: links between stories in the same release
  cross the `done/` boundary (`done/US-0xx-….md` from the root, `../US-0xx-….md`
  from inside `done/`).
