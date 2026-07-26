# US-043 — Test what is behind the login

**As** someone whose app is mostly behind a login, **I want** a saved test to
start already authenticated, **so that** my suite tests the product instead of
testing my login form twenty times.

- **Status:** 📋 Planned. Handles credentials at rest — the storage half is
  correctness-critical and owes a row in
  [`correctness-critical.md`](../../correctness-critical.md) when scheduled.
- **Priority:** P2 of the next sprint (scheduled 2026-07-27) — arguably the single largest
  expansion of *what QAssist can test*, but it wants US-041's verdict to be
  trustworthy first.
- **Estimate:** ~6–8 h. New concept (a saved session), new storage, a UI, and a
  security story.
- **Depends on:** US-035 (run variables carry the credentials), US-021 (a
  session belongs to a user).

## Why now

Every run today starts from a cold browser. For any app worth testing, step 1
through 6 of every single run are: find the login, type the email, type the
password, submit, wait, dismiss the cookie banner. That is six LLM steps and
maybe forty seconds, per test, per run — paid for out of the user's own key
since US-039 — to reach the state the test actually cares about. It also means a
scheduled nightly suite hammers the customer's auth provider a few hundred
times, which is the kind of thing that gets an IP rate-limited.

Two `BrowserProfile`/`Agent` inputs we pass neither of:

- **`storage_state`** — cookies and `localStorage` in and out of a session, the
  Playwright-shaped blob. This is the actual mechanism.
- **`initial_actions`** — a deterministic action list executed *before* the LLM
  loop starts. Navigate, click, type, at zero token cost. Useful on its own for
  cookie banners, and it is how the login run itself gets scripted if we would
  rather not spend LLM steps on it.

## Details

**The shape.** A **saved session** belongs to a project (same reasoning as
US-012's notification prefs: an authenticated identity is something a team owns
once, not something each test repeats). A test opts into one. At spawn,
`run_agent.py` writes the blob to a temp file and passes
`BrowserProfile(storage_state=…)`.

**Producing the blob** is the interesting half, and there are two routes:

1. **A login run.** A designated test whose job is to authenticate; on success
   the agent exports `storage_state` and it is stored against the project. Reuses
   everything we have. Refreshing is "run the login test again" — which the
   scheduler can already do nightly.
2. **Paste it in.** For teams that already have a Playwright `storageState.json`
   in their repo. Cheap, and it covers SSO flows an agent will never survive.

Do both; (1) is the product, (2) is the escape hatch that makes it useful on day
one.

**The security story is the whole story.** A session blob *is* the credential —
holding one is being logged in. So: encrypted at rest with the same
`encryptSecret`/`decryptSecret` US-005 already uses for BYOK keys, never
returned by any read endpoint, decrypted server-side only to write the spawn's
temp file, and that file removed on run teardown alongside the artifacts. It
must never reach `report_data.json`, an event, the recording, or the PDF — and
since it lands in the browser rather than in the LLM's context, `scrub` is not
the guard here; containment is.

**Expiry is a user-facing state, not an error.** Sessions go stale. A run that
starts with a dead session will wander into the login page and fail with a
mystifying verdict. The run should detect "we are not who we thought" and say
so — the cheapest version is asserting the post-login landing URL or an
identifying selector via `initial_actions` before handing over to the LLM.

**`initial_actions` beyond auth.** Even without a session, a per-project
preamble ("dismiss the cookie dialog, close the promo modal") removes the two
most common wasted steps from every run in the project.

## Acceptance criteria

- [ ] A project can hold a named session; a saved test opts into it and its runs
      begin authenticated, with the login steps absent from the step list
- [ ] The session can be produced by a login run *and* by pasting a Playwright
      `storageState.json`
- [ ] The blob is encrypted at rest, is never returned by any API read, never
      appears in `report_data.json`, the events, the PDF or the recording, and
      its temp file is gone after the run
- [ ] A run whose session has expired fails with a verdict that says *the
      session expired*, not with a generic goal failure
- [ ] A project can define an `initial_actions` preamble that runs before the
      agent's first LLM step, and a run's step numbering makes clear the preamble
      was not charged as steps
- [ ] Measured: steps and wall-clock for one representative test with and
      without a session, recorded in this file (the README asks for numbers)
