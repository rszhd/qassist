# US-066 — List the session-capture extension on the Chrome Web Store

**As** a manual QA or an app owner — someone the side-load path in
`extension/README.md` was never really aimed at — **I want** to install the
QAssist Session Capture extension the normal way, **so that** "capture a
session without a terminal" doesn't still require `chrome://extensions` and
Developer mode, which is its own small terminal.

- **Status:** ⏳ **Submitted** 2026-08-03, 5/6 — `0.1.1` uploaded with every
  listing field, permission justification and disclosure answer from
  [`docs/chrome-web-store-listing.md`](../../../docs/chrome-web-store-listing.md).
  Only Google's review is left, and its outcome is the last criterion. Icons,
  the privacy policy page, the package script, the developer account and the
  five rendered screenshots all landed the same day. Packaging the build for
  this story is also what surfaced
  [BUG-009](done/BUG-009-permission-prompt-closes-the-capture-popup.md) —
  submit `0.1.1` or later, never `0.1.0`. Created 2026-07-31 as 📋 Planned.
- **Priority:** P2 — same footing as [US-063](done/US-063-capture-a-session-without-a-terminal.md)
  itself: a P3-adjacent feature a developer can already use in full (side-load
  works today) is not finished for the audience it was built for until this
  ships.
- **Estimate:** Unknown on purpose. The code side is small (icons, a package
  step); the review side is not estimable from here — see "Why this is mostly
  not a code task."
- **Depends on:** [US-063](done/US-063-capture-a-session-without-a-terminal.md)
  (built and hand-verified 2026-07-31; this is the distribution step it
  explicitly left out of scope).
- **Not** a rebuild of the extension's functionality. `extension/` already
  works, side-loaded, against a real site. This story is entirely about
  getting the same code in front of someone who will never open
  `chrome://extensions`.

## Why this is mostly not a code task

[US-063's Notes](done/US-063-capture-a-session-without-a-terminal.md#notes)
flagged this on the way in: "Submission, review turnaround and a
privacy-policy URL are all real, and the ~1–2 day estimate covers none of
them." Most of what is below is account setup, writing, and waiting on Google
— not a diff.

The one part that *is* code: `manifest.json` currently declares no icons at
all. The store requires at least a 128×128 PNG; Chrome itself wants 16/48/128
for the toolbar and extensions page. That's a real gap independent of when
this ships, not just a store formality.

The part likely to be slow: this extension asks for `cookies` and an
`optional_host_permissions: ["<all_urls>"]` ceiling (US-063's design — never
prompted directly, only used to let `chrome.permissions.request()` name an
arbitrary origin later). Google's review is stricter and slower for anything
that can touch arbitrary sites, and a manual reviewer reading the permission
justification cold does not have this repo's context for why the ceiling is
never itself shown to a user. Expect back-and-forth, not a rubber stamp.

## What's needed

- **A Google developer account** — one-time $5 registration.
- **Icons** — 16/48/128 PNG, added to `extension/` and wired into
  `manifest.json`.
- **A privacy policy page**, hosted at a stable URL, describing what the
  extension reads (cookies, localStorage, for one site the user names) and
  where it goes (the user's own QAssist instance, nowhere else).
- **Store listing assets** — short description (≤132 chars), a longer one,
  1–5 screenshots (1280×800 or 640×400), a category.
- **Permission justification**, written for a reviewer with none of this
  repo's context: why `cookies`, why `identity.email`, why the
  `<all_urls>` optional ceiling and why it never itself prompts.
- **Data-collection disclosure**, completed in the Developer Dashboard —
  this does collect and transmit cookies/session data, and the form asks
  directly.
- **A package** — in practice, zip `manifest.json`, `popup.html`, `popup.js`,
  `lib/storageState.js`. The test file and `extension/README.md` don't need to
  ship in the store bundle.

## Acceptance criteria

- [x] `extension/` has 16/48/128 icons, referenced from `manifest.json`
- [x] A privacy policy is live at a stable URL and linked from the store
      listing — live on production since `v0.5.0`, 2026-08-03; the *linked from
      the listing* half is part of submitting
- [x] Store listing assets (description, screenshots, category) are prepared —
      copy, category and five 1280×800 screenshots, all in the repo
- [x] Permission justification and the data-collection disclosure are
      submitted — 2026-08-03, all five justifications, the single-purpose
      statement, the three certifications and remote code answered No
- [x] The extension is packaged and submitted for review — `0.1.1` uploaded
      2026-08-03
- [ ] The listing is live — or, if the first pass is rejected, the rejection
      reasons are recorded here rather than silently retried

## Results (2026-08-03)

**Icons.** `extension/icons/icon{16,48,128}.png`, rasterized from
`frontend/public/favicon.svg` so the extension carries the same mark as the
app rather than a second one that drifts. Wired into `manifest.json` twice, on
purpose — `icons` (extensions page, store) and `action.default_icon`
(toolbar). Chrome will fall back from the second to the first, but the toolbar
is where a user actually looks for this extension, so it is stated rather than
inherited.

**A blocker the story did not know about.** `manifest.json`'s `description`
was 149 characters. The store's 132-character limit applies to that field too,
not only to the listing's short description, and it is enforced at upload — so
the first submission would have been rejected before a reviewer read a word of
it. It is now the same 122-character sentence as the listing's short
description, in both places, which is also one fewer string to let drift.

**Privacy policy.** `frontend/public/extension-privacy.html`, served at
`https://app.qassist.run/extension-privacy.html`. A standalone page, not a
route — the SPA is behind a login and the reviewer following that URL has no
account, so it carries its own copy of the handful of tokens it uses. It has
to be live *before* submitting; the dashboard fetches the URL.

Written 2026-08-03 and **live the same day, but only with `v0.5.0`** — until
that release the URL returned the SPA shell, because production tracks a
version tag and the file had only reached `dev`. A 200 from that URL is not
evidence the page is there: `index.html` is the fallback for every unmatched
path, so the check is the title, not the status code. The dashboard fetches
the URL at submission, so this had to lead.

The app host, not the apex, and deliberately: `qassist.run` is the landing
page and is hosted elsewhere, so a copy there would be a second file on a
second host, and this page has to track `manifest.json`'s permissions commit
by commit. The landing links to this URL instead of holding a copy, and its
own privacy policy — accounts, mail, Stripe, run artifacts — stays a separate
document. Full reasoning in the listing doc's prerequisites.

**Package.** `scripts/package-extension.sh` zips from inside `extension/`
(the store needs `manifest.json` at the zip root) and excludes the unit tests
and the side-load README. The exclusions are a blocklist on purpose: this
story's own description of the bundle listed `lib/storageState.js` and not
`lib/siteScope.js`, which `popup.js` also imports — an allowlist written from
that sentence would have shipped an extension that throws on load. The
blocklist earned itself a week later: `lib/pendingCapture.js`
([BUG-009](done/BUG-009-permission-prompt-closes-the-capture-popup.md)) shipped
with no change to the script at all. The current bundle is **11 entries,
41 kB, version 0.1.1**.

**What the packaged build turned up.** Loading the zip rather than
`extension/` is what put the extension in front of a first-ever capture, and
it failed: Chrome destroys the popup when it shows the host-permission prompt,
so every user's first attempt was silently lost
([BUG-009](done/BUG-009-permission-prompt-closes-the-capture-popup.md), fixed
and hand-verified 2026-08-03). Submitting `0.1.0` would have spent a review
cycle on a build whose primary flow does not work. Two things came out of that
fix which this story now depends on: the version is `0.1.1`, and the manifest
declares `minimum_chrome_version: "102"` for `chrome.storage.session`. The
store honours that field, so older browsers are never offered a build whose
popup cannot open.

**Listing copy.** [`docs/chrome-web-store-listing.md`](../../../docs/chrome-web-store-listing.md)
— name, short description (122 of 132 chars), detailed description, category
(Developer Tools), single-purpose statement, a justification per permission,
the data-collection table, and the screenshot plan. It lives in the repo
rather than in the dashboard alone so a rejection is answered by editing a
tracked file, and so the permission justifications stay honest to the code
they describe.

**Screenshots.** `scripts/make-store-screenshots.mjs` renders the five
1280×800 shots from `extension/popup.js` itself — the shipped markup,
stylesheet and state machine, with `chrome.*` stubbed and the flow seeded to
land on each screen. Staging five popup screens by hand produces a listing
asset nobody ever redoes; this one is a command, so it survives the next copy
change. The account email, the setup code and the site are placeholders, which
is not only cosmetic: a hand-taken shot of the account screen would have put
the maintainer's own Chrome profile email in a public listing.

Three things it had to get right, none of them obvious from the outside.
Headless Chrome takes its shot without waiting for the load event, so the page
settles by draining microtasks in a module that runs after `popup.js` rather
than on a timer that loses the race — an earlier `setInterval` version shipped
the success screen at the wrong zoom about half the time. The zoom is measured
from the rendered popup, because the explainer screen is three times the
height of the setup screen and one fixed value either clips it or strands the
others. And the server that feeds Chrome runs in the same process, so the
child must be spawned asynchronously — `execFileSync` blocks the event loop
and Chrome waits forever on a page that can never be served.

The disclosure's one non-obvious answer: **personally identifiable
information is "No"** even though the extension reads the Chrome profile
email. Google's "collect" means transmit off the device; the email is rendered
in the popup for the confirmation guard and never posted anywhere, including
to the user's own instance (`popup.js` puts `state.email` in markup and in no
request body). Authentication information and website content are "Yes" —
that is the cookies and the localStorage blob.

**Submitted 2026-08-03.** `0.1.1`, with the listing doc pasted field by field.

Two things the form asked for that nothing here had anticipated. The
**trader/non-trader declaration** is a publisher-level answer, not an item one,
and QAssist is a trader — the extension is free but it feeds a product with
Stripe billing, and the test is whether you act for purposes relating to a
business. Declaring it puts a legal name, address and SMS-verified phone
publicly at the foot of the listing. The first attempt failed with "your
personal information could not be verified", which is the Google payments
profile behind the form rather than anything in the submission; the reset that
worked is in the listing doc's prerequisites. Second, the **contact email is
verified separately on the Settings page**, and publishing is blocked until it
is — worth knowing before an upload day, because it is where every review
message then arrives.

### What is left, and why it is not code

- ~~**Developer registration**~~ — done 2026-08-03.
- ~~**Screenshots**~~ — done 2026-08-03, `node scripts/make-store-screenshots.mjs`.
- ~~**Upload and submit**~~ — done 2026-08-03, version `0.1.1`.
- **Google's review.** No committed turnaround: most items clear in under a
  day, but `cookies` plus the `<all_urls>` ceiling is the class a human reads,
  and this is a first submission from a new publisher. Expect days, and a
  fortnight is not abnormal. A rejection is recorded here, with its text; the
  fallback for the ceiling is unchanged.

## Notes

- `extension/README.md`'s side-load instructions stay documented regardless
  of this story's outcome — a self-hoster building their own copy, or anyone
  who doesn't want to wait on a store review, still needs that path. This
  story adds a second install route; it does not retire the first.
- If review rejects the `<all_urls>` ceiling outright, the fallback is
  narrowing `optional_host_permissions` to a curated list of common SSO
  provider domains (Google, Microsoft, etc.) rather than an arbitrary origin
  — worth recording here as a real possibility, not assuming the current
  manifest survives review unchanged.
