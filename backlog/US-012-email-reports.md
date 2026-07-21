# US-012 — Email reports

**As a** user, **I want** run results emailed to me (especially failures), **so that** I hear about breakage without checking a dashboard.

- **Status:** 📋 Planned
- **Priority:** P3
- **Estimate:** ~1 day
- **Depends on:** US-009 (Postgres for recipients/prefs); pairs with US-010

## Details

- Per-test notification prefs: on-failure-only (default) / always / never;
  recipient list.
- Send on run completion: verdict, goal, duration, final-result text, link to
  (or attachment of) the PDF report. Attachment is easy — the PDF is
  single-page and small.
- Provider: SMTP or a transactional service (Resend/SES/Mailgun) — pick when
  building; needs domain sender setup (SPF/DKIM) once US-007's domain exists.
- Digest mode (daily summary) = later nice-to-have.

## Acceptance criteria

- [ ] Failing scheduled run → email within minutes, with report accessible
- [ ] on-failure-only default doesn't email on passes
- [ ] Unsubscribe/prefs honored
