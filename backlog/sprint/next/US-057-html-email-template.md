# US-057 — An HTML template for outgoing email

**As a** recipient of a magic-link, failure-report or activation email, **I
want** a readable, branded message, **so that** the mail doesn't look like a
debug log dropped in my inbox.

- **Status:** 📋 Planned
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

## Acceptance criteria

- [ ] `sendMail()` accepts an `html` body alongside `text` (both sent to
      Resend; `text` stays the fallback for clients that render it and for
      `MAIL_DEV_CONSOLE`)
- [ ] One shared template/layout (logo or wordmark, consistent spacing and
      type) that the three callers fill in, not three one-off HTML strings
- [ ] Unsubscribe link and `List-Unsubscribe` header still present in the HTML
      version wherever they apply today
- [ ] Renders correctly in at least Gmail and Apple Mail (dark mode included —
      don't assume a white background)
- [ ] Existing mail tests still assert against `text` unchanged; add coverage
      that `html` is present and non-empty on all three send paths
