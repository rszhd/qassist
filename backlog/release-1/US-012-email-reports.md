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
- Provider: **Resend** (decided 2026-07-22) — good free tier, simple API, and
  US-021's magic-link auth reuses the same account. Set up the qassist.run
  sender domain (SPF/DKIM DNS records) alongside US-007's DNS work so
  propagation is done before this story starts.
- Digest mode (daily summary) = later nice-to-have.

## Acceptance criteria

- [ ] Failing scheduled run → email within minutes, with report accessible
- [ ] on-failure-only default doesn't email on passes
- [ ] Unsubscribe/prefs honored
