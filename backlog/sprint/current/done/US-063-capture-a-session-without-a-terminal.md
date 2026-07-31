# US-063 — Capture a session without a terminal

**As** an app owner or a manual QA — someone who has never opened a terminal and
never will — **I want** to hand QAssist a signed-in browser state by logging in
myself, **so that** the flows only a human can authenticate are testable by the
people this product is for.

- **Status:** ✅ **Shipped and hand-verified 2026-07-31.** Filed 2026-07-28 out
  of writing
  [`docs/auth-in-tested-flows.md`](../../../../docs/auth-in-tested-flows.md), which
  could not describe how a non-developer sets up social login because there is
  no way, and scheduled into `sprint/current/` the same day, alongside US-059.
  **Approach decided the same day: option B, a browser extension.** The
  rejected alternative and the reasoning are kept below. Every AC is met except
  the store listing, which the story's own Notes puts out of scope. See
  Results, including the CORS bug the live pass caught.
- **Priority:** P2 — see "Why P2 when it serves a P3 story", which is the part
  worth arguing with.
- **Estimate:** ~1–2 days for the extension and the endpoint it posts to, plus
  store submission and an indefinite maintenance tail that the day count does
  not capture and should not be allowed to hide.
- **Depends on:** [US-043](US-043-reusable-authenticated-sessions.md)
  (the session it fills, and the encrypt/store/teardown path it reuses wholesale),
  US-021. Unblocks [US-059](../US-059-otp-and-social-login-in-tested-flows.md) tier 3
  for anyone who is not a developer.
- **Not** [US-062](../../../unscheduled/US-062-live-browser-test-tier.md). That is a headless test
  tier for the maintainer, proving US-042's redirect and US-043's round-trip.
  The names are close enough to be mixed up and the two share no code.

## The gap

US-043 gives a session two ways to be filled, and they do not cover the same
people:

- **A login test** captures the blob on its next passing run. Credentials go in
  as US-035 `secret` variables, the agent drives the form, nothing is installed.
  For an ordinary username-and-password login this is complete, and most users
  never need anything else.
- **A paste** takes a `storageState.json` the user produced with
  `npx playwright open --save-storage=…`.

The first cannot do social login — a login test would have to type a Google
password into the one form Google refuses to serve to an automation-controlled
browser, which is permanent and not ours to fix. So SSO falls to the paste
route, and the paste route needs Node, a terminal and Playwright.

That is the whole bug, and it is a shape rather than a defect: **the only flow
where the escape hatch is the sole option is the flow whose users are least able
to use it.** `frontend/src/Sessions.jsx` already refuses to require a paste for
exactly this reason ("requiring the paste would make Playwright a
prerequisite") — this story is that refusal finished.

## Why P2 when it serves a P3 story

US-059 tier 3 is P3, and normally a dependency does not outrank its dependent.
The argument for P2 anyway: this is not scoped to social login. It is the answer
to *"can the user QAssist is sold to reach any credential the agent cannot type
itself"*, and today the answer is no with no workaround. A P3 feature that a
developer can use and the target user cannot is not 30% shipped.

The counter-argument, which is real: if social login stays unscheduled, this
builds a browser-streaming surface for nobody. **If that lands, file it P3 and
say so here** — the point of writing both sides down is that the demotion should
be a decision rather than a drift.

## The decision: a browser extension (2026-07-28)

Two approaches close this gap, and they fail differently — the difference is
mostly about whose browser holds the credential. **We are building the
extension.** It reads cookies and localStorage out of the browser the user is
already signed in to, assembles a `storageState`, and posts it to their
instance. No server-side browser, no input relay, and no password ever comes
near us — which is the simplification that decided it.

The install ask is judged acceptable: someone who has already run tests against
their own site and is now wiring up authentication has met the product, and an
extension is a normal thing for a testing tool to ship.

**Three things follow from that choice and are constraints, not caveats.** They
are what the acceptance criteria below are mostly about.

- **The trust ask is the permission prompt, not the install.** Assembling a
  `storageState` needs cookies *and* localStorage, and localStorage means a
  content script on the origin — which Chrome renders as "Read and change all
  your data on the websites you visit". For a tool that is also asking to hold a
  Google session, that dialog is the moment a user balks, and it is what store
  review examines. Keep the requested scope as narrow as the API permits and
  make the extension explain itself *before* the prompt, not after.
- **It is the first piece of QAssist a self-hoster cannot own.** Everything else
  is `docker compose up` and it is theirs. An extension lives in our store
  account, signed by us, and must be told which instance to post to — an
  arbitrary origin, possibly a LAN address, which widens host permissions
  further. This is a real crack in [`docs/repo-model.md`](../../../../docs/repo-model.md)'s
  posture. It does not sink the decision, but the source belongs in this repo
  and an unpacked/self-built install path must stay documented and supported.
- **It reads the user's daily browser, and that is the sharp edge.** The
  extension works *because* the Google session is already there — in their real
  browser, on their real account. So the path of least resistance captures a
  personal account, and we then store it. Documentation will not beat
  convenience here; the guard has to be in the product. See the acceptance
  criteria: name the account before capturing it, and make the personal one the
  awkward path rather than the default.

### Rejected: an interactive browser inside QAssist

The server opens a Chromium, streams it into the session UI, relays the user's
clicks and keystrokes into it, and captures `storageState` when they say they
are done.

What already exists: the app image ships Chromium and Playwright, so there is no
new dependency. The WS relay already broadcasts `frame` events to a viewer. The
capture half is built end to end — `QA_STORAGE_STATE_OUT`,
`browser_session.to_storage_state`, and `browserSession.js`'s encrypt-and-store,
which is what a `login_run` capture already uses.

What is new, and it is one thing: **input relay.** Pointer and key events from
the viewer, over the WS, into CDP `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent`, with coordinates scaled from the rendered frame to the
viewport. Everything else is assembly.

The costs are honest and worth stating before anyone starts:

- **A human holds a browser for minutes.** Runs are bounded; a person staring at
  a login form is not. This collides with US-028's per-user concurrency and needs
  an idle timeout and a reaper of its own — the demo reaper (US-036) is the
  nearest existing pattern, not a reusable one.
- **The user types a real password into a browser we host.** Over TLS to our
  box, but it is our process. This is the trust question and it does not have a
  technical answer, only a disclosed one.
- **`source` gains a third value.** `'pasted' | 'login_run'` is a check
  constraint in `015`; an interactive capture is neither, and the UI's "from a
  login run / pasted" label is what a user reads to judge a session's age. New
  migration, and `015` is never edited.

**What we give up by not building it.** One thing worth naming: a streamed,
interactive browser is the surface a "record a test by doing it" feature would
need, and the extension does not move us toward it at all. That was never a
reason to build A — scoping a second feature into this one is how both arrive
late — but if recording is ever wanted, this decision buys nothing toward it and
A's cost would need paying then.

**What the extension gives up in exchange for its simplicity** is the credential
hygiene A got for free: a fresh browser makes you type a password, and choosing
which account to type is the natural moment to choose a throwaway. The extension
has no such moment, which is why it has to manufacture one.

## Acceptance criteria

**The capture works.**

- [x] A user with no terminal, no Node and no Playwright installs the extension
      and creates a session holding a signed-in state, using only their browser
      and the QAssist UI
- [x] The captured blob reaches the same encrypted column by the same path a
      `login_run` capture uses — no second writer, no second encryption
- [x] A capture that is abandoned or rejected leaves **no** blob, no partial row
      and nothing on disk
- [x] A failed capture leaves an existing session's stored bytes byte-identical
      (US-043's rule, which this adds a second way to violate)
- [x] The blob appears in no response body, event, log or artifact — asserted
      over whole payloads, as `session-containment.test.js` does
- [x] The docs stop describing the terminal as the only route to social login

- [x] An extension capture is distinguishable in the UI from a pasted or
      login-run one — `source` is a check constraint in `015` and gains a third
      value by new migration; `015` is never edited

**The permission scope is defensible.** The extension has to survive both a
store reviewer and a suspicious user.

- [x] Host permissions are requested per origin the user names, not `<all_urls>`
- [x] The extension states what it will read and where it will send it *before*
      the browser's permission prompt, not after
- [x] It holds a token that can post a session and do nothing else — not a
      full-privilege API key
- [x] The instance URL is user-configured and works against a self-hosted
      origin, including a LAN address

**The personal account is the awkward path.** The guard is in the product, not
in the docs — this is the constraint the approach was chosen in spite of, so it
is the one most likely to be quietly dropped.

- [x] Before capturing, the extension names the account it is about to capture
      and requires an explicit confirmation
- [x] Capturing from a browser profile the user has not marked as a test profile
      is refused, or takes a deliberate override that says what is being accepted
- [x] The throwaway-account guidance appears at the moment of capture, not only
      in `auth-in-tested-flows.md`

**The self-hoster is not locked out.**

- [x] The extension source lives in this repo, and building and side-loading it
      unpacked is documented and works without our store listing

## Correctness-critical

**Yes, and by extension rather than by a new row.** This adds a *new writer* to
the surface already registered as **Saved browser sessions (US-043)** in
[`correctness-critical.md`](../../../correctness-critical.md) — a row whose failure
description already runs to six distinct ways the credential path breaks,
including "the failed refresh that clobbers" and "the empty session that runs
anyway", both of which this story can reintroduce through a door US-043 never
had.

Per the Workflow rule: extend that row's assertions before the implementation
exists, do not duplicate it. The genuinely new assertion is the **abandoned
capture** — a user dismissing the extension's confirm is a fifth way a capture
ends, and US-043's row already records that "the end that was not enumerated"
was one of the six things that nearly shipped wrong.

The extension adds a second surface that row does not currently cover: the blob
now exists *outside* the server, in a browser process we do not control, between
being read and being posted. The assertion to get reviewed first is that it is
never persisted there — no `storage.local`, no cache, no retry queue holding a
credential after a failed post.

## Notes

- This does not make a *cold* social login possible. The agent still cannot type
  a Google password; the story only changes who can produce the session that
  makes the button work.
- The store listing is on the critical path and is not a code task. Submission,
  review turnaround and a privacy-policy URL are all real, and the ~1–2 day
  estimate covers none of them.

## Results

**Built 2026-07-31.** Server layer landed first (`018_extension_session_capture.sql`,
`sessionCapture.js`, `browserSession.js`'s `captureFromExtension`,
`routes/capture.js`, the `capture-token` mint route, `createSession`'s
`capture_method: 'extension'` relaxation), spec'd assertion-first in
`session-capture-token.test.js` per the Correctness-critical section above —
E1 (not a full-privilege key), E2 (single-use), E3 (a malformed post doesn't
burn the token), E4 (a failure after the token is spent leaves stored bytes
byte-identical), E5 (nothing echoes the blob), plus the dead-end-guard and
mint-scoping cases. Then the extension (`extension/`: MV3 manifest, a
no-framework `popup.js` state machine for the paste → name-the-site →
explain-before-prompt → account-guard → capture flow, and
`lib/storageState.js`'s pure chrome-cookie → Playwright-cookie /
localStorage → `origins[]` mappings, unit-tested in
`lib/storageState.test.mjs`), then `Sessions.jsx` (a third create-time option,
the `source === 'extension'` label, and a "Capture with browser extension"
action that mints a token and shows it once as a copy-once setup code, same
pattern as `ApiKeys.jsx`'s fresh key), then docs
(`auth-in-tested-flows.md`'s Social login section, `api.md`'s new capture
endpoints section, `extension/README.md`).

Green: `server && npm test` (678 tests; the one failure,
`AGENT_PROVIDED_SECRETS matches...`, predates this story — it's US-059's
`run_agent.py` sensitive-keys list drifting from `variables.js`'s exemption
list, unrelated to session capture) and `npm run check`; `frontend && npm
test` (86) and `npm run build`; `node extension/lib/storageState.test.mjs`
(10); `node scripts/check-doc-links.mjs`.

**Acceptance criteria met by code and tests**, on inspection: the encrypted
column is shared with `refreshCapturedSession` rather than duplicated; an
abandoned or rejected capture writes nothing (the server never sees a request
until the final POST, and the popup never persists the assembled blob — see
`popup.js`'s own header comment on `doCapture()`); a failed capture leaves
existing bytes byte-identical (E4); the blob is echoed nowhere (E5, and the
popup never `console.log`s it); `source` distinguishes an extension capture in
the UI; host permissions are requested per-origin via
`chrome.permissions.request()`, never `<all_urls>` as an actual prompt; the
explain screen renders before that request; the capture token is scoped to
one route and one use; the instance URL comes entirely from the setup code
(works against a LAN address with zero extension-side configuration); the
account-name-and-confirm screen and the per-profile `isTestProfile` refusal
gate every single capture, not just the first; the extension's source and
side-load instructions live in this repo and need no store listing.

### Hand-verified live, 2026-07-31 — and a real bug it caught

Nothing in the sandbox this was built in can drive a real browser, so the
maintainer ran the actual pass: `cd server && npm run dev` +
`cd frontend && npm run dev` against a fresh `.env`, `extension/` side-loaded
unpacked at `chrome://extensions`, a setup code minted from the real Sessions
UI, and a real capture against `https://x.com` in a real signed-in tab.

**First attempt failed: `Failed to fetch` on the POST.** The design in this
plan (see "Extension" above, point 8) asserted the popup's `fetch()` to
`/api/capture` needed no host permission and no CORS handling because it runs
in the extension's own background context rather than a content script. That
conflated two different browser mechanisms: extension pages *do* skip a
page's CSP, but a cross-origin `fetch()` from an extension page is still
ordinary CORS unless the extension holds a host permission for the target —
and this extension deliberately does not request one for the QAssist origin,
by design (only the captured site gets a permission prompt). The server sent
no `Access-Control-Allow-Origin` at all, so the browser's own preflight
rejected the call before it ever reached `routes/capture.js`.

Fixed in `routes/capture.js`: the router now answers its own CORS preflight
and stamps `Access-Control-Allow-Origin: *` on every response, including
errors. `*` is deliberate, not a shortcut — the capture token, not the origin
header, is what actually gates this route, and the caller's origin
(`chrome-extension://<id>`) is a different, unpredictable string on every
install (unpacked, store, or moved-on-disk) this server could never
enumerate. Two new assertions (E6 in `session-capture-token.test.js`) pin
both the preflight and the real response so this can't silently regress —
had they existed before the extension was written, the plan's mistaken
assumption would have been caught by `npm test` instead of by a live click.

**Second attempt, after the fix: real capture, real result.** `source ext`
project's session now reads `"source":"extension"`, `"cookie_count":15`,
`"origin_count":1`, `"captured_at"` set — landed through the exact same
`captureFromExtension` → `encryptSecret` → `storage_state_ciphertext` path a
`login_run` capture uses, with real cookies from a real site the maintainer
was already signed in to. That closes the "capture works" AC and the
no-terminal AC by demonstration rather than by inspection.

**Still not separately re-verified**: attaching that captured session to a
test and confirming a run starts authenticated. That's not new machinery —
`captureFromExtension` writes through the identical encrypted column
`refreshCapturedSession` does, and *that* load path is US-043's own
already-tested territory — but it wasn't exercised again here as a full run.
Worth a spot-check next time a session captured this way is actually attached
to something, rather than a blocker on its own.

Also flagged rather than skipped silently, per the story's own framing: the
chrome.* glue itself — permission prompts, `chrome.identity`,
`chrome.scripting`, the popup's own screens — has no automated test harness in
this repo (no puppeteer-loads-unpacked-extension setup exists, and building
one was out of scope). Only `lib/storageState.js`'s pure mapping functions are
unit-tested; the rest is the same hand-verified-on-a-real-site category
US-043's results called out for browser-use itself — and now it has been.

### The spot-check above happened, and found a second real bug

Attached a `myaccount.google.com` capture to a real x.com "Continue with
Google" test. First capture: 3 cookies, none of them the ones that matter — a
granted host permission for the exact typed host doesn't cover a cookie
scoped to the parent domain (`Domain=.google.com`, how Google's own session
cookies work), and `chrome.cookies.getAll` silently drops anything outside
granted permissions. Fixed with `lib/siteScope.js` (unit-tested): request the
registrable domain and a subdomain wildcard alongside the exact host, not
just the one origin typed. Recapture: 15 cookies, a complete and genuinely
valid set (`SAPISID`, `__Secure-1PSID`/`3PSID`, `SSID`, `NID`, the full
`SIDCC`/`SIDTS` rotation set).

Even so, the OAuth run still rendered a cold, unauthenticated Google sign-in
form. That's not a QAssist bug — Google's own automation detection refuses to
honor a session replayed through a CDP-controlled browser, valid or not.
Written up in `docs/auth-in-tested-flows.md`'s "Not possible" section.
