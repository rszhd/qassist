"""LLM-primary extraction of a confirmation code/link from an email (US-080).

The regex heuristics in email_codes.py fail confidently: any email whose
digits are not the code — a footer postcode typed into an OTP field was
BUG-012 — is an open set they can only chase site by site. So the primary
reader is a one-shot model call, and this module is mostly the cage around
it: the model *chooses*, validation stops it *inventing*. A returned code
must appear verbatim in the subject or body and match the stated field width;
a returned link must be a URL literally present in the email. Anything else
is "nothing found" — the diagnosable outcome, never a guess.

The model call is injected as `invoke(system, user) -> str` so this module
stays pure stdlib (the tests' no-network rule) and provider-agnostic:
run_agent.py supplies one built on the run's own BYOK client — the same
provider that already sees every page screenshot, so the body crosses no new
trust boundary. The body reaches that prompt and nowhere else.

Contract with email_codes.ImapMailbox.extractor: return None only when the
call itself failed — the regex fallback may then answer. A (code, link)
tuple, including (None, None), is the reader's final word: a regex answer
behind a reader that read the email and found nothing would be exactly the
confident wrong answer this module exists to remove.
"""
from __future__ import annotations

import json

from email_codes import labelled_links, link_candidates

# One email's stripped body comfortably fits; a mailing-list monster is cut
# rather than spent — codes and links sit at the top of real transactional
# mail, and an unbounded prompt spends the user's own key.
BODY_LIMIT = 20000

_SYSTEM_PROMPT = (
    "You read one transactional email from a signup or login flow. Find the "
    "verification code the recipient is asked to enter, and the confirmation "
    "link they are asked to open.\n"
    "Reply with only a JSON object: {\"code\": ..., \"link\": ...}. Use null "
    "for anything the email does not contain.\n"
    "The code must be copied character for character from the email — never "
    "invent, complete, or reformat one. The link must be one URL copied "
    "exactly from the list of links below, which is every URL the email "
    "contains; the body text names its links but does not spell them out. "
    "Choose the link that confirms, verifies or activates the account, not "
    "an unsubscribe, help or marketing link. Digits that are not a "
    "verification code — postcodes, phone numbers, street addresses, order "
    "numbers — are not codes; when in doubt, use null."
)


def build_prompt(
    subject: str, body_text: str, body_html: str, code_length: int | None
) -> tuple[str, str]:
    """(system, user) messages for the one-shot call.

    The links are listed separately because they are not in the text at all:
    an HTML email's URL lives in an href, and stripping the markup leaves the
    anchor text with nothing behind it. A reader shown "Verify my account"
    and no URL answers null — correctly, and the run then has no way forward,
    because that answer silences the regex fallback (staging run 6984279c).

    They go *after* the truncated body so BODY_LIMIT can never be what hides
    them.
    """
    user = f"Subject: {subject}\n\n{body_text[:BODY_LIMIT]}"
    links = labelled_links(body_text, body_html)
    if links:
        listed = "\n".join(f"- {label or '(no text)'} → {url}" for label, url in links)
        user += f"\n\nLinks in this email:\n{listed}"
    if code_length:
        user += f"\n\nThe code entry field on the page has {code_length} characters."
    return _SYSTEM_PROMPT, user


def parse_response(raw: str) -> tuple[str | None, str | None] | None:
    """(code, link) out of the model's answer, or None if unusable.

    Tolerates fences and prose around the object; an answer with no JSON
    object in it is a failed call, not an empty finding — the caller must be
    able to tell the two apart.
    """
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    code = parsed.get("code")
    if isinstance(code, int):
        code = str(code)  # models emit bare numbers; validation gates the string
    link = parsed.get("link")
    return (
        code if isinstance(code, str) else None,
        link if isinstance(link, str) else None,
    )


def validate(
    code: str | None,
    link: str | None,
    subject: str,
    body_text: str,
    body_html: str,
    code_length: int | None = None,
) -> tuple[str | None, str | None]:
    """The deterministic cage (register row 57). Each field stands alone."""
    return (
        _validated_code(code, subject, body_text, code_length),
        _validated_link(link, body_text, body_html),
    )


def _validated_code(
    code: str | None, subject: str, body_text: str, code_length: int | None
) -> str | None:
    code = (code or "").strip()
    if not code:
        return None
    if code_length and len(code) != code_length:
        return None
    if code not in subject and code not in body_text:
        return None
    return code


def _validated_link(link: str | None, body_text: str, body_html: str) -> str | None:
    if not link:
        return None
    # The text-URL regex drags sentence punctuation along; the model handing
    # back the URL without it is still literally the email's URL.
    for candidate in link_candidates(body_text, body_html):
        if link == candidate or link == candidate.rstrip(".,;"):
            return link
    return None


def make_extractor(invoke):
    """Compose invoke → parse → validate into an ImapMailbox.extractor.

    `invoke(system, user) -> str` performs the model call and may raise;
    raising — or answering something unparseable — is the "call failed"
    outcome (None), distinct from a validated "nothing found" ((None, None)).
    """

    def extract(
        subject: str,
        body_text: str,
        body_html: str,
        code_length: int | None = None,
    ) -> tuple[str | None, str | None] | None:
        system, user = build_prompt(subject, body_text, body_html, code_length)
        try:
            raw = invoke(system, user)
        except Exception:
            return None
        parsed = parse_response(raw)
        if parsed is None:
            return None
        code, link = parsed
        return validate(code, link, subject, body_text, body_html, code_length)

    return extract
