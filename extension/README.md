# QAssist Session Capture (extension)

Reads cookies and localStorage out of a browser you are already signed in to,
and posts the result to your own QAssist instance as a `browser_sessions` row
— the third way to fill one (US-063), alongside a login test and a pasted
`storageState.json`. It exists for logins a test can never drive: social login,
where the site itself refuses to serve its form to an automation-controlled
browser.

No password ever reaches QAssist. The extension never sees one either — it
reads the cookies and local storage a signed-in tab already holds.

## Install (unpacked — no store listing required)

This is the only install path today; see "What's not done" below.

1. Open `chrome://extensions` (or the equivalent in any Chromium browser).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` directory.
4. Pin it (puzzle-piece icon in the toolbar → the pin next to "QAssist
   Session Capture") so it's easy to reopen.

No build step: this is plain JS + a manifest, matching this repo's stance on
build steps (see the root `CLAUDE.md`).

## Use it

1. In QAssist, open a project's **Sessions** tab, add or pick a session, and
   click **Capture with browser extension**. Copy the setup code shown — it's
   a one-time code, good for 15 minutes.
2. In a tab you already control, sign in to the site you want to capture
   (Google, your app, whatever the session is for) the normal way.
3. Open the extension popup, paste the setup code, and follow the screens:
   name the site, approve the browser's permission prompt, confirm the
   signed-in account, and it captures.
4. The popup tells you when it's done. The session now shows "captured via
   extension" in QAssist.

## What it asks for, and why

- **`cookies`, `scripting`, `storage`, `identity.email`** — requested at
  install, and that's all that prompts then. `identity.email` reads the
  signed-in Chrome profile's email with no OAuth consent screen; it's how the
  extension names the account it's about to capture.
- **A host permission for one site, asked at the moment you name it** — not
  `<all_urls>` up front. The manifest declares `<all_urls>` as an *optional*
  permission ceiling (Chrome's API requires that to let
  `chrome.permissions.request()` name an arbitrary origin later), but that
  ceiling is never itself shown to you. The only prompt you ever see is
  Chrome's own, for the site you typed — its registrable domain and
  subdomains (`lib/siteScope.js`), not just the exact host. That's
  deliberately wider than one exact hostname: a cookie scoped to a parent
  domain (`Domain=.google.com`, how Google's own session cookies work, shared
  across `accounts.`, `myaccount.` and every other subdomain) is invisible to
  `chrome.cookies.getAll` unless a granted host permission covers it too —
  found live against a real Google account, where the first cut of this
  extension captured 3 cookies out of a real session's 10+, none of them the
  ones that mattered. Still one site, never `<all_urls>`, right after the
  popup explains what it's about to do and where it's going.
- **The capture token** — pasted in as part of the setup code, valid once, for
  15 minutes, and only for the one session it was minted for. It authenticates
  nothing else; losing it leaks no more than that one 15-minute window.

## The account guard

The extension reads your *daily* browser by design — that's what makes it
work at all. That's also the sharp edge: the path of least resistance
captures a personal account. Two things stand in the way, every single time:

- The popup shows the signed-in Chrome profile's email and requires an
  explicit confirmation before every capture, not just the first.
- Capture is refused outright until you mark the current browser profile as a
  test/disposable one, in the extension's Settings screen. That flag lives
  only in this browser profile (`chrome.storage.local`, never synced) and
  gates every capture from it.

Neither is a technical barrier to using a personal account if you truly mean
to — the guard is a deliberate stop, not a lock.

## What never happens

- A fresh tab is never opened and navigated to the target site — that tab
  would be signed out, defeating the entire mechanism. Local data is read
  only from a tab you already had open, already signed in.
- The assembled session is never written to `chrome.storage`, IndexedDB, or
  anywhere else in the browser, and a failed post is never retried
  automatically. A failure means starting the capture again from a fresh
  setup code — there is no queue holding a credential in the meantime.
- The blob is never echoed back in any response the popup reads; the server
  answers a bare `204` on success.

## What's not done

- **No store listing.** This ships side-loaded only, for now. A store review
  is a separate, non-code effort (see the story file, US-063) and is out of
  scope here.
- **No automated test of the chrome.* glue** — permission prompts,
  `chrome.identity`, `chrome.scripting`, the popup's screens. There's no
  puppeteer-loads-unpacked-extension harness in this repo, and building one
  was out of scope for this story. `lib/storageState.js`'s pure mapping
  functions are unit-tested (`lib/storageState.test.mjs`); the rest is
  hand-verified against a real site with a real SSO button.
