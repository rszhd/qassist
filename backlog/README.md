# Backlog

One file per user story. **The story file is where results live** — what
shipped, what it cost, what it turned up, what was deferred. This README is the
overview, and it answers three questions only: what is open, what depends on
what, and why the sprint is shaped the way it is. Keep it in sync when a story
changes state or moves folder, but don't restate a story's results here; that
copy goes stale, and the story file is one click away.

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
turn a working app into a release someone else can run.

Sprints aren't split along a self-host/hosted-tier line — `sprint/current/` and
`sprint/next/` are just now vs. later, reprioritized as needed.

| ID | Story | Status | Depends on |
|---|---|---|---|
| [US-064](sprint/current/US-064-secret-variables-in-a-scheduled-run.md) | Secret variables in a scheduled run | 📋 Planned (filed and scheduled 2026-07-28; P1, approach settled the same day) | US-035, US-010, US-043 |
| [US-063](sprint/current/US-063-capture-a-session-without-a-terminal.md) | Capture a session without a terminal (browser extension) | 📋 Planned (scheduled 2026-07-28) | US-043, US-021 |
| [US-059](sprint/current/US-059-otp-and-social-login-in-tested-flows.md) | OTP and social login in a tested flow (was US-013 tiers 2–3) | 📋 Planned (tiered, scheduled 2026-07-28) | US-013 tier 1, US-043, US-035 |
| [US-042](sprint/current/done/US-042-agent-navigation-confinement.md) | Confine where the agent may navigate | ✅ **Done** 2026-07-27, 5/6 — the fence is two settings, not one: `block_ip_addresses` does not stop `localhost` despite its docstring. The sixth (a live redirect) is wired, not provable in any test tier | US-021 |
| [US-056](sprint/current/US-056-production-deployment.md) | Production deployment: `app.qassist.run` goes live | 📋 Planned (created 2026-07-26) — the production stand-up itself | US-007, US-038, US-052 |
| [US-058](sprint/current/done/US-058-per-user-concurrency-override.md) | Raise one user's concurrency cap without raising everyone's | ✅ **Done** 2026-07-27, 9/9 — the cap the operator can move for one account, and it lands without a restart | US-028, US-021 |
| [US-048](sprint/current/done/US-048-file-upload-in-test-flows.md) | Test a flow that uploads a file | ✅ **Done** 2026-07-27, 5/5 — a project owns the files its tests may attach, and that whitelist is the boundary: browser-use gates `read_file` on it too. The end-to-end upload is hand-verified, not tested — it needs a live browser | US-035, US-023 |
| [US-043](sprint/current/done/US-043-reusable-authenticated-sessions.md) | Test what is behind the login (reusable sessions) | ✅ **Done** 2026-07-27, 6/6 — a project owns a signed-in browser state its tests start from, produced by a login run or a paste. **Measured on demowebshop: 5 steps/60s without a session, 3 steps/36s with — and the same goal without one fails.** Four silent browser-use traps shaped it, two of them only findable by running the thing for real; the story file lists them | US-035, US-021 (**not** US-041, which it wanted) |
| [US-044](sprint/current/done/US-044-network-and-console-evidence.md) | Say *why* it failed: network and console evidence | ✅ **Done** 2026-07-27, 6/6 — a failing run now names the 500, the dead request and the uncaught exception, each stamped with its step. Shipped *ahead* of US-020: the "depends on" was really "would look nicer alongside". Capped at 5 findings per kind per step, which holds `report_data.json` flat at 84 KB where uncapped it reaches 17 MB. The opt-in HAR is the one artifact redaction cannot reach, and says so | US-026 (US-020 not needed) |
| [US-057](sprint/current/US-057-html-email-template.md) | An HTML template for outgoing email (magic link, run reports, activation) | 🔨 **Built** 2026-07-27, 4/5 — stays open on the one criterion a test can't answer: the Gmail/Apple Mail render | — |
| [US-020](sprint/current/US-020-report-v2-screenshots-recording.md) | Report v2: step screenshots + recording | 📋 Planned (P2, pulled up 2026-07-27) | US-006 |
| [US-047](sprint/current/done/US-047-stop-a-run.md) | Stop a run | ✅ **Done** 2026-07-27, 6/6 — `cancelled` is a terminal status of its own, and a stop is not a red build | — |
| [US-040](sprint/current/done/US-040-demo-deployment.md) | Deploy the demo sandbox at `demo.qassist.run` | ✅ **Done** 2026-07-26, 11/11 — live on `0.2.3` | US-036, US-007, US-038 |
| [US-007](sprint/current/done/US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy (and the Resend sender domain) | ✅ **Closed** 2026-07-26 — overlay, proxy, DNS and sender domain proven; the five production-only criteria moved to US-056 | domain (owned) |
| [US-038](sprint/current/done/US-038-staging-environment.md) | Staging environment (`staging.qassist.run`) | ✅ **Closed** 2026-07-26, 6/8 proven here; the rest moved to US-056 | US-007 |
| [US-051](sprint/current/done/US-051-subscription-dates-from-stripe.md) | The subscription dates Stripe sends and we don't read | ✅ **Done** 2026-07-26, 9/9, shipped in `v0.2.3` | US-022 |
| [US-052](sprint/current/done/US-052-staging-branch-continuous-deploy.md) | Staging deploys from a branch, not a release | ✅ **Done** 2026-07-26 — the loop proven end to end, rollback drill included; first live promotion deferred to the first release | US-032, US-038 |
| [US-053](sprint/current/done/US-053-onboarding-key-then-subscribe.md) | Onboarding: key, then subscribe, before the app | ✅ **Done** 2026-07-26 | US-021, US-022, US-039, US-036 |
| [US-054](sprint/current/done/US-054-activation-window-after-subscribe.md) | The activation window: capacity before the first run | ✅ **Done** 2026-07-26 | US-022, US-053 |
| [US-055](sprint/current/done/US-055-preview-environment.md) | A preview environment, off to the side of the chain | ✅ **Done** 2026-07-26 — live at `preview.qassist.run`; its `billing:false` rule was reversed the same day | US-038, US-052 |
| [US-039](sprint/current/done/US-039-byok-only-no-server-key.md) | BYOK only: remove the server `OPENAI_API_KEY` | ✅ Shipped 2026-07-26 | US-005, US-021 |
| [US-008](sprint/current/done/US-008-cicd-integration.md) | CI/CD trigger: the documented pipeline step | ✅ **Done** 2026-07-26 — the doc's snippet run verbatim by real GitHub Actions against staging | US-007, US-009 |
| [US-031](sprint/current/done/US-031-license-and-public-repo.md) | License the code and open the repo | ✅ Shipped (2026-07-25) | — |
| [US-032](sprint/current/done/US-032-release-pipeline-and-image.md) | CI on every push, a published image on every tag | ✅ **Done** 2026-07-26 | US-031 |
| [US-022](sprint/current/done/US-022-stripe-billing.md) | Paid tier: Stripe billing | ✅ Shipped (2026-07-25) | US-021, US-005, US-007 |
| [US-028](sprint/current/done/US-028-per-user-concurrency-limit.md) | Per-user concurrent run limit (self-host org cap; env-gated) | ✅ Shipped (2026-07-25) | US-021, US-027 |
| [US-005](sprint/current/done/US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) — account-stored (encrypted) + per-request | ✅ Shipped (2026-07-25) | US-009 |
| [US-036](sprint/current/done/US-036-demo-sandbox.md) | Demo sandbox: the whole app, per-visitor, on fake data | ✅ Shipped (2026-07-24) | US-021, US-033 engine |
| [US-033](sprint/current/done/US-033-live-demo-replay.md) | Live demo: a canned run that replays as if it were live | ⛔ Superseded by US-036 (2026-07-24) — shell removed | US-006, US-026 |
| [US-021](sprint/current/done/US-021-signup-auth.md) | Signup & login (magic-link auth + per-user API keys) | ✅ Done (2026-07-24) | US-009, US-007 |
| [US-035](sprint/current/done/US-035-run-variables.md) | Per-run variables (environment overrides) | ✅ Shipped (2026-07-24) — PDF display carved to US-020 | US-009 |
| [US-034](sprint/current/done/US-034-testing-practice-and-coverage.md) | Testing practice: selective TDD, owed agent/frontend coverage, mutmut audit | ✅ Done (2026-07-24) | — |
| [US-010](sprint/current/done/US-010-scheduled-runs.md) | Scheduled runs | ✅ Done (2026-07-23) | US-009 |
| [US-012](sprint/current/done/US-012-email-reports.md) | Failure email notifications | ✅ Done (2026-07-23) | US-009 |
| [US-030](sprint/current/done/US-030-run-permalink.md) | A run has its own page (`/runs/<id>`) | ✅ Done (2026-07-23) | US-011, US-026 |
| [US-025](sprint/current/done/US-025-ui-consistency-pass-2.md) | UI consistency pass 2: type scale, sizes, dead space | ✅ Done (2026-07-23) | — |
| [US-026](sprint/current/done/US-026-history-run-activity.md) | Run activity in the History detail panel | ✅ Done (2026-07-23) | US-011 |
| [US-027](sprint/current/done/US-027-queued-run-visibility.md) | Tell the user their run is queued | ✅ Done (2026-07-23) | — |
| [US-013](sprint/current/done/US-013-registration-flow-verification.md) | Registration-flow verification — email tier | ✅ Tier 1 done | — |
| [US-009](sprint/current/done/US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | ✅ Done (2026-07-22) | — |
| [US-023](sprint/current/done/US-023-projects-and-modules.md) | Projects & modules (organize saved tests) | ✅ Done (2026-07-22) | US-009 |
| [US-006](sprint/current/done/US-006-session-recording.md) | Session recording (record by default) | ✅ Done (2026-07-22) — CPU overhead unmeasured | — |
| [US-011](sprint/current/done/US-011-run-history.md) | Run history | ✅ Done (2026-07-22) | US-009 |

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

**US-020 gates nothing, so it kept losing its place.** US-011, US-026 and
US-010 were each pulled ahead of it. The rule that fell out: a story that makes
something *possible* outranks one that makes something *better*.

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

### What was added mid-sprint, and why

- **US-035** (2026-07-24) — the one feature beyond release plumbing. It pairs
  with US-008: CI already overrides `start_url` per environment, so generalizing
  that into named variables lets one saved test cover dev/staging/prod.
- **US-038** (2026-07-25) — the environment three stories were quietly
  assuming. US-022's Stripe round trip, US-008's unverified snippet and
  US-032's "runs on a machine that never saw the source" all ended with *verify
  against production*. Deliberately the same VPS, a second compose project.
- **US-031 + US-032** (2026-07-23) — what the narrowing exposed: the product
  was ready to self-host and the *release* was not. No LICENSE, no CI, no
  published image.
- **US-039** (2026-07-26) — the server key goes; a run is funded by its caller.
- **US-040** (2026-07-26) — US-036 shipped the whole sandbox and nothing set
  `AUTH_MODE=demo`, so the provisioner, seeder, interceptor and reaper were all
  dead code. The story is the gap between built and live.
- **US-051** (2026-07-26) — a defect, and in this sprint because staging did
  exactly what US-038 built it to do: the first real Stripe round trip showed
  `current_period_end` arriving NULL on every subscription.
- **US-052** (2026-07-26) — the bill for that. Every fix above reached the box
  by cutting a version tag, so `v0.2.1`–`v0.2.3` were deploys wearing a version
  number, each one moving `:latest`. The fix is a second transport: `staging`
  becomes a branch, and `main` earns the job of holding what staging survived.
- **US-053, US-054** (2026-07-26) — the onboarding wall, then the one condition
  added to it. US-054 exists because the box is sized to a budget and grows
  when it is resized by hand, so entitlement cannot honestly mean "you may run
  now". Both off by default on a self-host.
- **US-055** (2026-07-26) — US-052's remainder: full CI plus a Chromium image
  build charged for every look at a change. Preview hangs off the chain rather
  than joining it; `dev → preview → staging → main` was considered and rejected,
  because it makes the optional environment mandatory and puts rewritten history
  upstream of the `--ff-only` promotion. Its "no Stripe, no real mail" rule was
  reversed the same day it shipped — see the story for what replaced it.
- **US-056** (2026-07-26) — a consolidation, not new scope. US-007 and US-038
  had each proven everything short of a running production, so both were
  finished stories held open by the same missing stack.
- **US-058** (2026-07-27) — the refinement US-028 named in its own "Later" and
  then waited for. It joins this sprint because production is what makes it
  real: the cap is one env number for every account on the box, so raising it
  for one customer raises it for all of them and throttling one abusive account
  throttles everyone, and the box US-056 stands up is sized to a budget. Same
  family as US-054 — capacity is rationed by hand here, so the levers that ration
  it have to be per-account.
- **US-047** (2026-07-26, from `unscheduled/`) — the first story in a while
  about the product rather than about shipping it, pulled up because the
  release plumbing had nearly stopped needing attention. A plain absence: a
  user watching a run go wrong could only wait, spending their own key.
- **US-020 + US-057** (2026-07-27, from `sprint/next/`) — the two stories the
  next-sprint folder had left, brought forward once release plumbing stopped
  competing for the sprint. US-057 was already **built** out of sprint order on
  2026-07-27 and only ever needed a mailbox to close, so leaving it in a later
  sprint was filing, not planning: it touches `mail.js` and the `sendMail()`
  callers (four, not three — `activation.js` sends two), not the PDF. US-020 is
  still the story that makes a good report better rather than making anything
  possible — the reason it lost its place three times. It was pulled up believing
  US-044 needed the layout it builds; US-044 shipped without it the same day, so
  that justification did not survive contact. It blocks nothing again.
- **US-042** (2026-07-27, from `sprint/next/`) — pulled up the day it was
  scheduled, because it is the one story whose cost of waiting is not a delayed
  feature: staging is publicly registrable today and the fence does not exist,
  and US-056 is about to stand up a production that is registrable too. Standing
  it up first and fencing it after is the wrong order. It is
  correctness-critical, so it owes a row in
  [`correctness-critical.md`](correctness-critical.md) and its assertions get
  written and reviewed before the implementation.
- **US-043** (2026-07-27, from `sprint/next/`) — the last of the four, pulled up
  and built the same day it was scheduled. The estimate said 6-8h for "a new
  concept, new storage, a UI, and a security story"; what actually dominated was
  none of those but **reading browser-use**, which is where both of the failures
  that would have shipped silently were found — `storage_state` as a dict loads
  nothing, and the storage-state watchdog leaves a `.bak` holding the credential
  beside the file teardown removes. Neither is visible from our own code, and
  neither produces an error. The lesson generalizes past this story: **when a
  feature is a thin wrapper over a dependency's field, the assertion belongs on
  what we pass, not on what we configured** — US-042 said the same thing about
  `allowed_domains` and it was learned twice.
- **US-048** (2026-07-27, from `sprint/next/`) — pulled up the same day it was
  scheduled, and for the opposite reason to US-042: not urgency but cheapness.
  It was the folder's P3 and its smallest story, and it turned out to share
  US-042's shape once read properly — `available_file_paths` gates browser-use's
  `read_file` as well as its `upload_file`, so "let the agent attach a file" is a
  filesystem boundary wearing a feature's clothes. Correctness-critical, assertions
  written and reviewed first, row added to
  [`correctness-critical.md`](correctness-critical.md).
- **US-064** (2026-07-28, filed and scheduled the same day) — the third face of
  the same gap US-059 and US-063 read from two ends, found by asking what a
  *schedule* does about a secret variable. Nothing: a secret deliberately stores
  no default, the only two channels that carry its value are a run dialog and a
  CI body, and the scheduler is neither. So a schedule over a test with a
  required secret drops the member and writes no run at all, and one with an
  optional secret types an empty string into the password field. It is in this
  sprint rather than behind its own priority because [BUG-005](bugs/BUG-005-scheduler-counts-unstarted-members-as-runs.md)
  makes both outcomes invisible — the tick counts the dropped member as a run —
  and the two are cheapest read together. Filed believing the login case was
  already US-043's, which made the story's first task establishing that a
  *non-login* secret typed mid-run is real for someone. **Reading the schema the
  same day inverted that, and the story is now P1.** A session replays a
  credential, so it covers every test *behind* a login — but the login test
  itself cannot use one, because it is what produces one, and
  [`015_browser_sessions.sql`](../db/migrations/015_browser_sessions.sql) already
  promises that a passing run of `login_test_id` refreshes the row nightly "with
  no new machinery". There is no channel for its password, so that refresh has
  never run. The motivating case is not a coupon code; it is the credential
  US-043 is built around, and "log in every morning to prove login works" is the
  same run. Approach settled the same day: **B** — encrypt the value on the
  test's own declaration, because the secret is a property of the test, not of
  the firing. **A** — a copy per schedule row — was rejected for giving one
  credential two sources of truth, fixing only the scheduled path, and being
  unable to give two suite members different values for one variable name. It
  puts a secret value at rest for the first time either way and is
  correctness-critical, so the assertions get written and reviewed first — this
  is an amendment to US-035's "never persisted", not a gap in it.
- **US-059 + US-063** (2026-07-28, from `unscheduled/`) — scheduled the day
  after they were filed, and together, because they are one gap read from two
  ends: what a tested flow's login needs (US-059) and how a person who does not
  use a terminal supplies it (US-063). Both were filed behind US-043, which has
  since shipped, so what each has left is smaller than its priority suggested.
  US-063 is P2 and US-059 P3, and US-063 unblocks US-059's tier 3 — a dependency
  outranking its dependent, which is why they move as a pair rather than in
  priority order.
  - **US-059** is US-013's leftover tiers, spun out per the folder rule rather
    than left in a closed story whose results section is about IMAP. Two things
    changed while they sat there. **US-043 did most of tier 3's work**: its
    stated mechanism — reuse a pre-authenticated session rather than automate a
    fresh OAuth login — is now shipped, so what's left is the fence, not the
    plumbing. And **US-042 gave it a new way to fail**: `allowed_domains` is
    opt-in and project-scoped, so a project that set one blocks its own hop to
    `accounts.google.com`, and the run dies at the redirect saying nothing about
    social login. The story also adds a tier US-013 never had — **TOTP**, which
    is stdlib HMAC with no vendor, no bill and no polling loop, and is therefore
    cheaper than the SMS tier it was filed behind.
  - **US-063** came out of writing
    [`docs/auth-in-tested-flows.md`](../docs/auth-in-tested-flows.md) and
    finding the doc could not answer a question it had to raise: how does
    someone who does not use a terminal set up social login? US-043 fills a
    session two ways, and neither reaches that user — a login test cannot type a
    Google password (the one form Google refuses an automated browser), and the
    paste route needs Playwright. So the only flow where the escape hatch is the
    *sole* option is the flow whose users are least equipped to take it.
    `Sessions.jsx` already declines to require a paste for this reason; the
    story is that refusal finished. **Decided the same day: a browser
    extension**, over an interactive browser we host — no server-side Chromium,
    no input relay, and no password near us. What that buys is paid for in three
    constraints the story turns into acceptance criteria: the trust ask is the
    permission prompt rather than the install, it is the first component a
    self-hoster cannot own, and it reads the user's *daily* browser, which makes
    capturing a personal Google account the path of least resistance. The
    rejected alternative is kept in the file with its reasoning. Not to be
    confused with US-062, which shares a vocabulary and no code.

## Next sprint — `sprint/next/`

Split out of the current sprint on 2026-07-23 as the hosted-tier stories plus the
report improvement that was never gating anything, and **emptied of both by
2026-07-27** — the hosted-tier three were pulled back into `sprint/current/`, and
so were US-020 and US-057. What stands here now is a different sprint entirely:
US-043, US-044 and US-048, scheduled out of `unscheduled/` the same day — the
first sprint that is about the product rather than about shipping it. Three of
the four then left again within the day: US-042 and US-048 were pulled into
`sprint/current/` and shipped, and so was US-044, which was scheduled *last* here
and turned out not to need the dependency that put it there. US-043 is what is
left.

**Empty as of 2026-07-27.** US-043 followed the other three into
`sprint/current/` and was built the same day, so the folder that was created on
2026-07-23 and refilled on 2026-07-27 emptied twice inside five days.

**How they ordered themselves.** US-042 was the P1 and the one with a security
shape, which is exactly why it did not stay here — see the current sprint. US-048
was the P3 and the cheapest thing in the folder, which is why it went the same
way. **US-044 went too, and it is the one worth reading the reasoning on**: it was
scheduled last of the three because report v2 owned the layout its evidence lands
in, and that turned out to be wrong. US-020 owns the *execution log*; a
step-stamped diagnostics section does not need to live inside one, and US-026's
step list was already step-keyed. So US-044 shipped the day it was scheduled and
US-020 is still open. The lesson is cheap to state and was not free to learn: **a
"depends on" that is really "would look nicer alongside" costs a sprint if nobody
checks which it is** — check before scheduling around it.

US-043 went last, and only one of its two open questions closed. It owed a row
in [`correctness-critical.md`](correctness-critical.md) and got one, written
before the implementation. **It still arrived without US-041**, which its own
file says it wants first, and building it did not make that less true — the
opposite: a reusable session is the single largest expansion of what QAssist can
reach, and the verdict on everything it now reaches is still the agent grading
its own homework. US-041 is the next thing that should move.

Paid-tier ground rules (decided 2026-07-22, still standing, and now entirely
about current-sprint code): nothing extra beyond what payment requires. One plan,
Stripe Checkout, **BYOK for LLM tokens** (payment covers hosting, not OpenAI
usage). Billing code lives in this repo **env-gated** (`STRIPE_*` unset =
everything free); the full repo/boundary rules live in
[`docs/repo-model.md`](../docs/repo-model.md). Email provider: **Resend**
(US-012, US-021 magic links).

## Unscheduled — `unscheduled/`

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-041](unscheduled/US-041-judge-verdict-and-ground-truth.md) | The judge decides the verdict, and a test can state what it must prove | 📋 Planned | P1 | — |
| [US-029](unscheduled/US-029-cicd-action-and-github-app.md) | CI/CD: reusable Action + GitHub App | 📋 Planned | P2 | US-008 |
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
| [US-061](unscheduled/US-061-evidence-in-the-judges-context.md) | The judge sees the 500 (was US-044's deferred tier 2) | 📋 Planned | P3 | US-041, US-044, US-046 || [US-016](unscheduled/US-016-desktop-shell.md) | Desktop shell (Electron) | 📋 Planned | TBD | — |
| [US-017](unscheduled/US-017-frozen-python-agent.md) | Frozen Python agent (no system Python) | 📋 Planned | TBD | US-016 |
| [US-018](unscheduled/US-018-first-run-setup.md) | First-run setup: Chromium download + BYOK settings | 📋 Planned | TBD | US-016 |
| [US-019](unscheduled/US-019-installers-signing-autoupdate.md) | Installers, code signing, auto-update | 📋 Planned | TBD | US-016..018 |

**US-041..US-050 (added 2026-07-26)** came out of one question — *what is
browser-use already capable of that we do not use?* — answered by reading the
installed 0.13.6 against `agent/run_agent.py` rather than the docs. They were
filed unscheduled because the current sprint is release plumbing and this is
product; **four of them (US-042, US-043, US-044, US-048) were scheduled into
`sprint/next/` on 2026-07-27** — US-042, US-044 and US-048 straight on into
`sprint/current/` and shipped the same day — which is that reason expiring rather
than being overruled.

**US-041 is the pull-forward candidate left, and the strongest one.** It is
closer to a defect than a feature: `Agent(use_judge=…)` defaults to `True` and we
never override it, so every run already buys a judge call and then reports
`history.is_successful()` — the *agent's self-report* — dropping the judgement on
the floor. The product's leading claim ("judges pass/fail") is currently the
agent grading its own homework. Two other stories want it first: US-049 builds on
it, and US-043 is in the next sprint without it.

**US-059 and US-063 (added 2026-07-28)** left the same day they arrived —
both are in `sprint/current/` now, and why is recorded there.

**US-060, US-061, US-062 (added 2026-07-28)** came out of the same sweep that
produced US-059: reading every story in `done/` for tiered scope that closed at
tier 1 and left the rest with no owner. Three survived the read, and the pattern
is that **each was deferred against a condition that has since been met** —
which is exactly the kind of deferral a closed file cannot notice expiring.

- **US-060** is US-012's account tier. Its decision 10 deferred the UI because
  *"account does not mean anything yet: there is one seeded user and no login"*.
  US-021 shipped two days later. The `OPERATOR_EMAIL` default it flagged —
  `operator@qassist.local`, an address that cannot receive — is still the last
  fallback in `notify.js`'s chain on a self-host that sets nothing.
- **US-061** is US-044's second step, gated on *"once US-041's judge is the
  verdict"* — still true, so this one is genuinely still waiting, and it is
  filed behind US-041 rather than pulled forward. Writing it up found one thing
  worth having on paper early: `include_recent_events` is **not** the lever. It
  interpolates browser-use's raw event summary into the prompt, unscrubbed and
  uncapped, which is the exact pair of bugs US-044's four-subtleties section is
  the record of avoiding.
- **US-062** is the odd one — not a story's leftover tier but a *missing* one.
  US-042, US-043 and US-048 each closed with a claim resting on someone watching
  it work, and each said so in the same words: no tier of ours can reach a live
  browser. US-042 even assigned the work ("belongs to whoever next touches this
  surface") and two stories touched it since. US-043 is the argument for paying:
  its dropped-localStorage bug was found by hand and was invisible to every
  existing tier. The cheap half is cheaper than it looks — `SecurityWatchdog`
  attaches to `BrowserSession`, not `Agent`, so two of the three claims need a
  Chromium but no model call.

Nothing else in `done/` is carrying unowned tiered scope. The other "tier" hits
are the paid tier, US-058's plan-driven caps (a US-022 consumer, already noted
in that story's Later), and US-005's scheduler guard, which US-039 removed.

**US-037 (added 2026-07-25)** is a decision as much as a story: which
"enterprise standard" stack pieces we adopt and — more usefully — which we
refuse, on the premise that what blocks an enterprise deal is SSO, an audit
log, RBAC and a security questionnaire, none of which are framework choices.
Its tier 4 (TypeScript) is the only one that would rewrite a **Stack decisions
(settled)** line in `CLAUDE.md`.

**Desktop track (US-016..019, sketched 2026-07-21, on hold):** candidate
strategy — free version runs entirely on the user's machine (their CPU/RAM,
their OpenAI key), hosted features become the paid tier. Not prioritized yet;
decision deferred. If picked up: US-016 → US-017 → US-018 → US-019, Windows
before macOS, and `server.js` stays dual-mode (container + Electron) — never
fork it. US-018 would realize US-005 (BYOK) on desktop.

Two of these owe rows in [`correctness-critical.md`](correctness-critical.md) —
US-041 and US-049 both define what "pass" means. Rows are deliberately
*not* added yet: the register's own rule is that a row is added as part of doing
the work, and a table of speculative rows is what makes it stop being read.

## Bugs — `bugs/`

| ID | Defect | Status | Area |
|---|---|---|---|
| [BUG-004](sprint/current/done/BUG-004-literal-secret-placeholder-in-goal.md) | A literal `<secret>name</secret>` in a saved goal is accepted and silently does nothing — it is `resolveForRun`'s output, not its input, so the agent types the placeholder | ✅ Fixed 2026-07-28 | `server/src/variables.js` |
| [BUG-003](sprint/current/done/BUG-003-agent-hangs-after-done.md) | An agent that hangs after `done` holds its slot until `RUN_TIMEOUT_SECONDS`, leaving `finished_at` null on a finished run | ✅ Fixed 2026-07-28 | `agent/exit_watchdog.py`, `agent/run_agent.py` |
| [BUG-006](bugs/BUG-006-empty-scheduled-target-reports-a-run.md) | A schedule whose target has no tests stamps `last_run_at` anyway, so a schedule that tests nothing reads as one that just passed | 🐛 Open (2026-07-28) | `server/src/scheduler.js`, `frontend/src/SchedulesView.jsx` |
| [BUG-005](bugs/BUG-005-scheduler-counts-unstarted-members-as-runs.md) | A scheduled member that never started — an unresolvable variable, a cap refusal — is counted as a run and logged as nothing | 🐛 Open (2026-07-28) | `server/src/scheduler.js` |
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
- Body: Details, Acceptance criteria (checkboxes), plus Results/Tradeoffs for
  finished work. Record measured numbers — they drive sizing decisions.
- **Results belong in the story file, not in this README.** A finished story's
  row here is a verdict and a date; what it proved, what it cost and what it
  turned up go under its own Results. A lesson that outlives the story goes to
  the doc that owns the subject — `docs/testing.md`, `DEPLOY.md`, `db/README.md`.
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
