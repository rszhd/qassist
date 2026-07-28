# US-059 — OTP and social login in a tested flow

**As** someone whose signup or login is guarded by a phone code, an
authenticator app, or a "Continue with Google" button, **I want** the agent to
get past that wall, **so that** the funnel I most need tested is not the one
QAssist can't reach.

- **Status:** 📋 Planned — spun out of
  [US-013](../sprint/current/done/US-013-registration-flow-verification.md)
  on 2026-07-28. US-013's tier 1 (email codes) shipped 2026-07-21 and that
  story is closed; tiers 2 and 3 never started, and they no longer belong in a
  file whose results section is about IMAP.
- **Priority:** P3 (inherited from US-013)
- **Estimate:** ~1 day for TOTP, ~1–2 days for SMS, ~0.5–1 day for social —
  see "What US-043 already paid for", which is why social is now the cheapest
  of the three rather than the most expensive.
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

## Acceptance criteria

**Tier 1 — TOTP**

- [ ] With a shared secret configured, the agent completes a login whose second
      factor is an authenticator code, end-to-end
- [ ] Codes match RFC 6238 test vectors, including across a time-step boundary
- [ ] The shared secret appears in no step, event, log, or report — asserted
      over the whole emitted payload, not field by field

**Tier 2 — SMS**

- [ ] With a number configured, the agent completes a signup requiring an SMS
      code, end-to-end
- [ ] Unconfigured, runs are byte-for-byte unchanged and the tool is absent
- [ ] The code and the phone number are absent from every emitted artifact
- [ ] The VoIP-rejection and per-message-cost limitations are documented

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
