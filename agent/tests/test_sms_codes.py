"""Unit tests for sms_codes.py — the Twilio SMS code fetch (US-059 tier 2).

Same scope boundary as test_email_codes.py: the module is pure stdlib apart
from the one HTTP call, so this suite drives the pure logic directly with
hand-built Twilio message payloads. The HTTP fetch itself
(TwilioSmsInbox._fetch_newest_code) is I/O and is not covered here, same as
ImapMailbox's IMAP fetch.
"""
import sms_codes as sc


class TestParseTwilioDate:
    def test_parses_rfc2822(self):
        assert sc._parse_twilio_date("Thu, 30 Jul 2026 20:12:31 +0000") is not None

    def test_none_for_missing(self):
        assert sc._parse_twilio_date(None) is None
        assert sc._parse_twilio_date("") is None

    def test_none_for_garbage_not_raise(self):
        assert sc._parse_twilio_date("not a date") is None


class TestPickCode:
    def _msg(self, date_sent, body):
        return {"date_sent": date_sent, "body": body}

    def test_extracts_code_from_newest_qualifying_message(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        messages = [self._msg("Thu, 30 Jul 2026 20:05:00 +0000", "Your code is 482913")]
        assert sc._pick_code(messages, since) == "482913"

    def test_message_before_since_is_skipped(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        messages = [self._msg("Thu, 30 Jul 2026 19:55:00 +0000", "Your code is 482913")]
        assert sc._pick_code(messages, since) is None

    def test_first_qualifying_wins_over_later_ones_in_list_order(self):
        # Twilio's default order is newest-first; _pick_code trusts that order
        # rather than re-sorting, so the first match in the list is returned.
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        messages = [
            self._msg("Thu, 30 Jul 2026 20:10:00 +0000", "Your code is 111111"),
            self._msg("Thu, 30 Jul 2026 20:05:00 +0000", "Your code is 222222"),
        ]
        assert sc._pick_code(messages, since) == "111111"

    def test_message_with_no_extractable_code_is_skipped(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        messages = [
            self._msg("Thu, 30 Jul 2026 20:05:00 +0000", "Welcome to our service!"),
            self._msg("Thu, 30 Jul 2026 20:04:00 +0000", "Your code is 482913"),
        ]
        assert sc._pick_code(messages, since) == "482913"

    def test_no_messages_is_none(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        assert sc._pick_code([], since) is None

    def test_missing_date_sent_falls_back_to_date_created(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        message = {"date_created": "Thu, 30 Jul 2026 20:05:00 +0000", "body": "Code: 482913"}
        assert sc._pick_code([message], since) == "482913"

    def test_unparseable_date_is_skipped_not_raise(self):
        since = sc._parse_twilio_date("Thu, 30 Jul 2026 20:00:00 +0000")
        messages = [self._msg("garbage", "Your code is 482913")]
        assert sc._pick_code(messages, since) is None


class TestFromEnv:
    def test_missing_any_field_is_none(self):
        assert sc.TwilioSmsInbox.from_env({}) is None
        assert sc.TwilioSmsInbox.from_env({"QA_TWILIO_ACCOUNT_SID": "AC1"}) is None
        assert sc.TwilioSmsInbox.from_env(
            {"QA_TWILIO_ACCOUNT_SID": "AC1", "QA_TWILIO_AUTH_TOKEN": "tok"}
        ) is None

    def test_blank_fields_are_none(self):
        assert sc.TwilioSmsInbox.from_env(
            {
                "QA_TWILIO_ACCOUNT_SID": "  ",
                "QA_TWILIO_AUTH_TOKEN": "tok",
                "QA_TWILIO_TEST_NUMBER": "+15551234567",
            }
        ) is None

    def test_all_fields_present_parses(self):
        inbox = sc.TwilioSmsInbox.from_env(
            {
                "QA_TWILIO_ACCOUNT_SID": "AC1",
                "QA_TWILIO_AUTH_TOKEN": "tok",
                "QA_TWILIO_TEST_NUMBER": "+15551234567",
            }
        )
        assert inbox is not None
        assert inbox.test_number == "+15551234567"
