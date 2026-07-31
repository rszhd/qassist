# US-066 — List the session-capture extension on the Chrome Web Store

**As** a manual QA or an app owner — someone the side-load path in
`extension/README.md` was never really aimed at — **I want** to install the
QAssist Session Capture extension the normal way, **so that** "capture a
session without a terminal" doesn't still require `chrome://extensions` and
Developer mode, which is its own small terminal.

- **Status:** 📋 Planned
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

- [ ] `extension/` has 16/48/128 icons, referenced from `manifest.json`
- [ ] A privacy policy is live at a stable URL and linked from the store
      listing
- [ ] Store listing assets (description, screenshots, category) are prepared
- [ ] Permission justification and the data-collection disclosure are
      submitted
- [ ] The extension is packaged and submitted for review
- [ ] The listing is live — or, if the first pass is rejected, the rejection
      reasons are recorded here rather than silently retried

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
