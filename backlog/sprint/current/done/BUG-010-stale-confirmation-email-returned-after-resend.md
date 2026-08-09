# BUG-010 — After a Resend, `get_email_code` returns the email it already used

- **Status:** ✅ Fixed 2026-08-09 — found in staging run
  `deff8050-a995-46ff-bbb9-7c2d5dd6ca43`, which spent 34 steps and five minutes
  failing to activate an account before it was cancelled by hand. On `dev`; not
  yet exercised against a real mailbox.
- **Lives in:** `agent/email_codes.py` (`wait_for_confirmation`, `_search_folder`)
  + `agent/run_agent.py` (`get_email_code`, `mail_since`)
- **Severity:** unbounded loop on any flow with a Resend control, and the site
  is blamed for it. The agent's own evaluations read "the site rejects freshly
  issued OTPs", which is a plausible sentence to find in a bug report about
  someone else's application.

## What happens

`mail_since` is the floor for "which emails count", and it is set once, at run
start (`run_agent.py:454`):

```python
mail_since = time.time() - 60  # small clock-skew allowance
```

Every later `get_email_code` call passes that same value. `_fetch_newest`
returns the newest message addressed to the run's test address that is newer
than the floor — and an email that has already been consumed still satisfies
that, forever. So the second call does not wait for a new message. It finds the
old one already in the mailbox and returns on its first poll.

That is harmless until a Resend, which is where it becomes a trap: resending
invalidates the code it replaces. The run then does this:

1. The activation page sends OTP email B. The agent enters B's code. Rejected.
2. The agent presses Resend. The site sends C **and kills B**.
3. The agent calls `get_email_code`. C has not landed; B is still there and
   still above the floor, so B comes back.
4. The site answers "Invalid or expired OTP" — correctly, since B is dead.
5. The agent reads that as a stale code, presses Resend, and step 3 repeats.

The agent is always exactly one email behind, and every attempt to catch up
widens the gap. Nothing in the loop can end it; the run ends when a human does.

The tell is in the timings. All three `get_email_code` calls cost 6–7 seconds
of step time (steps 17→18, 25→26, 30→31), and `wait_for_confirmation` polls in
15-second chunks. Every one returned on its first poll, which only happens when
a matching message is already sitting there.

## The second defect in the same run

The first attempt typed five digits into a six-box field
(`5 0 3 5 0 _`, `step_21.png`), on a page that says "6-digit verification
code". `extract_code` takes the first digit-bearing token within 20 characters
of the words code/otp/pin/passcode/password and accepts anything 4 to 10
characters long, so a number sitting near the word "code" beats the code. It
returned a five-character token and the run entered it.

This is the worse failure shape of the two. A parse that fails loudly is a
diagnosable event; a parse that returns a confident wrong answer is
indistinguishable, from every downstream vantage point, from a site that
rejects valid codes.

## Why it survived

US-013 was built and demonstrated on a single-confirmation flow: register,
fetch once, click the link, done. In that shape `mail_since` is only ever read
once and its staleness cannot be observed, and the extracted code is either
right or the run visibly fails at the first hurdle. Resend is what makes the
second read happen, and nothing in the test suite had a second read — the
IMAP-side selection rules were uncovered on the grounds that they were I/O
(`test_email_codes.py`'s own docstring said so).

## Fix

1. **De-duplicate by `Message-ID`, and keep `mail_since` a fixed floor.**
   `Confirmation` carries `message_id`; `get_email_code` records each one it
   hands to the agent in `consumed_email_ids` and passes the set back on the
   next call, where `_search_folder` skips those messages. "Strictly newer" is
   answered by identity rather than by time.

   Advancing `mail_since` to the consumed message's `Date` was the obvious
   alternative and is **wrong**: `Date` is second-granular, so a resend landing
   in the same second as the message it replaces is skipped by a `<=`
   comparison and returned twice by a `<` one. The boundary is not resolvable
   from the timestamp, and this is a race that appears only under a fast
   mailserver — the worst possible thing to leave in a retry path. Message-ID
   has no boundary case. Where the header is absent (rare) the key falls back
   to a digest of Date/From/Subject, which can collide only for two messages
   sharing all three; that pair costs one extra poll, where trusting a missing
   header would cost the stale code the fix exists to prevent.

2. **Let the caller state the code's width.** `extract_code` takes
   `code_length`, and `get_email_code` exposes it as an action parameter the
   agent fills in by counting the boxes it can see. A token of any other length
   is refused, and the action reports that no code was found rather than
   entering one.

Three smaller things came with it, each closing a way the loop could re-form:

- **A superseded value is removed, not left behind.** A message carrying a link
  but no code used to leave the previous `email_code` in `sensitive`, so
  `<secret>email_code</secret>` would quietly resolve to the code that message
  supersedes. Each fetch now sets what it has and drops what it does not.
- **The timeout floor rose from 10 to 30 seconds.** The run asked for 10, which
  was survivable only because the answer was always already there. A call that
  genuinely waits needs room for the mail to arrive.
- **The action's own description tells the agent the ordering.** Press Resend,
  *then* call `get_email_code`, because re-entering the placeholder without a
  fetch re-sends the code the site has just invalidated. The "no new email"
  branch says the earlier codes are dead, so the agent stops treating a
  timeout as a reason to resend again.

Refusing a token opened a hole that had to be closed in the same change.
The subject line is the only email text that reaches the LLM and the event
feed, and it is scrubbed by looking for the value that was *extracted* — so a
token refused for its length would arrive intact ("Your code 50350 for SMART")
and invite exactly the guess the task prompt forbids. `mask_codes` blanks
code-shaped digit runs in the subject before `scrub` runs. It costs a masked
order number in the occasional subject, which is a display the agent has no
use for anyway.

## Guarded by

`agent/tests/test_email_codes.py`. `_search_folder` takes its connection as an
argument, so the selection rules drive through a stub connection with no IMAP
server and no network — the module stays pure-stdlib and the "it is I/O, so it
is uncovered" line in the docstring no longer holds for anything above the
socket.

Cases: the newest message wins; a consumed message is skipped for the one
behind it; **every match consumed returns nothing** (the assertion this bug is
about — handing the message back a second time is the loop); the Message-ID is
reported so the caller can record it; a message with no Message-ID gets a
stable synthetic key that also de-duplicates; older-than-floor and
wrong-recipient are still ignored; `code_length` reaches the fetched message.
Plus `wait_for_confirmation` polling until a new message appears, returning
`None` at the deadline, and passing exclusions through; and `mask_codes`
blanking a subject that is the code, blanking a refused token, and leaving an
ordinary subject alone.

⚠️ **Assertion-first** (`CLAUDE.md`): the fix changes which of several
candidate messages is chosen, and the rejected `Date`-watermark design shows
how narrow the margin is between the working answer and one that fails only
under timing. Assertions were written and reviewed before the implementation.
The register gains a **Confirmation email selection** row.

## Result

Both parts landed as proposed, with the Message-ID design chosen over the
timestamp watermark for the reason above. 303 agent tests pass, 39 of them in
`test_email_codes.py`, up from 24.

What is **not** proved yet: every assertion here runs against a stub
connection, so the fix is verified against the IMAP protocol as this module
uses it, not against a real mailserver. Gmail's `SEARCH` returning UIDs in a
different order, or a provider that rewrites `Message-ID` on delivery, would
both be invisible here. The next registration run on staging is the first real
evidence, and the thing to read from it is that the second `get_email_code`
call takes noticeably longer than the first — that is the fix working.
