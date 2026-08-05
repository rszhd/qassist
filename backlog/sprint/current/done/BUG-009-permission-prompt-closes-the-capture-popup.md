# BUG-009: Chrome's permission prompt closes the capture popup, losing the flow

**Status:** ✅ Fixed 2026-08-03, hand-verified by the maintainer against a real
capture — the only thing that could prove it, since none of this is reachable
from a test harness in this repo
**Reported:** 2026-08-03 (found by the maintainer capturing `x.com`)
**Area:** extension (`extension/popup.js`, `extension/lib/pendingCapture.js`)

## Symptom

The **first** capture of any site fails, every time. The popup asks for the
host permission, the user clicks Allow — and nothing is captured. Running the
whole flow a second time works, because the permission is now granted and no
prompt appears.

A second face of the same fault: leaving the popup to copy the setup code from
QAssist also drops the flow. That one costs more than it looks — the app's
`CaptureSetupModal` drops its token when it closes and mints a fresh one on
re-open, so the user needs a *new* setup code, not just another paste.

## Root cause

A Chrome popup is destroyed the moment it loses focus, and
`chrome.permissions.request()` opens a browser-level dialog that takes it. The
`await` in `requestPermission()` therefore never resolves in a live context:
`state.token` and `state.origin` die with the popup and no capture is ever
attempted. Switching tabs destroys it the same way.

This is Chrome's documented popup behaviour, not a fault in the extension's
logic — which is why it survived
[US-063](US-063-capture-a-session-without-a-terminal.md)'s
hand-verification. That was done on a profile which had already granted the
permission, and the failure only exists on the first attempt for a given site.

## Why it is worth fixing now

It defeats the first capture every user ever attempts, and it reads as "the
extension does not work". It also undermines the verification US-063 closed
on. It blocks nothing in
[US-066](US-066-chrome-web-store-listing.md), but spending a
store review cycle on a build with this in it would waste the slowest resource
in that story.

## Fix

Persist the in-flight flow to `chrome.storage.session` on arrival at each
screen, and resume from it when the popup reopens.

**Why `storage.session`.** It is memory-only: never written to disk, dropped
when the browser closes, unreachable from content scripts. An MV3 service
worker holding the token in memory was the store-nothing alternative, but
Chrome terminates an idle worker after about 30 seconds, which is shorter than
the gap being covered. Moving the grant step to a full extension page — a tab,
which no dialog can dismiss — also stores nothing, but costs a second entry
point into the same flow.

**Why on arrival, not on the click that leaves.**
`chrome.permissions.request()` must be called inside the user gesture that
triggered it, so it cannot `await` a storage write first. Saving when the
screen renders means the write has long landed by the time that button exists.

**What is stored:** the setup token, the instance URL, the named origin, and a
timestamp. Never anything read out of the site — the assembled session still
goes straight from memory into the POST, as US-063 promised.

`chrome.storage.session` arrived in Chrome 102, so the manifest now declares
`minimum_chrome_version: "102"` — without it the store would offer this build
to browsers where the popup fails to open at all. Version bumped to `0.1.1`;
the store rejects a re-upload of a version it already holds, and this is the
first change since the packaging work in
[US-066](US-066-chrome-web-store-listing.md).

## Proving it is fixed

- [x] A first-ever capture of a site reaches the account screen: reopen the
      popup after clicking Allow and it lands on the confirmation, not setup
      — **hand-verified 2026-08-03**, the failing case from the report
- [x] Leaving the popup to copy the setup code and coming back resumes at the
      site-naming screen, with the same code still usable
- [x] An interrupted capture never re-posts by itself — resuming lands on the
      account confirmation and waits for it
- [x] A resumed flow older than 15 minutes is dropped, not carried to a 401
- [x] The captured session is still never written to any browser storage

The last three rest on `lib/pendingCapture.test.mjs` and on reading
`doCapture()`, not on a hand-run: a 15-minute wait and a mid-flight kill are
both awkward to stage by hand, and "nothing was written to storage" is a
property of code that does not exist rather than of a run that can be watched.
That is the same standard US-063 closed on — and the standard that missed this
defect, so it is worth naming rather than implying more was checked.

## Notes

- `lib/pendingCapture.js` is pure and unit-tested
  (`lib/pendingCapture.test.mjs`, 9 cases): the TTL boundary, a `savedAt` in
  the future, malformed entries, and the screen mapping — including that
  `capturing` and `needTab` both resume as `account` rather than as
  themselves. **The assertions were written by Claude alongside the
  implementation, not reviewed first.** Two of them are the kind that should
  have been: *an interrupted capture does not re-post* and *a pending entry
  dies with its token* are security properties, not wiring. Worth a read
  before they are trusted, and worth a row in
  [`correctness-critical.md`](../../../correctness-critical.md) if they survive it.
- `popup.js` now routes every screen change through one `go()` function, so a
  screen added later cannot forget to persist. One behaviour change came with
  that: "Back" on the "Open the site first" screen now re-reads the Chrome
  profile email instead of re-rendering the cached one. It strengthens the
  account guard rather than weakening it, but it was not asked for and should
  be noticed in review.
- Any future screen that opens a browser-level dialog inherits the same
  problem. That is the argument for eventually moving the whole flow into a
  tab, which this fix does not do.
