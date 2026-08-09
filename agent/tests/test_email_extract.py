"""Unit tests for email_extract.py — the LLM-primary email reader (US-080).

The extractor's model call is a callable injected by the caller, so the whole
pipeline runs here with no network and no browser-use import: a stub "invoke"
returns a canned answer and the tests measure what validation lets through.
Validation is the story (register row 57): the model chooses, and these
assertions are what stop it inventing — a returned code must sit verbatim in
the email and match the stated width, a returned link must be a URL literally
present in it, and anything else is "nothing found", never a guess.
"""
import pytest

import email_extract as ex


SUBJECT = "Your OTP Code"
BODY = (
    "To activate your account, please enter this One-Time Password (OTP) "
    "on the activation page:\n"
    "053604\n"
    "This code will expire in 10 minutes.\n"
    "Thank You!\n"
    "CIDB E-Construct Services Sdn Bhd,\n"
    "Jalan Putra, 50350 KUALA LUMPUR\n"
    "Phone: +603- 4040 0399"
)
HTML = (
    '<a href="https://smartv2-sp.econstruct.com.my/register/'
    'account-activation/fnbvaiyvixDF"><button>Verify my account</button></a>'
)
LINK = "https://smartv2-sp.econstruct.com.my/register/account-activation/fnbvaiyvixDF"


class TestValidateCode:
    def test_code_present_verbatim_is_kept(self):
        assert ex.validate("053604", None, SUBJECT, BODY, "") == ("053604", None)

    def test_code_absent_from_the_email_is_refused(self):
        # The hallucination case: a plausible six-digit answer that appears
        # nowhere in the email must not become the code.
        assert ex.validate("123456", None, SUBJECT, BODY, "") == (None, None)

    def test_code_in_the_subject_alone_is_enough(self):
        assert ex.validate("482913", None, "482913 is your login code", "", "") == ("482913", None)

    def test_wrong_stated_length_is_refused(self):
        # Verbatim in the body, but the page shows six boxes: the postcode
        # again. Length is checked against the width the agent stated.
        assert ex.validate("50350", None, SUBJECT, BODY, "", code_length=6) == (None, None)

    def test_matching_stated_length_is_kept(self):
        assert ex.validate("053604", None, SUBJECT, BODY, "", code_length=6) == ("053604", None)

    def test_length_is_not_checked_when_unset(self):
        assert ex.validate("50350", None, SUBJECT, BODY, "") == ("50350", None)

    def test_empty_and_none_codes_pass_through_as_nothing_found(self):
        assert ex.validate(None, None, SUBJECT, BODY, "") == (None, None)
        assert ex.validate("", None, SUBJECT, BODY, "") == (None, None)

    def test_whitespace_wrapped_code_is_stripped_then_checked(self):
        assert ex.validate(" 053604\n", None, SUBJECT, BODY, "") == ("053604", None)


class TestValidateLink:
    def test_link_present_as_href_is_kept(self):
        assert ex.validate(None, LINK, SUBJECT, BODY, HTML) == (None, LINK)

    def test_link_present_in_plain_text_is_kept(self):
        body = "Activate at https://x.test/activate/1 today"
        assert ex.validate(None, "https://x.test/activate/1", "", body, "") == (None, "https://x.test/activate/1")

    def test_link_absent_from_the_email_is_refused(self):
        # An invented or "cleaned up" URL is as dangerous as an invented code:
        # the agent would navigate to it.
        assert ex.validate(None, "https://evil.test/confirm", SUBJECT, BODY, HTML) == (None, None)

    def test_link_that_is_a_prefix_of_a_real_one_is_refused(self):
        # Truncation is invention too — a shortened token is a dead link.
        assert ex.validate(None, LINK[:-4], SUBJECT, BODY, HTML) == (None, None)

    def test_trailing_punctuation_difference_is_tolerated(self):
        # The text URL ends at a sentence full stop; the model returning it
        # without the stop is still literally the email's URL.
        body = "Please activate at https://x.test/activate/1."
        assert ex.validate(None, "https://x.test/activate/1", "", body, "") == (None, "https://x.test/activate/1")

    def test_html_entities_are_unescaped_before_comparison(self):
        html = '<a href="https://x.test/confirm?a=1&amp;b=2">go</a>'
        assert ex.validate(None, "https://x.test/confirm?a=1&b=2", "", "", html) == (None, "https://x.test/confirm?a=1&b=2")


class TestParseResponse:
    def test_plain_json_object(self):
        assert ex.parse_response('{"code": "053604", "link": null}') == ("053604", None)

    def test_fenced_json(self):
        raw = '```json\n{"code": null, "link": "https://x.test/a"}\n```'
        assert ex.parse_response(raw) == (None, "https://x.test/a")

    def test_prose_around_the_object_is_tolerated(self):
        raw = 'Here is the answer: {"code": "053604", "link": null} — done.'
        assert ex.parse_response(raw) == ("053604", None)

    def test_numeric_code_is_coerced_to_string(self):
        # A model may emit the code as a JSON number; 053604 it cannot, but
        # 482913 it will. Validation still gates the coerced string.
        assert ex.parse_response('{"code": 482913, "link": null}') == ("482913", None)

    def test_garbage_is_unusable(self):
        assert ex.parse_response("I could not find a code.") is None

    def test_non_object_json_is_unusable(self):
        assert ex.parse_response('["053604"]') is None

    def test_non_string_link_is_dropped_not_fatal(self):
        assert ex.parse_response('{"code": "053604", "link": 7}') == ("053604", None)


class TestMakeExtractor:
    """The composed pipeline: invoke → parse → validate.

    Contract with email_codes: None means the call itself failed and the
    regex fallback may answer; a (code, link) tuple — even (None, None) — is
    the reader's final word and regex must stay silent behind it.
    """

    def _extract(self, raw_or_exc, subject=SUBJECT, body=BODY, html="", code_length=None):
        def invoke(system, user):
            if isinstance(raw_or_exc, Exception):
                raise raw_or_exc
            return raw_or_exc

        return ex.make_extractor(invoke)(subject, body, html, code_length)

    def test_valid_answer_flows_through(self):
        assert self._extract('{"code": "053604", "link": null}') == ("053604", None)

    def test_hallucinated_code_is_refused_as_nothing_found(self):
        # Refused, not retried and not handed to regex: (None, None) is an
        # answer, and the action reports no code found.
        assert self._extract('{"code": "123456", "link": null}') == (None, None)

    def test_wrong_length_code_is_refused_as_nothing_found(self):
        assert self._extract('{"code": "50350", "link": null}', code_length=6) == (None, None)

    def test_a_raising_call_reports_failure_for_the_regex_fallback(self):
        assert self._extract(RuntimeError("provider down")) is None

    def test_an_unparseable_answer_reports_failure_for_the_regex_fallback(self):
        assert self._extract("sorry, no JSON today") is None

    def test_the_model_reading_nothing_is_final(self):
        assert self._extract('{"code": null, "link": null}') == (None, None)

    def test_the_body_reaches_the_prompt_and_the_stated_width_is_mentioned(self):
        seen = {}

        def invoke(system, user):
            seen["system"], seen["user"] = system, user
            return '{"code": "053604", "link": null}'

        ex.make_extractor(invoke)(SUBJECT, BODY, "", 6)
        assert SUBJECT in seen["user"]
        assert "053604" in seen["user"]
        assert "6" in seen["user"]

    def test_an_oversized_body_is_truncated_before_the_prompt(self):
        big = "x" * (ex.BODY_LIMIT + 5000)
        seen = {}

        def invoke(system, user):
            seen["user"] = user
            return '{"code": null, "link": null}'

        ex.make_extractor(invoke)(SUBJECT, big, "", None)
        assert len(seen["user"]) < ex.BODY_LIMIT + 2000
