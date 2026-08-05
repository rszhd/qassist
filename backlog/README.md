# Backlog

One file per user story. **The story file is where results live** — what
shipped, what it cost, what it turned up, what was deferred. This README is the
overview, and it answers three questions only: what is open, what depends on
what, and why the sprint is shaped the way it is. Keep it in sync when a story
changes state or moves folder, but don't restate a story's results here; that
copy goes stale, and the story file is one click away.

**A finished row is a verdict and a date.** Not a paragraph. This file has
regrown after every cut (`CLAUDE.md` holds the history), because every append
is locally reasonable and none can see the file it is landing in — the same
failure that broke [`correctness-critical.md`](correctness-critical.md).
Re-read the whole file before appending to it, and check the tables still
render.

Two root-level files are **not** stories but living reference docs that sit
here because they track the backlog as a whole: this README, and
[`correctness-critical.md`](correctness-critical.md) — the register of
correctness-critical, easy-to-get-subtly-wrong surfaces the assertion-first
Workflow rule (`CLAUDE.md`) applies to.

## Folder layout

- `sprint/current/` — stories scoped to the sprint being worked on now.
- `sprint/next/` — stories queued for the sprint after this one. Created when
  the next sprint is planned; none exists right now (git does not track an
  empty folder).
- `sprint/<name>/done/` — stories in that sprint that are finished. **What sits
  in the sprint folder itself is exactly the work left to do**, so a glance
  at `ls sprint/current/` answers "what's still open?". Move a story here (`git mv`
  + README table update) the moment it ships, not at sprint's end. A tiered
  story moves once the tier that this sprint owes is done, even if later
  tiers stay planned in its file.
- `unscheduled/` — stories with no sprint assigned yet.
- `bugs/` — defects, `BUG-NNN-slug.md`, for a fault in shipped code that isn't
  a story's worth of work. Same lifecycle as a story, and that includes the
  move: a fixed bug is `git mv`d into the `sprint/<name>/done/` of the sprint
  that fixed it, so **`ls bugs/` is exactly the open defects** the way
  `ls sprint/current/` is exactly the open stories. Its row stays in the Bugs
  table below — that table is the register, and a fixed defect is worth finding
  from it — so only the row's link changes.
- `released/<name>/` — shipped releases, moved here wholesale when the release
  goes out, `done/` subfolder and all (`released/prototype/` predates the
  `done/` convention and is flat). Anything
  still sitting in the sprint folder root at that point never shipped: move
  it into `sprint/next/` (or `unscheduled/`) before the `git mv`, so
  a released folder only ever contains finished work. A story with follow-up
  tiers left over gets those spun into a new story in `unscheduled/`.

## Current sprint — `sprint/current/`

Scope decided 2026-07-22, extended the same day to include the hosted paid
tier, then **narrowed on 2026-07-23 to the release-plumbing stories** once
saved tests, projects and modules, recording, run history, scheduling, failure
emails and run permalinks had all shipped: what was left was the stories that
turn a working app into a release someone else can run. It has since widened
back out to product work, story by story, as the plumbing stopped needing
attention.

Sprints aren't split along a self-host/hosted-tier line — `sprint/current/` and
`sprint/next/` are just now vs. later, reprioritized as needed.

### Open

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-056](sprint/current/US-056-production-deployment.md) | Production deployment: `app.qassist.run` goes live | 🔨 **Live** 2026-07-29 on `v0.3.0`, 4/10 — the rest need a sign-in, live Stripe keys, or a decision | US-007, US-038, US-052 |
| [US-020](sprint/current/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned — P2 | US-006 |
| [US-070](sprint/current/US-070-user-manual-site.md) | A user manual, published without an image build (`docs.qassist.run`) | 🔨 **Live** 2026-08-05, 9/11 — follows `main` since 2026-08-06 | US-007, US-055 |
| [US-071](sprint/current/US-071-one-command-deploy.md) | One command deploys a stack, and proves which one it deployed | 📋 Planned — P1 | US-052, US-055, US-056 |

### Done

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-074](sprint/current/done/US-074-run-agent-pure-logic-extracted.md) | `run_agent.py`: move the pure logic where the tests can reach it | ✅ **Done** 2026-08-05, 6/6 | — |
| [US-073](sprint/current/done/US-073-typed-run-and-ndjson-events.md) | Type the run object and the NDJSON events | ✅ **Done** 2026-08-05, 5/5 | — |
| [US-075](sprint/current/done/US-075-orchestrators-split-along-seams.md) | The two run orchestrators shrink to their subject | ✅ **Done** 2026-08-05, 4/4 | US-073 (shipped without it) |
| [US-024](sprint/current/done/US-024-memory-watchdog-pss-metric.md) | Memory watchdog: measure PSS, not summed RSS | ✅ **Done** 2026-08-05, 4/4 | — |
| [US-066](sprint/current/done/US-066-chrome-web-store-listing.md) | List the session-capture extension on the Chrome Web Store | ✅ **Live** 2026-08-04, 6/6 | US-063 |
| [US-069](sprint/current/done/US-069-schedule-health-strip.md) | The last few nights, at a glance (pass/fail strip on the Schedules row) | ✅ **Done** 2026-08-04, 11/12 | US-010, US-011 |
| [US-057](sprint/current/done/US-057-html-email-template.md) | An HTML template for outgoing email | ✅ **Done** 2026-08-04, 5/5 | — |
| [US-067](sprint/current/done/US-067-mobile-app-view.md) | The app on a phone | ✅ **Done** 2026-08-03, 8/8 | US-025, US-030 |
| [US-063](sprint/current/done/US-063-capture-a-session-without-a-terminal.md) | Capture a session without a terminal (browser extension) | ✅ **Shipped** 2026-07-31 | US-043, US-021 |
| [US-064](sprint/current/done/US-064-secret-variables-in-a-scheduled-run.md) | Secret variables in a scheduled run | ✅ **Done** 2026-07-28, 8/8 | US-035, US-010, US-043 |
| [US-042](sprint/current/done/US-042-agent-navigation-confinement.md) | Confine where the agent may navigate | ✅ **Done** 2026-07-27, 5/6 | US-021 |
| [US-058](sprint/current/done/US-058-per-user-concurrency-override.md) | Raise one user's concurrency cap without raising everyone's | ✅ **Done** 2026-07-27, 9/9 | US-028, US-021 |
| [US-048](sprint/current/done/US-048-file-upload-in-test-flows.md) | Test a flow that uploads a file | ✅ **Done** 2026-07-27, 5/5 | US-035, US-023 |
| [US-043](sprint/current/done/US-043-reusable-authenticated-sessions.md) | Test what is behind the login (reusable sessions) | ✅ **Done** 2026-07-27, 6/6 | US-035, US-021 |
| [US-044](sprint/current/done/US-044-network-and-console-evidence.md) | Say *why* it failed: network and console evidence | ✅ **Done** 2026-07-27, 6/6 | US-026 |
| [US-047](sprint/current/done/US-047-stop-a-run.md) | Stop a run | ✅ **Done** 2026-07-27, 6/6 | — |
| [US-040](sprint/current/done/US-040-demo-deployment.md) | Deploy the demo sandbox at `demo.qassist.run` | ✅ **Done** 2026-07-26, 11/11 — live on `0.3.0` | US-036, US-007, US-038 |
| [US-007](sprint/current/done/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy (and the Resend sender domain) | ✅ **Closed** 2026-07-26 | domain (owned) |
| [US-038](sprint/current/done/US-038-staging-environment.md) | Staging environment (`staging.qassist.run`) | ✅ **Closed** 2026-07-26, 6/8 | US-007 |
| [US-051](sprint/current/done/US-051-subscription-dates-from-stripe.md) | The subscription dates Stripe sends and we don't read | ✅ **Done** 2026-07-26, 9/9, shipped in `v0.2.3` | US-022 |
| [US-052](sprint/current/done/US-052-staging-branch-continuous-deploy.md) | Staging deploys from a branch, not a release | ✅ **Done** 2026-07-26 | US-032, US-038 |
| [US-053](sprint/current/done/US-053-onboarding-key-then-subscribe.md) | Onboarding: key, then subscribe, before the app | ✅ **Done** 2026-07-26 | US-021, US-022, US-039, US-036 |
| [US-054](sprint/current/done/US-054-activation-window-after-subscribe.md) | The activation window: capacity before the first run | ✅ **Done** 2026-07-26 | US-022, US-053 |
| [US-055](sprint/current/done/US-055-preview-environment.md) | A preview environment, off to the side of the chain | ✅ **Done** 2026-07-26 | US-038, US-052 |
| [US-039](sprint/current/done/US-039-byok-only-no-server-key.md) | BYOK only: remove the server `OPENAI_API_KEY` | ✅ Shipped 2026-07-26 | US-005, US-021 |
| [US-008](sprint/current/done/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | ✅ **Done** 2026-07-26 | US-007, US-009 |
| [US-031](sprint/current/done/US-031-license-and-public-repo.md) | License the code and open the repo | ✅ Shipped 2026-07-25 | — |
| [US-032](sprint/current/done/US-032-release-pipeline-and-image.md) | CI on every push, a published image on every tag | ✅ **Done** 2026-07-26 | US-031 |
| [US-022](sprint/current/done/US-022-stripe-billing.md) | Paid tier: Stripe billing | ✅ Shipped 2026-07-25 | US-021, US-005, US-007 |
| [US-028](sprint/current/done/US-028-per-user-concurrency-limit.md) | Per-user concurrent run limit (self-host org cap; env-gated) | ✅ Shipped 2026-07-25 | US-021, US-027 |
| [US-005](sprint/current/done/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) | ✅ Shipped 2026-07-25 | US-009 |
| [US-036](sprint/current/done/US-036-demo-sandbox.md) | Demo sandbox: the whole app, per-visitor, on fake data | ✅ Shipped 2026-07-24 | US-021, US-033 engine |
| [US-033](sprint/current/done/US-033-live-demo-replay.md) | Live demo: a canned run that replays as if it were live | ⛔ Superseded by US-036 (2026-07-24) — shell removed | US-006, US-026 |
| [US-021](sprint/current/done/US-021-signup-auth.md) | Signup & login (magic-link auth + per-user API keys) | ✅ Done 2026-07-24 | US-009, US-007 |
| [US-035](sprint/current/done/US-035-run-variables.md) | Per-run variables (environment overrides) | ✅ Shipped 2026-07-24 | US-009 |
| [US-034](sprint/current/done/US-034-testing-practice-and-coverage.md) | Testing practice: selective TDD, owed coverage, mutmut audit | ✅ Done 2026-07-24 | — |
| [US-010](sprint/current/done/US-010-scheduled-runs.md) | Scheduled runs | ✅ Done 2026-07-23 | US-009 |
| [US-012](sprint/current/done/US-012-email-reports.md) | Failure email notifications | ✅ Done 2026-07-23 | US-009 |
| [US-030](sprint/current/done/US-030-run-permalink.md) | A run has its own page (`/runs/<id>`) | ✅ Done 2026-07-23 | US-011, US-026 |
| [US-025](sprint/current/done/US-025-ui-consistency-pass-2.md) | UI consistency pass 2: type scale, sizes, dead space | ✅ Done 2026-07-23 | — |
| [US-026](sprint/current/done/US-026-history-run-activity.md) | Run activity in the History detail panel | ✅ Done 2026-07-23 | US-011 |
| [US-027](sprint/current/done/US-027-queued-run-visibility.md) | Tell the user their run is queued | ✅ Done 2026-07-23 | — |
| [US-013](sprint/current/done/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done — tiers 2–3 spun out as US-059 | — |
| [US-009](sprint/current/done/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done 2026-07-22 | — |
| [US-023](sprint/current/done/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done 2026-07-22 | US-009 |
| [US-006](sprint/current/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done 2026-07-22 | — |
| [US-011](sprint/current/done/US-011-run-history.md) | Run history | ✅ Done 2026-07-22 | US-009 |

### How the order was decided

Worth keeping because it is precedent for how the next ordering call gets
made. Each story's own file records why *it* moved; these are the principles:

- **A dependency loop is cut by accepting the cheapest re-edit.** The
  release-plumbing circle (resolved 2026-07-25) put US-031 and US-032 first,
  accepting that a public repo is not a frozen one; the full loop is in those
  stories' files.
- **A story that settles shared vocabulary goes first** — US-025 settled the
  type and size tokens every later frontend story would otherwise invent.
- **A story that makes something *possible* outranks one that makes something
  *better*.** US-020 gates nothing, so it kept losing its place, and it is
  still open.
- **A "depends on" that is really "would look nicer alongside" costs a sprint
  if nobody checks which it is** (US-044). Check before scheduling around it.
- **Verification order follows infrastructure**: US-007 (public HTTPS) →
  US-038 (staging) → US-008 (the CI snippet, run against staging); US-022
  after US-007, because Stripe posts webhooks to a public HTTPS URL.
- **Urgency and cheapness are both reasons to pull a story up, and they look
  nothing alike** — a cost to waiting that is not a delayed feature (US-042),
  or simply the folder's smallest story (US-048).

## Standing decisions

Paid-tier ground rules (decided 2026-07-22, still standing): nothing extra
beyond what payment requires. One plan, Stripe Checkout, **BYOK for LLM tokens**
(payment covers hosting, not OpenAI usage). Billing code lives in this repo
**env-gated** (`STRIPE_*` unset = everything free); the full repo/boundary rules
live in [`docs/repo-model.md`](../docs/repo-model.md). Email provider: **Resend**
(US-012, US-021 magic links).

## Unscheduled — `unscheduled/`

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-041](unscheduled/US-041-judge-verdict-and-ground-truth.md) | The judge decides the verdict, and a test can state what it must prove | 📋 Planned | P1 | — |
| [US-029](unscheduled/US-029-cicd-action-and-github-app.md) | CI/CD: reusable Action + GitHub App | 📋 Planned | P2 | US-008 |
| [US-065](unscheduled/US-065-retire-pg-mem.md) | Retire pg-mem: every test runs against the database we ship | 📋 Planned | P2 | — |
| [US-037](unscheduled/US-037-enterprise-stack-and-readiness.md) | Enterprise stack & readiness: what to adopt, what to refuse | 📋 Planned (tiered) | P2 | US-021, US-007 |
| [US-045](unscheduled/US-045-model-provider-choice.md) | Bring your own key, to your own provider (incl. local) | 📋 Planned | P2 | US-005, US-039 |
| [US-062](unscheduled/US-062-live-browser-test-tier.md) | A test tier that drives a real browser | 📋 Planned | P2 | US-034, US-042, US-043, US-048 |
| [US-072](unscheduled/US-072-landing-page-astro-and-self-hosted.md) | The landing page, onto the box and off React | ⏸️ Unscheduled 2026-08-05 | P2 | US-007, US-070 |
| [US-015](unscheduled/US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |
| [US-014](unscheduled/US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-046](unscheduled/US-046-token-usage-and-cost.md) | What did that run cost? (token usage + cost) | 📋 Planned | P3 | US-039 |
| [US-049](unscheduled/US-049-typed-assertions.md) | Assert on a value, not on a paragraph | 📋 Planned | P3 | US-041 |
| [US-050](unscheduled/US-050-fast-run-mode.md) | A fast, cheap mode for tests that already pass | 📋 Planned | P3 | US-046 |
| [US-060](unscheduled/US-060-account-level-notification-prefs.md) | Notification settings a person owns, not just a project (was US-012 tiers 2–3) | 📋 Planned | P3 | US-012, US-021 |
| [US-068](unscheduled/US-068-module-level-notification-prefs.md) | A module can say who hears about it | 📋 Planned | P3 | US-012, US-023 |
| [US-061](unscheduled/US-061-evidence-in-the-judges-context.md) | The judge sees the 500 (was US-044's deferred tier 2) | 📋 Planned | P3 | US-041, US-044, US-046 |
| [US-059](unscheduled/US-059-otp-and-social-login-in-tested-flows.md) | OTP and social login in a tested flow (was US-013 tiers 2–3) | ⏸️ Unscheduled 2026-08-04 — TOTP and SMS code removed, needs replanning | P3 | US-013 tier 1, US-043, US-035 |
| [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |

**US-041 is the pull-forward candidate, and the strongest one** — closer to a
defect than a feature; its file makes the case, and US-049 builds on it.

**Where the blocks came from:** US-041..US-050 (2026-07-26) out of reading the
installed browser-use against `agent/run_agent.py` for capability we do not
use; US-060..US-062 (2026-07-28) out of reading every story in `done/` for
tiered scope that closed at tier 1 and left the rest with no owner — each was
deferred against a condition that has since been met, which is exactly what a
closed file cannot notice. Nothing else in `done/` carries unowned tiered
scope.

The desktop track (US-016..019) is on hold; its strategy is in US-016.

US-041 and US-049 will owe rows in
[`correctness-critical.md`](correctness-critical.md) when the work happens —
the register's own rule is that a row is added as part of doing the work, not
speculatively.

## Bugs — `bugs/`

| ID | Defect | Status | Area |
|---|---|---|---|
| [BUG-009](sprint/current/done/BUG-009-permission-prompt-closes-the-capture-popup.md) | Chrome destroys the popup when it shows the host-permission prompt, so every user's first capture is silently lost | ✅ Fixed 2026-08-03 | `extension/popup.js`, `extension/lib/pendingCapture.js` |
| [BUG-008](sprint/current/done/BUG-008-unique-violation-matched-on-message.md) | `isUniqueViolation` ORed the exact `23505` with a `/unique\|duplicate/i` match on the message, so any error whose text said either word was answered as a name clash | ✅ Fixed 2026-07-28 | `server/src/routes/helpers.js` |
| [BUG-007](sprint/current/done/BUG-007-server-suite-fails-intermittently.md) | The server suite fails about one run in five, on a different test each time | ✅ Fixed 2026-07-28 — two causes, neither the oversubscription first blamed | `server/test/helpers/stored-key.js`, `server/test/stubs/fake_agent.js` |
| [BUG-004](sprint/current/done/BUG-004-literal-secret-placeholder-in-goal.md) | A literal `<secret>name</secret>` in a saved goal is accepted and silently does nothing — it is `resolveForRun`'s output, not its input | ✅ Fixed 2026-07-28 | `server/src/variables.js` |
| [BUG-003](sprint/current/done/BUG-003-agent-hangs-after-done.md) | An agent that hangs after `done` holds its slot until `RUN_TIMEOUT_SECONDS`, leaving `finished_at` null on a finished run | ✅ Fixed 2026-07-28 | `agent/exit_watchdog.py`, `agent/run_agent.py` |
| [BUG-006](sprint/current/done/BUG-006-empty-scheduled-target-reports-a-run.md) | A schedule whose target has no tests stamps `last_run_at` anyway, so a schedule that tests nothing reads as one that just passed | ✅ Fixed 2026-07-28 | `server/src/scheduler.js`, `server/src/routes/schedules.js`, `frontend/src/SchedulesView.jsx` |
| [BUG-005](sprint/current/done/BUG-005-scheduler-counts-unstarted-members-as-runs.md) | A scheduled member that never started — an unresolvable variable, a confined target — is counted as a run and logged as nothing | ✅ Fixed 2026-07-28 | `server/src/scheduler.js` |
| [BUG-002](bugs/BUG-002-post-tests-drops-slug-grouping.md) | `POST /api/tests` silently drops `project` / `module` slug keys, filing the test ungrouped with a 201 | 🐛 Open (2026-07-26) | `server/src/routes/tests.js` |
| [BUG-001](sprint/current/done/BUG-001-history-status-stuck-queued.md) | History shows a run as "Queued" while it is actually running | ✅ Fixed 2026-07-24 | `server/src/runs.js` |

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
  **That header is the detailed copy** — this README's columns are the index,
  and where they disagree the story file wins.
- Body: Details, Acceptance criteria (checkboxes), plus Results/Tradeoffs for
  finished work. Record measured numbers — they drive sizing decisions.
- **Results belong in the story file, not in this README.** A finished story's
  row here is a verdict and a date; what it proved, what it cost and what it
  turned up go under its own Results. A lesson that outlives the story goes to
  the doc that owns the subject — `docs/testing.md`, `DEPLOY.md`, `db/README.md`.
  Likewise **why a story moved sprint belongs in that story's Status**, not in a
  running commentary here: the commentary is what took this file back over 6,000
  words within a day of being cut.
- Moving a story between folders is a `git mv` + README table update. Finish a
  story ⇒ same commit moves it into `sprint/<name>/done/` and flips its Status.
- Fix relative links after a move: links between stories in the same sprint
  cross the `done/` boundary (`done/US-0xx-….md` from the root, `../US-0xx-….md`
  from inside `done/`).
- A tiered story keeps one file while its later tiers are still hypothetical —
  US-013's email tier shipped, so the file sits in `sprint/current/done/` with
  the SMS and social tiers recorded inside it. It gets split once the
  out-of-scope tiers are real enough to plan, which is what happened to US-008
  on 2026-07-23: a story whose acceptance criteria are mostly out of scope makes
  `ls sprint/current/` overstate what is left.
