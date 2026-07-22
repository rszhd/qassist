# Backlog

One file per user story. Status lives in each file's header; this README is
the overview (keep it in sync when a story changes state or moves folder).

## Folder layout

- `release-1/` … `release-N/` — stories scoped to that upcoming release. The
  lowest-numbered folder is the one being worked on.
- `unscheduled/` — stories with no release assigned yet.
- `released/<name>/` — shipped releases, moved here wholesale when the release
  goes out (e.g. `released/prototype/`). A story with follow-up tiers left
  over gets those spun into a new story in `unscheduled/` at that point.

## Release 1 (first public release) — `release-1/`

Scope decided 2026-07-22, **extended 2026-07-22 to include the hosted paid
tier**: Release 1 ships both (a) the open-source self-host release — report
with recording + step screenshots, saved tests, run history, scheduling,
failure email notifications, CI trigger (tier 1), registration-flow email
confirmation (already done) — and (b) a minimal paid hosted version at
qassist.run:
signup, Stripe subscription, BYOK. US-007 rides along as a hard dependency
of US-008 tier 1 and of the hosted tier.

Paid-tier ground rules (2026-07-22): nothing extra beyond what payment
requires. One plan, Stripe Checkout, **BYOK for LLM tokens** (payment covers
hosting, not OpenAI usage). Billing code lives in this repo **env-gated**
(`STRIPE_*` unset = everything free) — the private cloud repo is deferred
until real cloud-only infra exists; the full repo/boundary rules live in
[`docs/repo-model.md`](../docs/repo-model.md). Email provider: **Resend**
(US-012, US-021 magic links).

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-009](release-1/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done (2026-07-22) | — |
| [US-023](release-1/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done (2026-07-22) | US-009 |
| [US-006](release-1/US-006-session-recording.md) | Session recording (record by default) | ✅ Done (2026-07-22) — CPU overhead unmeasured | — |
| [US-020](release-1/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned | US-006 |
| [US-011](release-1/US-011-run-history.md) | Run history | ✅ Done (2026-07-22) | US-009 |
| [US-010](release-1/US-010-scheduled-runs.md) | Scheduled runs | 📋 Planned | US-009 |
| [US-012](release-1/US-012-email-reports.md) | Failure email notifications | 📋 Planned | US-009 |
| [US-007](release-1/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy | 📋 Planned | domain (owned) |
| [US-008](release-1/US-008-cicd-integration.md) | CI/CD trigger — tier 1 only | 📋 Planned | US-007, US-009 |
| [US-005](release-1/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) | 📋 Planned | — |
| [US-021](release-1/US-021-signup-auth.md) | Signup & login (magic-link auth) | 📋 Planned | US-009, US-007 |
| [US-022](release-1/US-022-stripe-billing.md) | Paid tier: Stripe billing | 📋 Planned | US-021, US-005 |
| [US-013](release-1/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done | — |

### Build order

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
5. **US-020** — report v2: the report that embeds step screenshots + the
   recording link.
6. **US-010** — scheduling on top of saved tests
7. **US-012** — failure emails via Resend (pairs with scheduling; do the
   qassist.run SPF/DKIM DNS setup alongside step 8's DNS work)
8. **US-007 → US-008 tier 1** — public HTTPS, then the documented CI snippet
9. **US-005** — BYOK, before anyone but the operator can run tests
10. **US-021 → US-022** — signup, then billing; launch when US-022 lands

## Unscheduled — `unscheduled/`

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-013](release-1/US-013-registration-flow-verification.md) | Registration-flow tiers 2 (SMS) + 3 (social) | 📋 Planned | P3 | — |
| [US-008](release-1/US-008-cicd-integration.md) | CI/CD tiers 2 (reusable Action) + 3 (GitHub App) | 📋 Planned | P2 | US-008 t1 |
| [US-014](unscheduled/US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-015](unscheduled/US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |
| [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |
| [US-024](unscheduled/US-024-memory-watchdog-pss-metric.md) | Memory watchdog: measure PSS, not summed RSS | 📋 Planned | P2 | — |

Tiered stories (US-008, US-013) live in `release-1/` because their next tier
ships there; the later tiers listed above are unscheduled follow-ups.

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
- Moving a story between folders is a `git mv` + README table update.
