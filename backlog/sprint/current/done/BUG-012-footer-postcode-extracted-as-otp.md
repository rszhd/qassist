# BUG-012 — A link-only email's footer postcode is extracted as the OTP

- **Status:** ✅ Fixed 2026-08-10 — found in staging run
  `cf7a4e1e-2759-4f66-bd14-edd88ad378c6` (2026-08-09), which typed a Kuala
  Lumpur postcode into a six-box OTP field and then looped on Resend until it
  was cancelled by hand. On `dev`; not yet exercised against a real mailbox.
- **Lives in:** `agent/email_codes.py` (`extract_code`, `_code_candidates`)
- **Severity:** the same costume BUG-010 wore — a confident wrong answer that
  reads, from every downstream vantage point, as the tested site rejecting
  valid codes. The `code_length` guard from BUG-010 cannot catch it, because
  the first `get_email_code` call happens before the agent has seen the OTP
  field and so has no width to state.

## What happens

The tested site (SMART, `smartv2-sp.econstruct.com.my`) sends **two** emails on
registration, 22 seconds apart:

1. "Email Verification" — an activation *link*, **no code**.
2. "Your OTP Code" — the six-digit code the activation page asks for.

Both carry the same footer: `Jalan Putra, 50350 KUALA LUMPUR`.

The agent calls `get_email_code` right after submitting the form —
correctly, and necessarily with `code_length: 0`, because the OTP field is
*behind* the link and has not been seen yet. The call returns email 1. No code
keyword appears anywhere in it, so `extract_code` falls through to the bare
`\b\d{4,8}\b` fallback, which takes the first digit run in the body: the
postcode. The action hands back "a verification code — type
`<secret>email_code</secret>`" *and* the link, the agent opens the link, meets
six boxes, and types `50350` into them. Five boxes fill; the site says invalid;
the run enters the Resend spiral (whose second defect is
[BUG-013](../../../bugs/BUG-013-unconsumed-stale-email-after-resend.md)).

There is a second, smaller miss in the same run: in email 2 the code sits 26
characters after the word "OTP" ("…Password (OTP) on the activation page:
053604"), which is outside `_CODE_NEAR_KEYWORD`'s 20-character window. The
right code was still found — by the bare fallback, and only because the code
happens to precede the footer in the body. That is luck, not selection.

## Why it survived

Every extraction fixture in `test_email_codes.py` is a hand-written sentence
shaped like "Your code is 123456". A real transactional email is mostly *not*
the code: footers carry postcodes, phone numbers and street numbers, and a
link-only email carries **nothing but** those. No fixture had a digit run that
was not the code, so the bare fallback's appetite was never measured.

## Fix (assertion-first — register row 57; assertions reviewed 2026-08-10)

1. **The bare-number fallback runs only when the email talks about a code.**
   If neither subject nor body mentions code/otp/pin/passcode/password, a digit
   run is a postcode, an order number, a street address — not a code.
   `extract_code` returns `None` and the action reports the link alone.
   Deliberate behaviour change: a keyword-free "your reference is 5567" no
   longer yields a code; the old assertion said it did.
2. **The keyword window widens 20 → 40 characters**, so "One-Time Password
   (OTP) on the activation page: 053604" is found by the *keyword* path and
   selection stops depending on the footer's position in the body.

With 1 in place the staging cascade never starts: the first call returns the
link alone, the agent opens it, counts six boxes, and its second call carries
`code_length=6` — which the fresh OTP email satisfies.

## Guarded by

`agent/tests/test_email_codes.py` (`TestExtractCodeStagingEmails`) — fixtures
cut from the two real staging emails, plus the keyword-gate and window cases.

## Result

Both parts landed as proposed. Three assertions written and red first: the
link-only email yields no code; a bare number in a keyword-free email is not a
code (the deliberate flip of the old "reference is 5567" assertion); and a
body whose footer *precedes* the code still answers the code, which is the
window widening — the first version of that test passed before the fix, via
the very fallback under indictment, and had to be sharpened until the wrong
answer was available first. 339 agent tests pass, 54 of them in
`test_email_codes.py`, up from 51.

What is **not** proved: the same caveat as BUG-010 — everything runs against
hand-cut bodies, so a real mailbox is the first evidence. The next
registration run on staging should show the first `get_email_code` call
reporting a link and *no* code, and the second call, made from the activation
page with `code_length=6`, returning the OTP.

The class, as opposed to these instances, is
[US-080](US-080-llm-email-code-extraction.md): LLM-primary
extraction with verbatim + length validation, this regex path demoted to
fallback and test baseline.
