# BUG-013 — After a Resend, an *unconsumed* older email is returned as the new one

- **Status:** 🐛 Open (2026-08-10) — found in staging run
  `cf7a4e1e-2759-4f66-bd14-edd88ad378c6` (2026-08-09), the same run as
  [BUG-012](../sprint/current/done/BUG-012-footer-postcode-extracted-as-otp.md).
- **Lives in:** `agent/email_codes.py` (`wait_for_confirmation`) +
  `agent/run_agent.py` (`get_email_code`, `mail_since`)
- **Severity:** one "invalid or expired OTP" per occurrence, and the action's
  own description promises the opposite ("it waits for the new email, so a
  resent code is never confused with the one it replaced"). A promise the
  agent relies on and the code only half keeps invites exactly the retry loop
  BUG-010 closed.

## What happens

BUG-010's fix excludes messages the action has already **handed out**
(`consumed_email_ids`). It cannot exclude a message the action has never seen.

In the staging run the site's two registration emails (link, then OTP) meant
the first `get_email_code` call consumed only the link email. The OTP email
sat in the mailbox, unconsumed. The agent — following the instructions
correctly — pressed Resend and called `get_email_code(code_length=6)` in the
same step. The resend's email had not landed yet; the old OTP email was
addressed right, newer than `mail_since`, not in the consumed set, and six
digits wide. It came back on the first poll, carrying the code the Resend
click had just invalidated. The site answered "invalid or expired", truthfully.

The trigger is a site that sends more than one email per submission, which is
also the trigger for BUG-012 — but the two are independent: with BUG-012 fixed
this one still fires whenever an unconsumed email predates a Resend.

## Why it survived

BUG-010 was diagnosed on a single-email-per-submission flow, where "not yet
consumed" and "newly arrived" are the same set. Two emails per submission
splits them, and no test has a mailbox holding an unconsumed sibling at
resend time.

## Fix (proposed, not yet built)

`get_email_code` grows an `after_resend` flag (or the action always raises the
floor when `consumed_email_ids` is non-empty and the caller signals a resend):
when set, the `since` floor becomes roughly now minus a small skew (~30 s)
instead of the run-start floor, so mail predating the Resend click is refused
and the action genuinely waits for the new message. The 30 s look-back is
covered by resend cooldowns in practice (40–60 s on the staging site) but the
number needs the assertion-first treatment — this is register row 57, and the
`Date`-granularity trap documented in BUG-010 sits right next to it.

## Guarded by

Nothing yet. Owed: a `test_email_codes.py` case with an unconsumed older
sibling in the mailbox and a raised floor, proving the sibling is refused and
the post-resend message is waited for.
