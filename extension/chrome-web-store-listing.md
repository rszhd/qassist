# Chrome Web Store listing — QAssist Session Capture

Everything the Developer Dashboard asks for, written once so a submission is a
paste rather than a fresh draft — and so a rejection can be answered by editing
a tracked file. The extension itself is `extension/`; the story is
[US-066](../backlog/sprint/current/US-066-chrome-web-store-listing.md).

## Prerequisites

The dashboard is <https://chrome.google.com/webstore/devconsole>.

- A Google account with **Chrome Web Store developer registration** ($5,
  one-time) — **done 2026-08-03**. Not tied to any account this repo knows
  about; it is whichever one should still own the listing in two years.
- A **contact email**, verified in the dashboard. It is not shown on the
  listing page, but Google's review correspondence goes there. Entering it is
  not enough — the Settings page verifies it separately, and publishing is
  blocked until that completes.
- A **trader declaration**, on the account rather than the item. QAssist is a
  trader: the test is whether you act for purposes relating to a trade or
  business, and this extension feeds a product with paid subscriptions, so
  free-to-install does not make it a hobby. Expect the legal name, address and
  an SMS-capable mobile to appear publicly at the foot of the listing — use an
  address you are content to publish. Verification runs through a Google
  payments profile, so a failure there reads as "your personal information
  could not be verified" while naming nothing about the submission. Check the
  profile's type first (Individual asks for a personal ID and address
  document, Organization for incorporation or tax papers — a company name
  against an Individual profile can never match), then dismiss the dialog,
  switch to non-trader and back to trader, which restarts the flow instead of
  retrying the half-filled state it left behind.
- The privacy policy live at
  **`https://app.qassist.run/extension-privacy.html`**
  (`frontend/public/extension-privacy.html`, shipped with the frontend build).
  It must be reachable before submitting — the dashboard checks the URL.

**Why the app host and not the apex.** `qassist.run` is the landing page and
is hosted elsewhere (`docs/deploy/production.md` → DNS), so a copy of the
policy there would be a second file on a second host. This page describes
exactly which permissions `extension/` declares, and it ships in the same
commit as the `manifest.json` it describes — a permission change and the
sentence explaining it move together. That is worth more than a prettier
hostname, because a policy that has quietly stopped matching the manifest is
the one page here that must not go stale. The landing links to this URL rather
than holding its own copy; the landing's *own* privacy policy is a different
document (accounts, magic-link mail, Stripe, run artifacts) and merging the
two would make both vaguer. If the apex is wanted on the listing later, a
redirect from `qassist.run/extension-privacy` keeps it to one copy — but
confirm Google's validator accepts a redirecting URL before relying on it.

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

**Screenshots** — five, 1280×800, in flow order:

```sh
node scripts/make-store-screenshots.mjs   # → dist/store-screenshots/*.png
```

They are rendered from `extension/popup.js` itself — the shipped markup,
stylesheet and state machine — with the `chrome.*` APIs stubbed and the flow
seeded to land on each screen. Re-run it when the popup's copy or styling
changes; a listing screenshot that has to be staged by hand is one that never
gets redone.

| # | Screen | Caption |
| --- | --- | --- |
| 1 | `setup` | Paste the one-time code from QAssist |
| 2 | `origin` | Name the one site to capture — never everything you browse |
| 3 | `explain` | See what will be read, and where it goes, before the browser asks |
| 4 | `account` | Confirm which account is about to be captured, every time |
| 5 | `success` | Sent once, to your own QAssist instance |

Screens 3 and 4 answer a reviewer's first question, so they should not be
dropped to save space.

**The data in them is placeholder, deliberately.** The account screen would
otherwise carry a real Chrome profile email into a public listing and the
setup screen a real capture token; the site is `app.example.com` rather than a
third party's brand. Everything else — every pixel of the interface — is what
the shipped extension renders.

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
refused until it is set). chrome.storage.local, never synced. A capture in
progress is also held in chrome.storage.session — the one-time setup code and
the site named — because Chrome destroys the popup when it shows its own
permission prompt, and without this the user loses the flow every time. That
storage is memory-only and the entry is dropped on success, on failure, and
after 15 minutes. The captured session itself is never stored anywhere in the
browser: it is posted and dropped.
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
