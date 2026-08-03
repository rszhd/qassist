# US-066 — List the session-capture extension on the Chrome Web Store

**As** a manual QA or an app owner — someone the side-load path in
`extension/README.md` was never really aimed at — **I want** to install the
QAssist Session Capture extension the normal way, **so that** "capture a
session without a terminal" doesn't still require `chrome://extensions` and
Developer mode, which is its own small terminal.

- **Status:** 🔨 **Prepared** 2026-08-03, 3/6 — everything that does not need a
  Google account is built and tracked: icons, the privacy policy page, the
  package script, and every listing field written out in
  [`docs/chrome-web-store-listing.md`](../../../docs/chrome-web-store-listing.md).
  The three open criteria all wait on a person at the dashboard — see Results.
  Created 2026-07-31 as 📋 Planned.
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
      listing — page written and shipping with the frontend; the *linked from
      the listing* half is part of submitting
- [x] Store listing assets (description, screenshots, category) are prepared —
      copy and category written; screenshots still to take (see Results)
- [ ] Permission justification and the data-collection disclosure are
      submitted — both written; submitting needs the dashboard
- [ ] The extension is packaged and submitted for review — packaging done
      (`scripts/package-extension.sh`); submitting needs the account
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

**Package.** `scripts/package-extension.sh` zips from inside `extension/`
(the store needs `manifest.json` at the zip root) and excludes the unit tests
and the side-load README. The exclusions are a blocklist on purpose: this
story's own description of the bundle listed `lib/storageState.js` and not
`lib/siteScope.js`, which `popup.js` also imports — an allowlist written from
that sentence would have shipped an extension that throws on load. The
current bundle is 10 entries, 35 kB.

**Listing copy.** [`docs/chrome-web-store-listing.md`](../../../docs/chrome-web-store-listing.md)
— name, short description (122 of 132 chars), detailed description, category
(Developer Tools), single-purpose statement, a justification per permission,
the data-collection table, and the screenshot plan. It lives in the repo
rather than in the dashboard alone so a rejection is answered by editing a
tracked file, and so the permission justifications stay honest to the code
they describe.

The disclosure's one non-obvious answer: **personally identifiable
information is "No"** even though the extension reads the Chrome profile
email. Google's "collect" means transmit off the device; the email is rendered
in the popup for the confirmation guard and never posted anywhere, including
to the user's own instance (`popup.js` puts `state.email` in markup and in no
request body). Authentication information and website content are "Yes" —
that is the cookies and the localStorage blob.

### What is left, and why it is not code

- **Developer registration** ($5, one-time) on the Google account that should
  still own the listing in two years.
- **Screenshots** — five, 1280×800, listed in the doc. The popup is 320px
  wide, so each one is the popup composited on a background; taking them needs
  the extension side-loaded against a real capture.
- **Submit**, then wait. The `<all_urls>` optional ceiling is still the part
  most likely to draw a question (see above), and the fallback is unchanged.

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
