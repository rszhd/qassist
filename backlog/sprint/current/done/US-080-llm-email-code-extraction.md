# US-080 — The confirmation email is read by an LLM, and its answer is verified

**As** someone whose registration test depends on reading a code out of a real
transactional email, **I want** the extraction to understand the email instead
of pattern-matching it, **so that** the next site's footer, phrasing or
language does not become the next BUG-012.

- **Status:** ✅ **Done** 2026-08-10, 6/6 — filed the same day out of the staging failures behind
  [BUG-012](BUG-012-footer-postcode-extracted-as-otp.md) and
  [BUG-013](../../../bugs/BUG-013-unconsumed-stale-email-after-resend.md). Decision
  already made with the maintainer: **LLM-primary with strict validation**,
  regex as the fallback — not regex-first-with-LLM-fallback, because the regex
  failure mode is a *confident* wrong answer, and a fallback behind a confident
  answer never runs.
- **Priority:** P2 — reliability follow-up to a shipped tier. Two staging
  failures in two days is the evidence; the fixed shapes are covered by
  BUG-012's regex patch, but the class ("any email whose digits are not the
  code") is an open set regex can only chase site by site.
- **Estimate:** ~0.5–1 day
- **Depends on:** US-013 tier 1 (the extraction seam), US-039 (BYOK-only —
  every run has a funded key by construction, so the extractor always has one)

## The constraint that shapes it

**The code must never enter the agent's context.** That rule stands unchanged:
the body is parsed outside the agent, the code travels as
`<secret>email_code</secret>`, and the subject is masked (`mask_codes`) before
the agent sees it. An LLM *extractor* does not breach it — a separate one-shot
call reads the body and returns straight into the `sensitive` dict, and it
goes to the same BYOK provider that already sees every page screenshot of the
run. No new trust boundary, one small call per email.

## Details

- A one-shot structured call: subject + stripped body in (plus `code_length`
  when the agent stated one), `{code, link}` or "nothing found" out. Wired
  where `extract_code` / `extract_link` are called today
  (`_search_folder` → `Confirmation`); the agent-facing `get_email_code`
  action does not change shape.
- **Validation is the story, not the call.** The model chooses; it must not
  invent:
  - the returned code must appear **verbatim** in the subject or body;
  - it must match `code_length` when one was stated;
  - the returned link must be a URL literally present in the email
    (href or text);
  - anything else is treated as "no code found" — the diagnosable outcome,
    same as BUG-010's length refusal.
- **The regex path stays**, as the fallback when the call fails or no client
  exists, and as the deterministic baseline the unit tests drive. BUG-012's
  keyword gate is also the last line of the validation argument: a validated
  wrong pick of the right length remains possible, which is exactly what it
  is today, minus the dumb cases.
- The email body reaches the extractor and nowhere else: not the events, not
  the logs, not the report. Only the masked subject is displayable, unchanged.
- The extractor uses the run's own key and provider — if US-045 (provider
  choice) lands first, this call follows it.
- Test layer: the extractor is stubbed in `test_email_codes.py` (the module's
  no-network rule holds for tests); the validation logic is pure and tested
  directly, including a stub that "returns" a code not present in the email
  and one of the wrong length.

## What this does not fix

[BUG-013](../../../bugs/BUG-013-unconsumed-stale-email-after-resend.md) — *which*
email is selected after a Resend is a selection problem, upstream of how the
chosen email is read. Its fix is independent and stays in its own file.

## Acceptance criteria

- [x] The two real staging emails extract correctly through the LLM path:
      link-only email → link and no code; OTP email → the code, with and
      without a stated width
- [x] A stubbed extractor returning a code absent from the email, or of the
      wrong stated length, is refused — the action reports no code found
- [x] With no LLM client or a failing call, the regex path answers and the
      run proceeds (degraded, not broken)
- [x] The email body appears in no event, log, or report artifact; the
      subject still arrives masked
- [x] The agent's context never contains the code or the body — asserted the
      way the redaction tests assert it, over the emitted payload
- [x] Register row 57 extended before the implementation (assertion-first):
      the validation rules are the reviewed assertion

## Result

Shipped 2026-08-10, in the shape the story specified. New module
`agent/email_extract.py`: the model call is injected as a plain
`invoke(system, user) -> str` callable, so the module is pure stdlib and the
tests run with no network and no browser-use import; `run_agent.py` supplies
the real one — a fresh `ChatOpenAI` on the run's BYOK key per call, on
`wait_for_confirmation`'s worker thread with its own event loop, because the
agent's client is bound to the main loop. `ImapMailbox` gained an `extractor`
seam that `_search_folder` consults before the regex pair.

The contract that carries the story's argument: the extractor returns `None`
only when the call itself failed (regex may then answer), while a tuple —
including `(None, None)` — is final. A regex answer behind a reader that read
the email and found nothing would be the confident wrong answer the story
exists to remove; `TestExtractorSeam` pins that with regex's answer available
and refused.

Assertion-first order held: register row 57 extended, then 35 assertions
written red (29 in the new `test_email_extract.py`, 6 in
`test_email_codes.py`), then the implementation. The hallucination case is
tested from both sides: a code absent from the email and a verbatim code of
the wrong stated width are both refused as "nothing found". Links are gated
by membership in `link_candidates` — now shared with `extract_link` — so a
truncated or "cleaned up" URL is refused too, tolerating only the trailing
sentence punctuation the text-URL regex drags along. The body's containment
is pinned structurally: `Confirmation`'s field list is asserted, because
every event the action emits is built from it. 374 agent tests pass, up
from 339.

What is **not** proved, same lineage as BUG-010/BUG-012: everything above
runs against the real staging bodies but stubbed model answers. The first
real-model, real-mailbox evidence is the next registration run on staging —
expected shape: first `get_email_code` call answers the link alone, second
call from the activation page answers the OTP.

## Correctness-critical

This is register row 57 (Confirmation email selection) growing a second
stage: extraction by a nondeterministic reader, caged by deterministic
validation. The validation rules are the assertion-first piece — written and
reviewed before the extractor is wired. The failure shape the row gains: a
hallucinated or mis-picked token that *passes* validation is entered as the
code, so validation must be the thing that makes that require an actual
matching token in the email, not a plausible one.
