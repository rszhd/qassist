# US-012 — Failure email notifications

**As a** user, **I want** an email when a test run fails, **so that** I hear about breakage without checking a dashboard.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1 — on-failure notification only)
- **Estimate:** ~1 day
- **Depends on:** US-009 (Postgres for recipients/prefs); pairs with US-010

**Release-1 scope:** on-failure email only (the default). "Always"/"never"
prefs are cheap to include; digest mode stays out of Release 1.

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
