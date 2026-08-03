# Getting a run past a login

How a test reaches the part of your product that is behind authentication —
saved sessions, email confirmation codes, and social login. This is about the
**app under test**, never about logging in to QAssist itself: that is US-021's
magic link, and it lives in `server/src/auth.js`. The two are unrelated and the
vocabulary collides, which is why `015_browser_sessions.sql` named its table
`browser_sessions` rather than `sessions`.

Operational how-to (the endpoints, the request bodies) is
[`api.md`](api.md#starting-a-run-already-logged-in). This file is the *why*, and
the map of what is and is not reachable.

## There are only two strategies

Every auth wall is answered one of two ways, and knowing which one you are
using explains most of what follows.

- **Reuse a session** — skip the login entirely. The browser starts with cookies
  and localStorage that already authenticate somebody, so the run opens on the
  dashboard rather than the login form. Shipped: US-043.
- **Fetch a code** — complete the login. The agent drives the form, then reads
  the confirmation code out of a mailbox and types it. Shipped for email
  (US-013 tier 1). A second factor that is *not* emailed — an authenticator app
  or an SMS — has no support today; see [Second factors](#second-factors).

Reuse is the default and the cheaper of the two by a wide margin — no tokens
spent on six steps of login, no flakiness in a form nobody is testing, no
dependency on a mailbox. Fetch a code when the login *is* the thing under test,
or when there is no session to reuse yet.

## Reuse a session

A project holds named sessions; a test opts into one via
`tests.browser_session_id`. The stored value is a Playwright `storageState` —
cookies plus localStorage — written to a temp file at spawn and loaded as
`BrowserProfile(storage_state=<path>)`.

Three ways to fill one:

**Nominate a login test** — the route for everyone. Point the session at a
saved test whose job is to log in, and put the credentials in as `secret`
variables (US-035). Its next *passing* run captures the resulting state into the
session. Nothing is installed and no terminal is involved: the agent does the
login. Because the scheduler already runs saved tests nightly, "the session went
stale" becomes something the existing machinery fixes on its own, with no new
concept. A failed refresh leaves the stored blob byte-identical — a broken login
run must never destroy the working credential it was meant to renew.

For an ordinary username-and-password login this is the whole answer, and the
rest of this section is not something you need.

**Capture with the browser extension** (US-063) — for the logins a test
structurally cannot drive, chiefly social login (see below), and for anyone
without a terminal. Side-load `extension/` (`extension/README.md` has the
steps), sign in to the site by hand in a tab you already have open, and the
extension reads its cookies and localStorage and posts them straight to your
instance — no Node, no terminal, no Playwright. It works for any session the
paste route below can fill, not only social login.

**Paste one** — the developer shortcut. Produce a `storageState.json` yourself
and post it:

```bash
npx playwright open --save-storage=storageState.json https://your-app.example
# log in by hand in the window that opens, then close it
```

Useful if you already have Playwright open for something else and would rather
save straight to a file. The session form never requires it
(`frontend/src/Sessions.jsx`) — a login test or the extension are always
enough on their own.

**Telling a live session from a dead one.** Set `verify_url_contains` and/or
`verify_text`. They are checked *before the first LLM step*, so an expired
session costs one verdict rather than a wandering twenty-step failure whose
report blames your goal. The run ends `failed` with
`failure_reason = 'session_expired'`, which CI, the mailer and the PDF all read.
Both are optional; a session with neither behaves exactly as a run does today.

`verify_url_contains` matches against host + path only, deliberately.
`/login?next=/dashboard` is the most common shape of a login redirect and it
*contains* `/dashboard` — matching the whole URL would report a dead session as
live, which is the exact bug the check exists to catch.

**A session blob is the credential.** Holding one is being logged in: there is
no password left to steal and no second factor left to clear. So it is
encrypted at rest under `KEY_ENCRYPTION_SECRET`, never returned by any read
endpoint, decrypted only to write one spawn's temp file, and that directory is
removed when the run ends. The counts and `captured_at` exist so you can judge a
session's health without ever seeing it.

## Fetch a code

Configure a mailbox and the agent gains a `get_email_code` action: it polls
IMAP for up to 180 seconds, extracts a code or a confirmation link, and types
it. One mailbox serves many signups through plus-addressing
(`inbox+qa-<runtag>@gmail.com`) or a catch-all domain (`QA_MAILBOX_DOMAIN`).

The fetched value goes through browser-use `sensitive_data`, so the model only
ever sees `<secret>email_code</secret>` and `agent/redact.py` strips the real
value from steps, frames and `report_data.json`. Unconfigured, the tool is not
registered and runs are byte-for-byte what they were before the feature landed.

**The mailbox is deployment-wide.** `QA_IMAP_USER` / `QA_IMAP_PASSWORD` are read
from the process environment and inherited by every run on the instance. There
is one slot: no per-project mailbox, no UI, no way to give two projects
different inboxes. That is a real limitation, not a simplification, and it is
the first thing that breaks if you need several accounts with separate inboxes.

### Second factors

**Email is the only second factor QAssist fetches.** An authenticator app (TOTP)
and an SMS code are both **unsupported**, and there is no environment variable
that turns either on.

Both were built and then removed on 2026-08-04, unreleased and never proven
against a live gated site. Each had shipped as one credential in the server's
process environment, inherited by every run on the box, and that is the wrong
place for both:

- A **TOTP shared secret** is minted by one site for one account and *is* that
  account's second factor. Nothing about it multiplexes, so one slot per machine
  means the second account that needs 2FA cannot have one — while the tool and
  its task paragraph attach to every other tenant's runs regardless.
- An **SMS number** has no per-run discriminator the way a mailbox address does,
  so two concurrent runs each take the newest message and can steal each other's
  code. It is also an account key at the site under test, so a scheduled daily
  signup fails on day two with "already registered" — and a *pool* of numbers is
  a standing monthly rental on every carrier, all of it VoIP, which many sites
  refuse outright.

A replacement will be planned against those constraints rather than patched into
that shape; the requirement is parked in
[US-059](../backlog/unscheduled/US-059-otp-and-social-login-in-tested-flows.md),
which records what was learned.

**What works today without any of it:** point a staging environment at your auth
provider's OTP test mode and no code needs fetching. Twilio Verify has test
credentials that always verify without sending a message, and Firebase Auth
registers test phone numbers with fixed codes; most providers have an
equivalent. The fictional number is then an ordinary
[run variable](../backlog/sprint/current/done/US-035-run-variables.md), the fixed
code is a `secret` one (stored encrypted, so a schedule can fire unattended —
US-064), and the goal types `<secret>otp_code</secret>` like any other secret.
This is also the only shape that repeats daily.

## Social login

**It works today, through the paste route** — but only because the saved session
does the one thing the agent cannot.

From a cold browser it is impossible, and permanently so. The agent clicks
"Continue with Google", lands on `accounts.google.com`, and has to type a Google
password into the one form Google refuses to serve to an automation-controlled
browser. Nothing on our side fixes that; see [Not possible](#not-possible).

What makes it work is that a saved `storageState` need not be a session for
*your* app. It can be a session for **the provider**. Which one you save decides
what the run can test, and the two are worth keeping straight:

- **Save your app's signed-in state** (log in via Google by hand, then save).
  Runs start past the login and never click the button. Use this to test what is
  behind the wall — which is most tests, most of the time.
- **Save only the provider's signed-in state** (sign in at
  `accounts.google.com`, then save). Runs start signed in to Google but signed
  out of your app. The agent clicks "Continue with Google" and completes the
  OAuth flow *for real*, because Google recognises the session and never shows a
  password form — leaving only the account chooser and consent screen, which are
  ordinary pages an agent can click. Use this to test the social login flow
  itself.

Four things to know before you rely on either.

**Setting it up no longer requires a terminal.** Both variants above begin "log
in by hand, then save" — the browser extension
([US-063](../backlog/sprint/current/done/US-063-capture-a-session-without-a-terminal.md))
is exactly that: sign in to the provider or your app in a tab you already have
open, and it reads the resulting jar and posts it to your instance. The
login-test route still cannot substitute here — a login test would have to
type a Google password, which is the thing that does not work — but a manual
QA or an app owner no longer needs Node, Playwright, or a terminal to do what
the developer escape hatch used to be the only way to do. See
[Capture with the browser extension](#reuse-a-session) above and
`extension/README.md` for install and permission details.

**The navigation fence blocks the provider.** US-042's `allowed_domains` is
project-scoped and opt-in — empty means no fence. If you *have* set one to your
own domain, the OAuth hop to `accounts.google.com` is refused by browser-use's
SecurityWatchdog, and the failure names a blocked URL rather than anything about
login. Add the provider's hosts to the fence. Do not widen the fence for login
runs specifically: a hole in the fence is not a fence, and this is the one
setting standing between a run and a browser that is signed in to a real Google
account.

**A provider identity is one-shot against your app.** The first run signs up;
every rerun afterwards lands on "welcome back" instead of the registration
funnel — and *still passes*, while no longer testing what its name says. This is
the sharp edge, because it fails silently. If you are testing the signup flow
rather than what is behind it, you need either a pool of provider accounts or a
reset hook that deletes the test user between runs. Neither exists yet.

**Plus-addressing does not multiply identities.** It gives one mailbox many
addresses, which is how the email tier gets many signups from one inbox. OAuth
authenticates the *account* and hands your app the canonical
`inbox@gmail.com` — the `+qa-x` suffix is not part of the identity and never
reaches you. The trick that solves email signup does nothing for social signup.

Use dedicated throwaway provider accounts. The saved blob contains the
provider's cookies as well as your app's, so it grants whatever that account can
reach, and the fence is what keeps a run from going there.

## Not possible

- **The agent typing a provider password.** Google blocks sign-in from
  automation-controlled browsers. This is not a gap waiting to be closed — it is
  the reason the session-reuse route exists at all.
- **CAPTCHA and bot detection.** Out of scope. Social login makes an encounter
  *more* likely, not less: an automated browser on a Google login form is
  exactly what that detection is built for, which is again why the answer is to
  reuse a session instead of typing anything.
- **A Google session, even a complete and valid one, replayed from an
  automated browser.** Confirmed 2026-08-01 (US-063): a captured session with
  every cookie a real login sets — `SAPISID`, `__Secure-1PSID`/`3PSID`, `SSID`,
  `NID`, the full `SIDCC`/`SIDTS` set — still rendered a cold, unauthenticated
  sign-in form when replayed through browser-use. Google's own detection of
  the automated browser (and likely the network context differing from where
  the session was captured) refuses to honor it, independent of the cookies
  being genuinely valid. Not unique to us: PhantomBuster, whose product is
  session-cookie automation, supports LinkedIn, Instagram, Facebook, X and
  Slack this way and does not offer Google at all. Reuse still works for
  *your app's* session (the button never gets clicked); it's specifically the
  provider-only variant — testing the OAuth handshake itself — that this
  blocks for Google.

## Planned

[US-059](../backlog/unscheduled/US-059-otp-and-social-login-in-tested-flows.md)
(P3, unscheduled since 2026-08-04 — it needs replanning, not resuming) holds all
three:

- **A second factor that is not emailed** — TOTP and SMS, to be designed against
  the constraints in [Second factors](#second-factors) rather than as one
  credential in the server's environment.
- **Social, productised** — largely documentation rather than plumbing: which
  provider hosts to add to the fence, how to hold a provider test user, and
  re-proving expiry detection against a provider redirect, whose shape differs
  from a first-party one.

Two further gaps are known and in no story at all:

- **Per-project mailbox credentials** — `QA_IMAP_*` is one slot per deployment.
- **A pool or reset hook** for one-shot registration identities.

A third — capturing a session without a terminal — does have a story,
[US-063](../backlog/sprint/current/done/US-063-capture-a-session-without-a-terminal.md),
and it is the one that decides whether social login is a feature for this
product's users or only for developers. Note that US-062 is *not* it: that is a
headless test tier for the maintainer, not an interactive browser for a user.
