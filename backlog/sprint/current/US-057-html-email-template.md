# US-057 — An HTML template for outgoing email

**As a** recipient of a magic-link, failure-report or activation email, **I
want** a readable, branded message, **so that** the mail doesn't look like a
debug log dropped in my inbox.

- **Status:** 🔨 **Built 2026-07-27, 4/5.** The template, the transport change
  and all four send sites are in, with tests. The one criterion left is the one
  no test can answer: what it actually looks like in Gmail and Apple Mail. See
  [Results](#results) for how to check it in a couple of minutes.
- **Priority:** P3
- **Estimate:** ~0.5 day
- **Depends on:** —

## Details

`mail.js` only ever sends Resend's `text` field — `sendMail()` has no `html`
parameter, and none of its three callers (`routes/auth.js` magic link,
`notify.js` run reports, `activation.js` activation mail) build one. Every
outgoing message today is plain text, unstyled, with no qassist branding.

The template needs to cover all three current send sites without diverging
into a different message per caller:

- `routes/auth.js` — magic-link sign-in
- `notify.js` — run pass/fail report (goal, verdict, duration, link to the
  run, PDF attached)
- `activation.js` — activation-window mail

**Correction found while implementing: there are four send sites, not three.**
`activation.js` sends two — `mailOperatorWaiting` (who is waiting, by when, the
command to fix it) and `mailCustomerReady` (the promise kept). They go to
different people and say opposite things, so they are two messages sharing one
layout, which is exactly the case the story is about.

## Acceptance criteria

- [x] `sendMail()` accepts an `html` body alongside `text` (both sent to
      Resend; `text` stays the fallback for clients that render it and for
      `MAIL_DEV_CONSOLE`)
- [x] One shared template/layout (logo or wordmark, consistent spacing and
      type) that the three callers fill in, not three one-off HTML strings
- [x] Unsubscribe link and `List-Unsubscribe` header still present in the HTML
      version wherever they apply today
- [ ] Renders correctly in at least Gmail and Apple Mail (dark mode included —
      don't assume a white background)
- [x] Existing mail tests still assert against `text` unchanged; add coverage
      that `html` is present and non-empty on all three send paths

## Results

**One layout, four fillers.** `server/src/mailTemplate.js` holds the document
and a small block vocabulary — `paragraph`, `note`, `facts`, `panel`, `pre`,
`button`, `rawLink` — and each caller passes a heading, an optional verdict
badge and a list of blocks. `mail.js` stays the transport: it gained one
optional `html` field and nothing else. The constraints that make this a
different medium from the app are written up in
[`docs/design-system.md`](../../../docs/design-system.md) → "Email", because
they outlive the story; the short version:

- **Dark, and only dark, for a reason that isn't taste.** Gmail ignores
  `prefers-color-scheme` and instead inverts *light* mail by itself, so a light
  template is two renders nobody controls — and the half-inverted state (a
  background it repainted, a foreground it didn't) is the one that's unreadable.
  Clients leave an already-dark message alone. One render everywhere, and it
  happens to be the app's own palette, copied from `App.css`'s `:root` as
  literals because an email can't have a stylesheet.
- **Inline styles on tables, nothing fetched.** The Gmail app strips `<style>`
  for non-Gmail accounts; Outlook lays out with Word. The wordmark is text, so
  the brand can't be a grey box behind "display images below" — and there is no
  pixel that reads as tracking.

**The header carries the mark as well as the wordmark** (added 2026-08-04). The
check from `TopBar.jsx` sits left of the word, and it gets there as an inline
attachment the body references as `cid:qassist-mark` — the two mechanisms that
need no attachment were both dead ends: Gmail strips `<svg>` from a body
outright, and its web client strips `data:` image sources, which is precisely
the missing-brand gap the no-network rule exists to avoid. So the rule holds
unchanged (nothing is *fetched*) while the assertion that pinned it had to
move: `mail-template.test.js` asserted no `<img>` and no `src=` at all, and now
asserts every `src` is a `cid:`. That is the "behaviour was meant to change"
case, and this paragraph is the reason it was.

`renderEmail` returns `{ html, attachments }` rather than a string, and the four
send sites spread it. The alternative — export the attachment beside the
renderer and have each caller remember to pass it — fails silently: a body
without its image is a broken picture in every inbox and a suite that stays
green. `notify.js` concatenates the report PDF onto that list instead of
replacing it.

**Escaping is the load-bearing test, not a nicety.** A goal, a start URL and the
judge's own prose all arrive at the template from outside and land in someone
else's inbox. `mail-template.test.js` pins that every block escapes, that a
quote can't terminate a `style="…"` or `href="…"`, and — separately — that the
document references nothing on the network. Those two are the properties that
would fail silently: a broken layout is visible, an escaped-wrong one isn't.

**The sign-in mail had no test at all.** `auth.test.js` pins the crypto and
`auth-isolation.test.js` the consume; neither had ever looked at what Resend
receives. `auth-mail.test.js` is new and does, against a loopback provider like
`notify.test.js` — including that the button's `href` is the same link the text
body prints, which is the failure mode a "html is non-empty" assertion misses.

**Text bodies are byte-for-byte unchanged** on every path; the existing
assertions in `notify.test.js` and `activation-gate.test.js` still hold, with an
html assertion added beside each. 385 tests pass (from 374), `npm run check`
clean.

### What is left, and how to close it

The render criterion needs a human and a real inbox. `npm run mail-preview` in
`server/` starts a Resend-shaped sink that writes every message the app sends to
`/tmp/qassist-mail/` as `.html` + `.txt`:

```
cd server && npm run mail-preview          # prints the URL and the out dir
RESEND_API_URL=http://127.0.0.1:8025/emails npm run dev   # MAIL_DEV_CONSOLE unset
```

Then request a sign-in link and run `npm run activate` to capture three of the
four; a finished run captures the fourth. It writes what the real composers
produced, so a preview cannot drift from what a recipient gets. Open the files
in a browser for the layout, forward them to a Gmail and an Apple Mail account
for the render — that last step is the criterion, and the sink exists so it
costs a forward rather than a deploy.

The sink writes each inline attachment beside the `.html` and points the
reference at the file, because a browser resolves no `cid:` — without that the
mark would be a broken image in every preview and read as a bug in the template.
Only the preview copy is rewritten; forwarding it still exercises the real
`cid:` path in a real client, which is the half a browser can't answer.
