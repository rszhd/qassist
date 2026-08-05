# Behind your login

Most of what is worth testing is behind a sign-in. There are only two ways past
one, and knowing which you are using explains everything else on this page.

- **Reuse a session** — skip the login. The browser starts with cookies and
  local storage that already authenticate somebody, so the run opens on the
  dashboard rather than the login form.
- **Fetch a code** — complete the login. The agent drives the form, reads a
  confirmation code out of a mailbox, and types it.

**Reuse is the default and cheaper by a wide margin**: no tokens spent on six
steps of login, no flakiness in a form nobody is testing, no dependency on a
mailbox. Fetch a code when the login *is* the thing under test.

## Saved sessions

A project holds named **sessions** — a saved, signed-in browser state its tests
can start from. A test opts into one with **Start signed in**, and from then on
its runs begin already logged in.

That is what stops a nightly suite from testing your login form twenty times and
paying for it in steps.

### Three ways to fill one

**Nominate a login test** — the route for everyone, and the whole answer for an
ordinary username-and-password login. Create the session, point it at a saved
test whose job is to log in, and put the credentials in as [secret
variables](./variables.md). The next **passing** run of that test captures the
resulting state into the session.

Nothing is installed and no terminal is involved: the agent does the login. And
because you can already [schedule](./schedules.md) that test nightly, "the
session went stale" becomes something the machinery you have fixes on its own.

::: tip A failed login run never damages a working session
The stored state is left byte-identical unless the refresh run passes. A broken
login must not destroy the working credential it was meant to renew.
:::

**Capture with the browser extension** — for logins a test structurally cannot
drive, chiefly [social login](#social-login), and for anyone who would rather not
open a terminal. Side-load the extension, sign in to the site by hand in a tab
you already have open, and it reads the cookies and local storage and posts them
to your instance.

The extension has no QAssist login of its own. You mint a short-lived, single-use
**setup code** for exactly one session, paste it into the extension, and it fills
that session once. It authenticates nothing else and expires in fifteen minutes.

**Paste one** — the developer shortcut, if you already have Playwright open:

```bash
npx playwright open --save-storage=storageState.json https://your-app.example
# log in by hand in the window that opens, then close it
```

The session form never requires this. A login test or the extension are always
enough on their own.

### Telling a live session from a dead one

Set **verify URL contains** and/or **verify text** on the session. They are
checked *before the agent's first model step*, so an expired session costs one
verdict instead of a wandering twenty-step failure whose report blames your goal.
The run ends failed with `session_expired`, which CI, the mail and the PDF all
read.

::: warning The URL check matches host and path only, on purpose
`/login?next=/dashboard` is the most common shape of a login redirect, and it
*contains* `/dashboard`. Matching the whole URL would report a dead session as
live — the exact bug the check exists to catch.
:::

A test that opts into a session which has never been captured is **refused at
run start**, with nothing enqueued, rather than run signed out. A test that
quietly runs signed out passes nothing and fails everything.

### You can never read a session back

A saved session *is* the credential — holding one is being logged in, with no
password left to steal and no second factor left to clear. So it is encrypted at
rest with the same key that protects your stored OpenAI key, decrypted only to
write one run's temporary file, and that file's directory is removed when the run
ends. No endpoint and no screen ever returns it.

What you get instead is its shape: how many cookies, how many origins, and when
it was captured. That is enough to judge a session's health without ever seeing
it.

## Confirmation codes by email

With a mailbox configured on the instance, the agent can poll it for a
confirmation code or link and type it — for up to three minutes. One mailbox
serves many signups through plus-addressing (`inbox+qa-<tag>@example.com`) or a
catch-all domain.

The fetched code goes through the same redaction as a
[secret](./variables.md#secrets): the model only ever sees a placeholder, and the
real value is stripped from the steps, the frames and the report.

::: warning The mailbox is instance-wide
There is one slot: no per-project mailbox and no way to give two projects
different inboxes. That is a real limitation rather than a simplification, and it
is the first thing that breaks if you need several accounts with separate
inboxes.
:::

## Second factors

**Email is the only second factor QAssist fetches.** An authenticator app (TOTP)
and an SMS code are both unsupported, and there is no setting that turns either
on.

**What works today instead:** point a staging environment at your auth
provider's OTP test mode, and no code needs fetching. Twilio Verify has test
credentials that always verify without sending a message; Firebase Auth registers
test phone numbers with fixed codes; most providers have an equivalent. The
fictional number is then an ordinary [variable](./variables.md), the fixed code
is a secret one — so a schedule can fire it unattended — and the goal types it
like any other secret. This is also the only shape that repeats daily.

## Social login

**It works, through a saved session** — and only because the session does the one
thing the agent cannot.

From a cold browser it is impossible, permanently. The agent clicks "Continue
with Google", lands on the provider's page, and has to type a Google password
into the one form Google refuses to serve to an automated browser. Nothing on
this side fixes that.

What makes it work is that a saved session need not be a session for *your* app.
It can be a session for **the provider**, and which one you save decides what the
run can test:

| What you save | What the run can do |
|---|---|
| **Your app's signed-in state** (log in via Google by hand, then capture) | Starts past the login and never clicks the button. This is what you want for testing what is behind the wall — which is most tests, most of the time. |
| **The provider's signed-in state** (sign in at the provider, then capture) | Starts signed in to Google but signed out of your app. The agent clicks "Continue with Google" and completes the handshake for real, because the provider recognises the session and shows only the account chooser and consent screen. Use this to test the social login flow itself. |

Four things to know before relying on either:

**The [navigation fence](./navigation-fence.md) blocks the provider.** If your
project has an allowlist set to your own domain, the hop to the provider is
refused, and the failure names a blocked URL rather than anything about login.
Add the provider's hosts to the allowlist — do not remove the allowlist, since a
hole in the fence is not a fence, and this is the one setting standing between a
run and a browser signed in to a real account.

**A provider identity is one-shot against your app.** The first run signs up;
every rerun lands on "welcome back" instead of the registration funnel — and
still passes, while no longer testing what its name says. This is the sharp edge
because it fails silently. Testing signup rather than what is behind it needs a
pool of provider accounts or a reset hook that deletes the test user between
runs, and neither exists yet.

**Plus-addressing does not multiply identities.** It gives one mailbox many
addresses, which is how the email route gets many signups from one inbox. Social
login authenticates the *account* and hands your app the canonical address — the
`+qa-x` suffix never reaches you. The trick that solves email signup does nothing
for social signup.

**Use dedicated throwaway provider accounts.** The saved state carries the
provider's cookies as well as your app's, so it grants whatever that account can
reach.

## What is out of reach

- **The agent typing a provider password.** Providers block sign-in from
  automated browsers. This is not a gap waiting to be closed — it is the reason
  session reuse exists.
- **CAPTCHA and bot detection.** Out of scope. Social login makes an encounter
  *more* likely, not less.
- **A Google session replayed from an automated browser.** Confirmed by
  measurement: a captured session with every cookie a real login sets still
  rendered a cold sign-in form when replayed. Reuse still works for *your app's*
  session, where the button is never clicked; it is specifically the
  provider-only variant — testing the handshake itself — that Google blocks.
