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

## Release 1 (first public release) — `release-1/`

Scope decided 2026-07-22, **extended 2026-07-22 to include the hosted paid
tier**: Release 1 ships both (a) the open-source self-host release — report
with recording + step screenshots, saved tests, run history, scheduling,
failure email notifications, CI trigger, registration-flow email
confirmation (already done) — and (b) a minimal paid hosted version at
qassist.run:
signup, Stripe subscription, BYOK. US-007 rides along as a hard dependency
of US-008 and of the hosted tier.

Paid-tier ground rules (2026-07-22): nothing extra beyond what payment
requires. One plan, Stripe Checkout, **BYOK for LLM tokens** (payment covers
hosting, not OpenAI usage). Billing code lives in this repo **env-gated**
(`STRIPE_*` unset = everything free) — the private cloud repo is deferred
until real cloud-only infra exists; the full repo/boundary rules live in
[`docs/repo-model.md`](../docs/repo-model.md). Email provider: **Resend**
(US-012, US-021 magic links).

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-009](release-1/done/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done (2026-07-22) | — |
| [US-023](release-1/done/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done (2026-07-22) | US-009 |
| [US-006](release-1/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done (2026-07-22) — CPU overhead unmeasured | — |
| [US-020](release-1/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned (P2, last in the release) | US-006 |
| [US-011](release-1/done/US-011-run-history.md) | Run history | ✅ Done (2026-07-22) | US-009 |
| [US-010](release-1/done/US-010-scheduled-runs.md) | Scheduled runs | ✅ Done (2026-07-23) | US-009 |
| [US-012](release-1/US-012-email-reports.md) | Failure email notifications | 📋 Planned | US-009 |
| [US-007](release-1/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy | 📋 Planned | domain (owned) |
| [US-008](release-1/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | 📋 Planned | US-007, US-009 |
| [US-005](release-1/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) | 📋 Planned | — |
| [US-021](release-1/US-021-signup-auth.md) | Signup & login (magic-link auth) | 📋 Planned | US-009, US-007 |
| [US-022](release-1/US-022-stripe-billing.md) | Paid tier: Stripe billing | 📋 Planned | US-021, US-005 |
| [US-013](release-1/done/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done | — |
| [US-025](release-1/done/US-025-ui-consistency-pass-2.md) | UI consistency pass 2: type scale, sizes, dead space | ✅ Done (2026-07-23) | — |
| [US-026](release-1/done/US-026-history-run-activity.md) | Run activity in the History detail panel | ✅ Done (2026-07-23) | US-011 |
| [US-027](release-1/done/US-027-queued-run-visibility.md) | Tell the user their run is queued | ✅ Done (2026-07-23) | — |
| [US-028](release-1/US-028-per-user-concurrency-limit.md) | Per-user concurrent run limit (hosted) | 📋 Planned | US-021, US-022, US-027 |

Added to the release 2026-07-23: **US-027** and **US-028**, the two halves of
concurrency being invisible. `MAX_CONCURRENT_SESSIONS=4` queues everything past
the cap, but the Run view renders a queued run identically to a starting one
(US-027), and the queue is global with no per-user share, so one user's module
run can take the whole worker (US-028 — the fair-use item US-022 already flags,
split out so billing can ship without it). US-028 is hosted-only and env-gated;
self-host keeps today's single global queue.

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
   qassist.run SPF/DKIM DNS setup alongside step 8's DNS work)
8. **US-007 → US-008** — public HTTPS, then the documented CI snippet
9. **US-005** — BYOK, before anyone but the operator can run tests
10. **US-021 → US-022 → US-028** — signup, then billing, then the per-user
    concurrency cap; launch when US-022 lands (US-028 can follow the launch —
    it only bites once several subscribers share the box)
11. **US-020** — the screenshots, into the report and hanging off a step in
    US-026's activity list. Dropped to P2 on 2026-07-23: it makes a good
    report better rather than making anything possible. Its step section
    renders `Step {n}`, which is why `progress` events were left out of
    `report_data.json`; revisit that if the section stops being step-keyed.

**US-027** (queued-run visibility) sat outside this order: it depended on
nothing, and every story above makes the queue busier. **Shipped 2026-07-23**,
straight after US-026 while the Run view was already open: `startNext()` now
tells each waiting run its new position, the position rides the WebSocket as
live-only state (like frames — replaying it would be a stale countdown), and
the Run view has a queued state distinct from "Agent is starting…". US-028
inherits that position and has to keep it honest once the dequeue stops being
strict FIFO.

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
