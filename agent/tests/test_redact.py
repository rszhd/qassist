"""Unit tests for redact.scrub — secret redaction over emitted events (US-034).

This is security logic: wrong behaviour leaks a generated password or a fetched
confirmation code/link into the step feed, the report and the logs. Pure stdlib,
so it runs with no browser, IMAP or network.
"""
import redact


SENS = {"qa_password": "Qa1!hunter2xyz", "email_link": "https://ex.com/verify/abc123"}


class TestScrub:
    def test_known_value_is_replaced_with_named_placeholder(self):
        assert redact.scrub("password is Qa1!hunter2xyz", SENS) == "password is <redacted:qa_password>"

    def test_value_inside_a_url_is_replaced(self):
        assert (
            redact.scrub("navigated to https://ex.com/verify/abc123 now", SENS)
            == "navigated to <redacted:email_link> now"
        )

    def test_multiple_secrets_in_one_string_all_replaced(self):
        text = "Qa1!hunter2xyz then https://ex.com/verify/abc123"
        assert redact.scrub(text, SENS) == "<redacted:qa_password> then <redacted:email_link>"

    def test_repeated_occurrence_replaced_everywhere(self):
        assert redact.scrub("abc123 abc123", {"code": "abc123"}) == "<redacted:code> <redacted:code>"

    def test_absent_value_passes_through_unchanged(self):
        assert redact.scrub("nothing secret here", SENS) == "nothing secret here"

    def test_empty_sensitive_passes_through(self):
        assert redact.scrub("Qa1!hunter2xyz", {}) == "Qa1!hunter2xyz"

    def test_none_sensitive_passes_through(self):
        assert redact.scrub("Qa1!hunter2xyz", None) == "Qa1!hunter2xyz"

    def test_non_string_passes_through(self):
        assert redact.scrub(None, SENS) is None
        assert redact.scrub(42, SENS) == 42

    def test_empty_secret_value_is_ignored(self):
        # An unset code ("") must not turn every string into <redacted:...>.
        assert redact.scrub("unchanged", {"email_code": ""}) == "unchanged"
