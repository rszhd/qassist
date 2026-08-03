# US-059 — OTP and social login in a tested flow

**As** someone whose signup or login is guarded by a phone code, an
authenticator app, or a "Continue with Google" button, **I want** the agent to
get past that wall, **so that** the funnel I most need tested is not the one
QAssist can't reach.

- **Status:** ⏸️ **Unscheduled 2026-08-04 — code removed, replan from scratch.**
  Spun out of
  [US-013](../sprint/current/done/US-013-registration-flow-verification.md) on
  2026-07-28 and scheduled the same day alongside US-063. Tiers 1 (TOTP) and 2
  (SMS) were built on 2026-07-31 and **deleted on 2026-08-04**, unreleased and
  never proven against a live gated site. Tier 3 (social) never started.
  The requirement stands; the design does not. Both tiers put a per-account
  credential in the server's process environment, and the follow-up sections
  below record why each is the wrong shape rather than the right shape wrongly
  configured. That is a replan, not a fix, and it is not urgent enough to hold a
  sprint slot: the email tier still covers the common case, and an OTP test mode
  on the tested site covers the recurring one with no feature at all.
  **What was removed** (recover from the removal commit if the replan wants a
  starting point): `agent/totp_codes.py`, `agent/sms_codes.py` and their two
  test modules; the `get_totp_code` and `get_sms_code` blocks in
  `agent/run_agent.py`; `totp_code`/`sms_code`/`sms_number` from
  `AGENT_PROVIDED_SECRETS` in `server/src/variables.js`; the TOTP row in
  `correctness-critical.md`; the TOTP and SMS sections of
  `docs/auth-in-tested-flows.md`, replaced by one "Second factors" section that
  states both are unsupported and why. No migration, no API and no UI ever
  referenced either tier, so nothing outside those files moved.
- **Priority:** P3 (inherited from US-013)
- **Estimate:** stale — the tier-1/tier-2 figures below costed the shape that
  was removed. Social is unchanged at ~0.5–1 day; see "What US-043 already paid
  for".
- **Depends on:** US-013 tier 1 (the tool-registration and `sensitive_data`
  pattern), US-043 (saved browser sessions — social login's actual mechanism),
  US-035 (secret variables carry the shared secret / provider credentials)

## Why this is three tiers and not two

US-013 called them "SMS" and "social". Reading the agent as it stands today,
they are not two problems of similar size, and one of them has largely been
solved by a later story:

1. **TOTP (authenticator app)** — not in US-013 at all, and the cheapest thing
   here by a wide margin. Given the shared secret the site showed at enrolment,
   a valid 6-digit code is an HMAC over the time step: `hmac` + `struct` +
   `base64`, all stdlib, no account, no vendor, no per-message cost, no
   deliverability. It also has no *waiting* — the code is computed, not
   awaited, so there is no polling loop and no timeout to tune. Do this first.
2. **SMS / phone** — a real integration with a real bill. This is US-013 tier 2
   unchanged, and it is the only tier that needs a vendor.
3. **Social login** — US-013 said "don't automate a fresh OAuth login (fragile,
   bot-detected); reuse a pre-authenticated session or provider test users."
   That advice is still right, and **the mechanism it named now exists**.

## What US-043 already paid for

US-043 shipped project-scoped saved browser sessions: a `storageState` blob
encrypted at rest, produced either by a designated login run or pasted from an
existing Playwright `storageState.json`, loaded at spawn via
`BrowserProfile(storage_state=<path>)`. Its own file says the paste route
"covers SSO flows an agent will never survive" — which is this tier's premise,
already built.

So tier 3 is mostly **not new plumbing**. What is left is the part US-043 had
no reason to handle:

- **The navigation fence blocks the provider.** US-042's `allowed_domains` is
  project-scoped and opt-in (empty = no fence, see `agent/navigation_policy.py`
  `_allowlist`). A project that *has* set one to its own domain will have the
  OAuth hop to `accounts.google.com` refused by browser-use's SecurityWatchdog
  — the login run that produces the session dies at the redirect, and the
  failure names a blocked URL rather than anything about social login. Either
  the provider hosts are documented as entries the user must add, or a login
  run gets a wider fence than an ordinary run. **Pick one deliberately**: the
  second is a hole in the fence US-042 exists to be, and should probably lose.
- **Provider test users.** Google and GitHub both have a supported way to hold
  a test identity; the story is documenting which, not building anything.
- **A refresh that is honest about expiry.** US-043 already distinguishes an
  expired session from a cold one (`browser_session.expiry_reason`), and its
  "failed refresh must not clobber" rule already holds. Worth re-proving
  against a provider session rather than a first-party one, because the
  expiry *shape* differs: an OAuth session dies at the provider and the app
  bounces you, so the redirect lands somewhere `expiry_reason` has never seen.

## Details

**Tiers 1 and 2 follow the shape `email_codes.py` already set.** `ImapMailbox`
has `from_env` (returns `None` when unconfigured) + `wait_for_confirmation`,
and `run_agent.py` registers `get_email_code` only when a mailbox exists,
appending flow instructions to the task. Two siblings behind the same
interface:

- `agent/totp_codes.py` — `TotpSecret.from_env` / `.code(now)`. Pure, testable
  to the RFC 6238 vectors, no I/O at all.
- `agent/sms_codes.py` — a Twilio-backed inbox polling for the newest message
  to a provisioned number, reusing `email_codes.extract_code` for the digits.
  Same 180 s ceiling, same reconnect-per-poll posture.

**Secrets route the way tier 1's do and nowhere else.** The fetched code, and —
for TOTP — the shared secret itself, go through browser-use `sensitive_data`,
so the LLM sees `<secret>totp_code</secret>` / `<secret>sms_code</secret>` and
`agent/redact.py`'s `scrub` can strip the real values from steps, frames and
`report_data.json`. The TOTP shared secret is the sharper of the two: unlike an
emailed code it does not expire, so a leak is a permanent second factor rather
than a 10-minute one. It is a US-035 `secret` variable and must never be
substituted inline into the goal.

**The SMS vendor decision is part of the story.** Twilio is the assumed
default, but a programmable number is a monthly line rental plus per-message
cost, and a lot of target sites reject VoIP numbers outright. Decide whether
this ships as BYO-Twilio-credentials (consistent with BYOK everywhere else and
free to us) — almost certainly yes — and document the VoIP rejection as a known
limitation rather than chasing it.

## Tier 1 follow-up — the secret is in the wrong place (2026-08-03)

Tier 1 shipped reading `QA_TOTP_SECRET` from the process environment, inherited
by every run on the instance (`agent/run_agent.py` `TotpSecret.from_env`, fed by
the `...process.env` spread in `server/src/runs.js`). That is one enrolment per
*machine*, and it does not survive the hosted tier.

The reason is what a TOTP secret is. An emailed code and an SMS code arrive at a
**receiving endpoint** — one catch-all domain or one number serves any number of
sites and accounts, because the per-run address (or the message body) says which
run it belongs to. A TOTP secret carries no such discriminator: it is minted by
one site for one account, and it *is* that account's second factor. There is
nothing to multiplex. So the mailbox's single slot is a convenience limit, while
TOTP's is a hard one — the second account that needs 2FA cannot have it. Worse,
while the variable is set the `get_totp_code` tool and its task paragraph attach
to every run on the box, including other tenants' runs against sites with no 2FA
at all.

Stated plainly: this is a per-account credential living in the server's
environment. Nobody would put a customer's password there.

**Shape to build.** The destination already exists twice over.
[`browser_sessions`](../../db/migrations/015_browser_sessions.sql) is the
closest sibling — also a per-account credential, also project-scoped, and
crucially **named**, `unique (project_id, name_key)`, with a test pointing at
one via `tests.browser_session_id`. Copy that, not a single slot per project:
one project is one site, but an admin account and a standard-user account are
two enrolments on it. The secret then reaches the agent on US-035's existing
`QA_VARS` channel (`agent/secret_vars.py`) — the same route the derived code
already leaves by — and `get_totp_code` registers only for runs that carry one,
which is what removes the cross-tenant tool leak.

**Open decision:** own table, or a column beside the saved session. They pair —
the login run that *produces* a session is exactly the run that needs a TOTP
code to get through the login, same account, same project — but a project may
want TOTP with no saved session at all. Decide before building.

**The env slot stays for self-host.** One team, one instance, one enrolment is
defensible and costs nothing to keep as a fallback when no per-project secret is
declared. It is only the hosted tier that cannot live with it.

`QA_TOTP_SECRET` is also absent from `.env.example`, `.env.preview.example` and
`.env.staging.example` (as are `QA_IMAP_*` and `QA_TWILIO_*`) — documented only
in [`docs/auth-in-tested-flows.md`](../../docs/auth-in-tested-flows.md) and
the module docstrings. Worth fixing while the deployment-wide caveat is being
written next to it.

## Tier 2 limits — one number, and what it cannot repeat (2026-08-03)

Two limits found while planning the live proof. Neither is a bug in the code as
written; both are consequences of a phone number being one allocation from one
carrier, and both change what the tier can be sold as.

**Concurrent runs share the number and can steal each other's codes.**
`_fetch_newest_code` filters on `To` and on `sms_since` (run start − 60 s) and
nothing else. Two runs reaching an SMS step inside the same window both take the
newest message. The mailbox has no such hazard because `generate_address` builds
a per-run address from the run id and the fetch filters on it — which is exactly
the discriminator SMS has no way to carry. With `MAX_CONCURRENT_SESSIONS=4` this
is reachable by one tenant running two tests, so it is not a hosted-tier-only
concern like the TOTP slot above.

**A recurring signup cannot work, for a reason no code change reaches.** Sites
treat a number as an account's unique key, so day two of a scheduled signup gets
"already registered" — a real product rule, not a defect. The email tier is
repeatable only because a fresh address costs nothing; a number has no
sub-addressing. So `get_sms_code` fits a **2FA login** (same account, same
number, daily) and a signup **once per number**.

**A pool of numbers is rejected.** It is a standing monthly rental on every
carrier — Telnyx, Plivo, SignalWire and Bandwidth differ from Twilio by a
constant, not in kind — and every number in the pool is VoIP, so a site that
rejects one rejects all of them. Paying per number to still be refused is the
worst of both.

**The recurring-signup answer is the tested site's own OTP test mode**, and it
needs nothing built here. Twilio Verify test credentials always verify without
sending; Firebase Auth registers test numbers with fixed codes; most providers
have an equivalent. The fictional number is a US-035 variable, the fixed code a
`secret` one (encrypted at rest since US-064, so a schedule fires unattended),
and the goal types `<secret>otp_code</secret>`. No Twilio account, no
`QA_TWILIO_*`, no polling. Written up in
[`docs/auth-in-tested-flows.md`](../../docs/auth-in-tested-flows.md) → SMS.

**This puts tier 2's first acceptance box in question.** It asks for a *signup*
end-to-end, which is now known to be the one shape that cannot repeat. Left
unchanged pending a decision: prove the signup once as written, or restate the
box as a 2FA login, which is what the tier actually serves.

## Acceptance criteria

**Tiers 1 and 2 below are void as of 2026-08-04.** They are kept unedited as the
record of what the removed implementation did and did not prove — the ticks were
true against code that no longer exists. A replan writes its own, and should
start from the two follow-up sections above rather than from these boxes. Tier
3's criteria are unaffected: nothing about social login was built or removed.

**Tier 1 — TOTP** (void)

- [ ] With a shared secret configured, the agent completes a login whose second
      factor is an authenticator code, end-to-end — wired and unit-tested, not
      yet run live against a real authenticator-gated site
- [x] Codes match RFC 6238 test vectors, including across a time-step boundary
- [x] The shared secret appears in no step, event, log, or report — asserted
      over the whole emitted payload, not field by field
- [ ] A project stores named TOTP secrets, encrypted, selected per test — two
      accounts on one site can each have their own, and neither is readable
      back out of any endpoint
- [ ] `get_totp_code` is absent from a run whose test declares no secret, with
      another project's secret configured on the same instance

**Tier 2 — SMS** (void)

- [ ] With a number configured, the agent completes a signup requiring an SMS
      code, end-to-end — wired and unit-tested, not yet run live against a
      real Twilio number and site
- [x] Unconfigured, runs are byte-for-byte unchanged and the tool is absent
- [x] The code and the phone number are absent from every emitted artifact
- [x] The VoIP-rejection and per-message-cost limitations are documented

**Tier 3 — social**

- [ ] A project can reach a "Continue with Google" flow using a saved session
      produced by a login run, with the navigation fence set as documented
- [ ] With a fence configured and the provider host missing from it, the
      failure says the provider host was blocked — not something generic
- [ ] A provider session that has expired at the provider is reported as
      `session_expired`, not as a failed goal
- [ ] A failed refresh leaves the stored blob byte-identical (US-043's rule,
      re-proven against a provider redirect)

## Correctness-critical

Tiers 1 and 2 add **new secret sources** to a surface already in
[`correctness-critical.md`](../correctness-critical.md) — the Redaction row
(`agent/redact.py`) and the Secret variables row (US-035). The TOTP shared
secret is a **non-expiring** credential, which neither existing row's failure
description covers. Add a row and get the assertion reviewed before the
implementation exists, per the Workflow rule.

The TOTP row this called for was added on 2026-07-31 and **removed with the code
on 2026-08-04** — the register indexes surfaces that exist, and a row pointing at
a deleted module is the kind of entry that makes it stop being read. The
paragraph above still holds for whatever the replan builds: a non-expiring
credential is its own failure shape, and the row goes back before the
implementation does.

Tier 3 touches Saved browser sessions (US-043), already registered — its
existing assertions should be extended rather than duplicated.

## Notes

- CAPTCHA and bot detection remain unsolvable by us and out of scope, same as
  US-013 said. Social login makes this *more* likely, not less: an automated
  browser hitting a Google login form is exactly what that detection is for,
  which is the whole reason tier 3 reuses a session instead of typing a
  password.
- US-013's tier ordering rationale ("most tractable first") is kept; only the
  contents of the order changed, because TOTP is cheaper than both and social
  got cheaper after US-043.
