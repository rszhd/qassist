# Getting a run past a login

How a test reaches the part of the tested product that is behind
authentication. This file is the contributor's map: where the code lives, and
the design decisions with their reasons. What a *user* does — the two
strategies, the three capture routes, social login, and what is out of reach —
is the manual's [Behind your
login](https://docs.qassist.run/saved-sessions.html) (source:
[`manual/saved-sessions.md`](../manual/saved-sessions.md)); the endpoints are
[`api.md`](api.md#starting-a-run-already-logged-in).

This is about the **app under test**, never about logging in to QAssist
itself — that is US-021's magic link, and it lives in `server/src/auth.js`.
The two are unrelated and the vocabulary collides, which is why
`015_browser_sessions.sql` named its table `browser_sessions` rather than
`sessions`.

## Where the code lives

- **Saved sessions.** A project holds named sessions; a test opts into one via
  `tests.browser_session_id`. The stored value is a Playwright `storageState`,
  encrypted under `KEY_ENCRYPTION_SECRET`, written to a temp file at spawn and
  loaded as `BrowserProfile(storage_state=<path>)`; the temp directory is
  removed when the run ends. No read path returns the blob. The containment
  discipline and its traps are `server/src/browserSession.js` and its row in
  [`backlog/correctness-critical.md`](../backlog/correctness-critical.md).
- **Only a passing run of the nominated login test writes new state** — a
  broken login must never destroy the working credential it was meant to
  renew, so a failed refresh leaves the stored blob byte-identical.
- **The liveness check runs before the first LLM step**, which is the whole
  point of it: an expired session costs one verdict
  (`failure_reason = 'session_expired'`) instead of a wandering twenty-step
  failure. `verify_url_contains` matches host + path only; the manual page
  says why.
- **Email codes.** The agent gets a `get_email_code` action that polls IMAP.
  The fetched value goes through browser-use `sensitive_data`, so the model
  only ever sees `<secret>email_code</secret>` and `agent/redact.py` strips the
  real value from steps, frames and `report_data.json`. Unconfigured, the tool
  is not registered and runs are byte-for-byte what they were before the
  feature landed.

## Why TOTP and SMS were removed

**Email is the only second factor QAssist fetches.** TOTP and SMS were built
and then removed on 2026-08-04, unreleased and never proven against a live
gated site. Each had shipped as one credential in the server's process
environment, inherited by every run on the box, and that is the wrong place
for both:

- A **TOTP shared secret** is minted by one site for one account and *is* that
  account's second factor. Nothing about it multiplexes, so one slot per
  machine means the second account that needs 2FA cannot have one — while the
  tool and its task paragraph attach to every other tenant's runs regardless.
- An **SMS number** has no per-run discriminator the way a mailbox address
  does, so two concurrent runs can steal each other's code — and a *pool* of
  numbers is a standing monthly rental on every carrier, all of it VoIP,
  which many sites refuse outright.

A replacement will be planned against those constraints rather than patched
into that shape; the requirement is parked in
[US-059](../backlog/unscheduled/US-059-otp-and-social-login-in-tested-flows.md),
which records what was learned.

## Google refuses replayed sessions from automation

Confirmed 2026-08-01 (US-063): a captured Google session with every cookie a
real login sets still rendered a cold sign-in form when replayed through
browser-use — Google's automation detection refuses to honor it, independent
of the cookies being genuinely valid. Not unique to us: PhantomBuster, whose
product is session-cookie automation, supports LinkedIn, Instagram, Facebook,
X and Slack this way and does not offer Google at all. This blocks the
provider-only variant — testing the OAuth handshake itself — and only that;
reuse of *the tested app's* own session is unaffected, because the button
never gets clicked.

## Planned and known gaps

[US-059](../backlog/unscheduled/US-059-otp-and-social-login-in-tested-flows.md)
(P3, unscheduled since 2026-08-04 — it needs replanning, not resuming) holds
the non-email second factor and the productisation of social login.

[US-077](../backlog/sprint/current/US-077-test-mail-without-gmail.md) (P2) takes
the test mailbox off Gmail IMAP, and carries **per-project mailboxes** as its
last tier. Until it lands, `QA_IMAP_USER` / `QA_IMAP_PASSWORD` are read from
the process environment and inherited by every run on the instance — one slot
per deployment, no per-project mailbox.

One further gap is known and in no story at all:

- **A pool or reset hook** for one-shot provider registration identities: the
  first run signs up, every rerun lands on "welcome back" and still passes
  while no longer testing what its name says.
