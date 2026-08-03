# Chrome Web Store listing — QAssist Session Capture

Everything the Developer Dashboard asks for, written once so a submission is a
paste rather than a fresh draft — and so a rejection can be answered by editing
a tracked file. The extension itself is `extension/`; the story is
[US-066](../backlog/sprint/current/US-066-chrome-web-store-listing.md).

## Prerequisites

- A Google account with **Chrome Web Store developer registration** ($5,
  one-time). Not tied to any account this repo knows about — pick the one that
  should still own the listing in two years.
- A **contact email**, verified in the dashboard. It is not shown on the
  listing page, but Google's review correspondence goes there.
- The privacy policy live at
  **`https://app.qassist.run/extension-privacy.html`**
  (`frontend/public/extension-privacy.html`, shipped with the frontend build).
  It must be reachable before submitting — the dashboard checks the URL.

## The package

```sh
./scripts/package-extension.sh      # → dist/qassist-session-capture-<version>.zip
```

Ships `manifest.json`, `popup.html`, `popup.js`, `lib/`, `icons/`. Leaves out
the unit tests and `extension/README.md`, which are for someone reading the
repo, not for a store copy. Bump `version` in `extension/manifest.json` before
each upload — the store rejects a re-upload of a version it already has.

## Listing fields

**Name**

```
QAssist Session Capture
```

**Short description** (store limit 132 characters — 122 here)

```
Send a signed-in browser session for one site you name to your own QAssist instance, for tests that can't drive the login.
```

The same 132-character limit applies to `description` in `manifest.json`, and
it is enforced at upload rather than at review. Keep the two strings identical:
the first cut of the manifest was 149 characters and would have been rejected
before anyone read the listing.

**Category:** Developer Tools · **Language:** English

**Detailed description**

```
QAssist Session Capture hands one signed-in browser session to QAssist, the
goal-based AI browser testing tool, so a test can start already logged in.

It exists for the logins a test can never drive itself: social login, where
the site refuses to serve its form to an automation-controlled browser, and
anything else behind a step a script cannot repeat.

How it works:

1. In QAssist, open a project's Sessions tab and click "Capture with browser
   extension". You get a one-time setup code, good for 15 minutes.
2. Sign in to the site you want to capture, in a normal tab, the normal way.
3. Open this extension, paste the code, and name the site. The extension says
   exactly what it is about to read and where it will go, before Chrome's own
   permission prompt for that one site.
4. Confirm the account. It captures, posts once to your QAssist instance, and
   is done.

What it does not do:

- It never asks for, sees, or stores a password.
- It reads one site — the one you name and approve. Never everything you
  browse.
- It sends to one place: the QAssist instance address you typed. There is no
  server belonging to this extension, no analytics, and no third party.
- It never keeps the captured session in the browser. The data is assembled,
  posted, and dropped.

Before every capture it shows you which Chrome profile you are signed in as
and makes you confirm, and it refuses to capture at all until you have marked
the profile as a test/disposable one in Settings. Capturing your daily
personal account should take a deliberate act, not an absent-minded click.

QAssist is open source and self-hostable, and this extension talks to whichever
instance you point it at — your own or the hosted one. Source:
https://github.com/rszhd/qassist
```

**Screenshots** — 1280×800, up to five, in flow order. The popup is 320px
wide, so each is the popup composited on a plain background rather than a raw
capture:

1. `setup` — pasting the setup code.
2. `origin` — naming the one site.
3. `explain` — what will be read and where it goes, before the browser prompt.
4. `account` — the profile email and the confirmation.
5. `success` — with the QAssist Sessions tab behind it showing "captured via
   extension".

Screens 3 and 4 are the two that answer a reviewer's first question, so they
should not be dropped to save effort.

## Single purpose

```
Capture the cookies and local storage of one website the user names, from a
tab they are already signed in to, and send them to the QAssist instance they
specify, so that automated tests on that instance can run as a signed-in user.
```

## Permission justifications

Each field takes one answer. Written for a reviewer with no context on this
repo — say what the user sees, not how the code is arranged.

**`cookies`**

```
The extension's only function is to hand a signed-in session to the user's own
testing instance. Session cookies are that session. They are read only for the
single site the user typed and approved in Chrome's host permission prompt,
only at the moment they press Capture, and they are sent only to the instance
address the user entered.
```

**`scripting`**

```
Some sites keep their session in localStorage rather than cookies. This is
used for exactly one injection — reading window.localStorage from the tab the
user already has open for the site they named — and for nothing else. No
content script is registered, nothing is injected in the background, and no
page is modified.
```

**`storage`**

```
Two settings persist between uses: the address of the user's own QAssist
instance, and a flag marking this Chrome profile as a test profile (capture is
refused until it is set). chrome.storage.local only, never synced. The
captured session is deliberately not stored — it is posted and dropped.
```

**`identity.email`**

```
Before every capture the popup shows which Chrome profile is signed in and
requires the user to confirm it, so nobody captures a personal account by
accident. The address is displayed in the popup and is never transmitted
anywhere, including to the user's own instance.
```

**Host permissions (`<all_urls>`, optional)**

```
The extension cannot know in advance which site a user will test, and Chrome
requires a declared optional host permission before chrome.permissions.request
can ask for an arbitrary origin at run time. It is never requested as a whole
and never prompts on its own: the only host prompt a user sees names the one
site they just typed, and it covers that site's registrable domain and
subdomains because session cookies are commonly scoped to a parent domain
(Domain=.example.com) and are otherwise invisible to chrome.cookies.getAll.
No site is accessed without a permission the user granted for that site.
```

**Remote code:** No. The package contains all its own JavaScript; nothing is
fetched and executed.

## Data-collection disclosure

Chrome's meaning of "collect" is transmit off the user's device, which makes
the answers narrower than they first look:

| Category | Answer | Why |
| --- | --- | --- |
| Authentication information | **Yes** | Session cookies and localStorage tokens are transmitted. |
| Website content | **Yes** | localStorage values for the named site travel in the same blob. |
| Personally identifiable information | **No** | The Chrome profile email is shown in the popup and never leaves the device. |
| Health, financial, location, web history, user activity | **No** | None read. |

All three certifications apply and can be checked:

- Data is not sold or transferred to third parties (there is no third party —
  the destination is a server the user names).
- Data is not used for any purpose unrelated to the item's single purpose.
- Data is not used for creditworthiness or lending.

## If it is rejected

Record the rejection text in the story file, not here — this file is what gets
submitted, so it should always read as the current submission. The one change
already anticipated: if the `<all_urls>` optional ceiling is refused outright,
the fallback is a curated `optional_host_permissions` list of common SSO
domains, which costs the ability to capture an arbitrary first-party app.
