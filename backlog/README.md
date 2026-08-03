# Backlog

One file per user story. **The story file is where results live** — what
shipped, what it cost, what it turned up, what was deferred. This README is the
overview, and it answers three questions only: what is open, what depends on
what, and why the sprint is shaped the way it is. Keep it in sync when a story
changes state or moves folder, but don't restate a story's results here; that
copy goes stale, and the story file is one click away.

**A finished row is a verdict and a date.** Not a paragraph. This file was cut
from 7,400 words to 3,285 on 2026-07-27 and was back to 6,063 the next day,
because every append was locally reasonable and none could see the file it was
landing in — the same failure that broke
[`correctness-critical.md`](correctness-critical.md). Re-read the whole file
before appending to it, and check the tables still render: one such append had
already merged two rows of the Unscheduled table into one line, where they sat
unnoticed.

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
- `bugs/` — defects, `BUG-NNN-slug.md`, for a fault in shipped code that isn't
  a story's worth of work. Same lifecycle as a story, and that includes the
  move: a fixed bug is `git mv`d into the `sprint/<name>/done/` of the sprint
  that fixed it, so **`ls bugs/` is exactly the open defects** the way
  `ls sprint/current/` is exactly the open stories. Its row stays in the Bugs
  table below — that table is the register, and a fixed defect is worth finding
  from it — so only the row's link changes.
- `released/<name>/` — shipped releases, moved here wholesale when the release
  goes out (e.g. `released/prototype/`), `done/` subfolder and all. Anything
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
| [US-059](sprint/current/US-059-otp-and-social-login-in-tested-flows.md) | OTP and social login in a tested flow (was US-013 tiers 2–3) | 📋 Planned — P3, tiered, scheduled 2026-07-28 | US-013 tier 1, US-043, US-035 |
| [US-056](sprint/current/US-056-production-deployment.md) | Production deployment: `app.qassist.run` goes live | 🔨 **Live** 2026-07-29 on `v0.3.0`, 4/10 — the rest need a sign-in, live Stripe keys, or a decision | US-007, US-038, US-052 |
| [US-057](sprint/current/US-057-html-email-template.md) | An HTML template for outgoing email | 🔨 **Built** 2026-07-27, 4/5 — open on the one criterion a test can't answer | — |
| [US-020](sprint/current/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned — P2 | US-006 |
| [US-066](sprint/current/US-066-chrome-web-store-listing.md) | List the session-capture extension on the Chrome Web Store | 🔨 **Prepared** 2026-08-03, 3/6 — the rest needs a developer account and Google's review | US-063 |
| [US-067](sprint/current/US-067-mobile-app-view.md) | The app on a phone | 📋 Planned — P2, scheduled 2026-08-03 | US-025, US-030 |

### Done

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-063](sprint/current/done/US-063-capture-a-session-without-a-terminal.md) | Capture a session without a terminal (browser extension) | ✅ **Shipped and hand-verified** 2026-07-31 — store listing out of scope | US-043, US-021 |
| [US-064](sprint/current/done/US-064-secret-variables-in-a-scheduled-run.md) | Secret variables in a scheduled run | ✅ **Done** 2026-07-28, 8/8 | US-035, US-010, US-043 |
| [US-042](sprint/current/done/US-042-agent-navigation-confinement.md) | Confine where the agent may navigate | ✅ **Done** 2026-07-27, 5/6 | US-021 |
| [US-058](sprint/current/done/US-058-per-user-concurrency-override.md) | Raise one user's concurrency cap without raising everyone's | ✅ **Done** 2026-07-27, 9/9 | US-028, US-021 |
| [US-048](sprint/current/done/US-048-file-upload-in-test-flows.md) | Test a flow that uploads a file | ✅ **Done** 2026-07-27, 5/5 | US-035, US-023 |
| [US-043](sprint/current/done/US-043-reusable-authenticated-sessions.md) | Test what is behind the login (reusable sessions) | ✅ **Done** 2026-07-27, 6/6 | US-035, US-021 (**not** US-041, which it wanted) |
| [US-044](sprint/current/done/US-044-network-and-console-evidence.md) | Say *why* it failed: network and console evidence | ✅ **Done** 2026-07-27, 6/6 | US-026 (US-020 not needed) |
| [US-047](sprint/current/done/US-047-stop-a-run.md) | Stop a run | ✅ **Done** 2026-07-27, 6/6 | — |
| [US-040](sprint/current/done/US-040-demo-deployment.md) | Deploy the demo sandbox at `demo.qassist.run` | ✅ **Done** 2026-07-26, 11/11 — live on `0.3.0` | US-036, US-007, US-038 |
| [US-007](sprint/current/done/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy (and the Resend sender domain) | ✅ **Closed** 2026-07-26 — five production-only criteria moved to US-056 | domain (owned) |
| [US-038](sprint/current/done/US-038-staging-environment.md) | Staging environment (`staging.qassist.run`) | ✅ **Closed** 2026-07-26, 6/8 — the rest moved to US-056 | US-007 |
| [US-051](sprint/current/done/US-051-subscription-dates-from-stripe.md) | The subscription dates Stripe sends and we don't read | ✅ **Done** 2026-07-26, 9/9, shipped in `v0.2.3` | US-022 |
| [US-052](sprint/current/done/US-052-staging-branch-continuous-deploy.md) | Staging deploys from a branch, not a release | ✅ **Done** 2026-07-26 | US-032, US-038 |
| [US-053](sprint/current/done/US-053-onboarding-key-then-subscribe.md) | Onboarding: key, then subscribe, before the app | ✅ **Done** 2026-07-26 | US-021, US-022, US-039, US-036 |
| [US-054](sprint/current/done/US-054-activation-window-after-subscribe.md) | The activation window: capacity before the first run | ✅ **Done** 2026-07-26 | US-022, US-053 |
| [US-055](sprint/current/done/US-055-preview-environment.md) | A preview environment, off to the side of the chain | ✅ **Done** 2026-07-26 — its `billing:false` rule was reversed the same day | US-038, US-052 |
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
| [US-035](sprint/current/done/US-035-run-variables.md) | Per-run variables (environment overrides) | ✅ Shipped 2026-07-24 — PDF display carved to US-020 | US-009 |
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
| [US-006](sprint/current/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done 2026-07-22 — CPU overhead unmeasured | — |
| [US-011](sprint/current/done/US-011-run-history.md) | Run history | ✅ Done 2026-07-22 | US-009 |

### How the order was decided

Worth keeping because it is precedent for how the next ordering call gets made.

**The release-plumbing circle, resolved 2026-07-25.** Five stories referenced
each other in a loop. US-038 (staging) needs an image to run, because US-007's
prod overlay deliberately cannot build — so it needs US-032. US-032 needs
Actions and ghcr on a public repo, so it needs US-031. And US-031 said "do it
last, after US-007/US-008 have finished editing the docs the public will read"
— but US-008's criterion closes *on staging*. The cut: **US-031 and US-032 go
first**, accepting that `docs/ci.md` may still gain a line after the repo is
public, because a public repo is not a frozen one. That accepted risk came due
on 2026-07-26 and cost exactly one edit, as budgeted.

**US-025 went first of all**, ahead of every other frontend story: it settles
the type and size tokens the rest would otherwise each invent.

**A story that makes something *possible* outranks one that makes something
*better*.** US-020 gates nothing, so it kept losing its place — US-011, US-026
and US-010 were each pulled ahead of it, and it is still open.

**A "depends on" that is really "would look nicer alongside" costs a sprint if
nobody checks which it is.** US-044 was scheduled behind US-020 on the belief
that report v2 owned the layout its evidence lands in. It didn't, and US-044
shipped the day it was scheduled. Check before scheduling around it.

**US-007 → US-038 → US-008.** Public HTTPS, then staging, then the documented
CI snippet run for real against *staging* rather than against the instance
people are using. US-007 and US-038's repo halves shipped in one sitting and in
that order, because US-038's premise — staging is the prod overlay
*parameterized*, not a second one — is a constraint on how US-007's overlay is
written, and cheaper to honour than to retrofit.

**US-022 went last, and specifically after US-007**: Stripe posts webhooks to a
public HTTPS URL, so it cannot be verified end to end before the domain is up.

**US-027 sat outside the order entirely** — it depended on nothing, and every
story above it made the queue busier.

**Urgency and cheapness are both reasons to pull a story up, and they look
nothing alike.** US-042 came forward because waiting had a cost that was not a
delayed feature — staging is publicly registrable and the fence did not exist.
US-048 came forward because it was the folder's smallest story. Each story's own
file records why it moved; that is not repeated here.

## Next sprint — `sprint/next/`

**Empty as of 2026-07-27.** Created 2026-07-23, emptied into `sprint/current/`,
refilled from `unscheduled/` on 2026-07-27 and emptied again the same day.

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
| [US-024](unscheduled/US-024-memory-watchdog-pss-metric.md) | Memory watchdog: measure PSS, not summed RSS | 📋 Planned | P2 | — |
| [US-037](unscheduled/US-037-enterprise-stack-and-readiness.md) | Enterprise stack & readiness: what to adopt, what to refuse | 📋 Planned (tiered) | P2 | US-021, US-007 |
| [US-045](unscheduled/US-045-model-provider-choice.md) | Bring your own key, to your own provider (incl. local) | 📋 Planned | P2 | US-005, US-039 |
| [US-062](unscheduled/US-062-live-browser-test-tier.md) | A test tier that drives a real browser | 📋 Planned | P2 | US-034, US-042, US-043, US-048 |
| [US-015](unscheduled/US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |
| [US-014](unscheduled/US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-046](unscheduled/US-046-token-usage-and-cost.md) | What did that run cost? (token usage + cost) | 📋 Planned | P3 | US-039 |
| [US-049](unscheduled/US-049-typed-assertions.md) | Assert on a value, not on a paragraph | 📋 Planned | P3 | US-041 |
| [US-050](unscheduled/US-050-fast-run-mode.md) | A fast, cheap mode for tests that already pass | 📋 Planned | P3 | US-046 |
| [US-060](unscheduled/US-060-account-level-notification-prefs.md) | Notification settings a person owns, not just a project (was US-012 tiers 2–3) | 📋 Planned | P3 | US-012, US-021 |
| [US-061](unscheduled/US-061-evidence-in-the-judges-context.md) | The judge sees the 500 (was US-044's deferred tier 2) | 📋 Planned | P3 | US-041, US-044, US-046 |
| [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |

**US-041 is the pull-forward candidate, and the strongest one.** It is closer to
a defect than a feature: `Agent(use_judge=…)` defaults to `True` and we never
override it, so every run already buys a judge call and then reports
`history.is_successful()` — the *agent's self-report*. The product's leading
claim ("judges pass/fail") is currently the agent grading its own homework, and
US-043 has since shipped without it, which widened what that verdict covers
rather than narrowing it. US-049 builds on it too.

**Where the unscheduled stories came from.** US-041..US-050 (2026-07-26) came
out of reading the installed browser-use 0.13.6 against `agent/run_agent.py` —
*what is it already capable of that we do not use?* — and four of them have since
been scheduled and shipped. US-060..US-062 (2026-07-28) came out of reading every
story in `done/` for tiered scope that closed at tier 1 and left the rest with no
owner; the pattern worth keeping is that **each was deferred against a condition
that has since been met**, which is exactly what a closed file cannot notice.
US-062 is the exception and the odd one: not a leftover tier but a *missing*
one — US-042, US-043 and US-048 each closed with a claim resting on someone
watching it work, in the same words, because no tier of ours reaches a live
browser. Nothing else in `done/` is carrying unowned tiered scope.

**US-037** is a decision as much as a story: which "enterprise standard" stack
pieces we adopt and — more usefully — which we refuse, on the premise that what
blocks an enterprise deal is SSO, an audit log, RBAC and a security
questionnaire, none of which are framework choices. Its tier 4 (TypeScript) is
the only one that would rewrite a **Stack decisions (settled)** line in
`CLAUDE.md`.

**Desktop track (US-016..019, sketched 2026-07-21, on hold):** candidate
strategy — free version runs entirely on the user's machine (their CPU/RAM,
their OpenAI key), hosted features become the paid tier. Not prioritized yet;
decision deferred. If picked up: US-016 → US-017 → US-018 → US-019, Windows
before macOS, and `server.js` stays dual-mode (container + Electron) — never
fork it. US-018 would realize US-005 (BYOK) on desktop.

US-041 and US-049 will both owe rows in
[`correctness-critical.md`](correctness-critical.md) — both define what "pass"
means. Rows are deliberately *not* added yet: the register's own rule is that a
row is added as part of doing the work, and a table of speculative rows is what
makes it stop being read.

## Bugs — `bugs/`

| ID | Defect | Status | Area |
|---|---|---|---|
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
