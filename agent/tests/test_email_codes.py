"""Unit tests for email_codes.py — the mailbox parsing that reads a
confirmation code or link out of a real signup email (US-013 tier 1).

This is the first agent-side test layer. The module is all pure stdlib, so the
suite runs with no browser, no IMAP server and no network: it drives the
extraction/formatting logic directly with hand-written subjects and bodies.
`_search_folder` takes its connection as an argument, so the message-selection
rules are driven through a stub connection here; only the socket setup in
`_fetch_newest` is left uncovered.
"""
import email.utils
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import email_codes as ec


def _raw_message(to, subject, body, sent, message_id="<a@test>"):
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = email.utils.format_datetime(sent)
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content(body)
    return msg.as_bytes()


class FakeConn:
    """Enough of imaplib.IMAP4_SSL for _search_folder: select/search/fetch.

    `messages` is oldest-first, mirroring the ascending sequence numbers a real
    IMAP SEARCH returns — the ordering _search_folder reverses to read newest
    first.
    """

    def __init__(self, messages, select_status="OK"):
        self.messages = list(messages)
        self.select_status = select_status

    def select(self, folder, readonly=False):
        return self.select_status, [b""]

    def search(self, charset, *criteria):
        ids = [str(i + 1).encode() for i in range(len(self.messages))]
        return "OK", [b" ".join(ids)]

    def fetch(self, msg_id, spec):
        raw = self.messages[int(msg_id) - 1]
        return "OK", [(b"1 (RFC822 {%d}" % len(raw), raw), b")"]


NOW = datetime(2026, 8, 9, 11, 46, tzinfo=timezone.utc)
ADDRESS = "qa-deff8050a9@arang.space"


def _search(messages, since=None, exclude_ids=None, code_length=None):
    conn = FakeConn(messages)
    return ec.ImapMailbox(
        host="h", port=993, user="qa@test", password="pw", domain=None,
    )._search_folder(
        conn, "INBOX", ADDRESS,
        (NOW - timedelta(minutes=1)).timestamp() if since is None else since,
        exclude_ids=exclude_ids,
        code_length=code_length,
    )


class TestExtractCode:
    def test_keyword_adjacent_wins(self):
        assert ec.extract_code("", "Your verification code is 123456.") == "123456"

    def test_pin_with_punctuation(self):
        assert ec.extract_code("", "PIN: 9482 — do not share") == "9482"

    def test_filler_after_keyword_is_skipped_for_the_real_token(self):
        # "below" has no digit, so the keyword match keeps scanning to the code.
        assert ec.extract_code("", "Your code is below\n\n482913") == "482913"

    def test_alphanumeric_token(self):
        assert ec.extract_code("", "Your code is A1B2C3 today") == "A1B2C3"

    def test_leading_digits_in_subject(self):
        # Token precedes the keyword, so the subject-leading rule supplies it.
        assert ec.extract_code("482913 is your login code", "") == "482913"

    def test_standalone_digits_in_body_without_keyword(self):
        assert ec.extract_code("Hello", "Your reference is 5567 for records") == "5567"

    def test_no_code_returns_none(self):
        assert ec.extract_code("Newsletter", "Welcome to our site, enjoy") is None

    def test_too_long_a_run_is_not_a_code(self):
        # Standalone matcher caps at 8 digits, so an order number isn't a code.
        assert ec.extract_code("Order", "Order 1234567890 shipped") is None


class TestExtractCodeLength:
    """`code_length` is the field width the page asks for, when the agent can
    see it. The staging run of 2026-08-09 is the case: a 5-character token was
    returned for a six-box OTP field, five boxes filled, and the site answered
    "invalid OTP" — a parse failure wearing the costume of a site bug.
    """

    def test_short_token_is_rejected_rather_than_returned(self):
        assert ec.extract_code("", "Your code is 50350 today", code_length=6) is None

    def test_matching_token_wins_over_a_nearer_wrong_length(self):
        body = "Your code expires in 30 minutes. Verification code: 782721"
        assert ec.extract_code("", body, code_length=6) == "782721"

    def test_length_is_not_checked_when_unset(self):
        assert ec.extract_code("", "Your code is 50350 today") == "50350"

    def test_alphanumeric_code_of_the_right_length_still_matches(self):
        assert ec.extract_code("", "Your code is A1B2C3 today", code_length=6) == "A1B2C3"


class TestSearchFolderSelection:
    def test_newest_message_wins(self):
        messages = [
            _raw_message(ADDRESS, "Older", "Your code is 111111", NOW, "<old@test>"),
            _raw_message(ADDRESS, "Newer", "Your code is 222222", NOW + timedelta(seconds=30), "<new@test>"),
        ]
        assert _search(messages).code == "222222"

    def test_consumed_message_is_skipped_for_the_one_behind_it(self):
        messages = [
            _raw_message(ADDRESS, "Older", "Your code is 111111", NOW, "<old@test>"),
            _raw_message(ADDRESS, "Newer", "Your code is 222222", NOW + timedelta(seconds=30), "<new@test>"),
        ]
        assert _search(messages, exclude_ids={"<new@test>"}).code == "111111"

    def test_nothing_is_returned_once_every_match_is_consumed(self):
        # The watermark assertion. After a resend the site has invalidated the
        # code in the message we already used, so handing it back a second time
        # guarantees "invalid or expired" forever (staging, 2026-08-09).
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, "<one@test>")]
        assert _search(messages, exclude_ids={"<one@test>"}) is None

    def test_message_id_is_reported_so_the_caller_can_record_it(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, "<one@test>")]
        assert _search(messages).message_id == "<one@test>"

    def test_message_without_an_id_gets_a_stable_synthetic_key(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, message_id=None)]
        first = _search(messages).message_id
        assert first
        assert _search(messages).message_id == first
        assert _search(messages, exclude_ids={first}) is None

    def test_message_older_than_since_is_ignored(self):
        messages = [_raw_message(ADDRESS, "Stale", "Your code is 111111", NOW - timedelta(hours=2), "<old@test>")]
        assert _search(messages, since=NOW.timestamp()) is None

    def test_message_to_another_address_is_ignored(self):
        messages = [_raw_message("someone-else@arang.space", "Other", "Your code is 111111", NOW, "<x@test>")]
        assert _search(messages) is None

    def test_code_length_is_applied_to_the_fetched_message(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 50350", NOW, "<one@test>")]
        found = _search(messages, code_length=6)
        assert found is not None
        assert found.code is None


class TestWaitForConfirmation:
    def _mailbox(self, results):
        box = ec.ImapMailbox(host="h", port=993, user="qa@test", password="pw", domain=None)
        self.calls = []

        def fake_fetch(to_address, since, exclude_ids=None, code_length=None):
            self.calls.append(exclude_ids)
            return results.pop(0) if results else None

        box._fetch_newest = fake_fetch
        return box

    def test_polls_until_a_new_message_appears(self):
        found = ec.Confirmation(subject="s", sender="f", code="222222", link=None, message_id="<new@test>")
        box = self._mailbox([None, None, found])
        got = box.wait_for_confirmation(ADDRESS, NOW.timestamp(), timeout=5, poll_interval=0)
        assert got is found
        assert len(self.calls) == 3

    def test_returns_none_when_the_deadline_passes(self):
        box = self._mailbox([])
        assert box.wait_for_confirmation(ADDRESS, NOW.timestamp(), timeout=0, poll_interval=0) is None

    def test_exclusions_reach_the_fetch(self):
        box = self._mailbox([])
        box.wait_for_confirmation(
            ADDRESS, NOW.timestamp(), timeout=0, poll_interval=0, exclude_ids={"<one@test>"}
        )
        assert self.calls == [{"<one@test>"}]


class TestMaskCodes:
    """The subject is the only email text that reaches the LLM, and `scrub`
    only knows the token that was extracted — so a refused one must still be
    blanked before it can be read off the feed and guessed.
    """

    def test_subject_that_is_the_code(self):
        assert ec.mask_codes("482913 is your login code") == "<redacted:code> is your login code"

    def test_refused_wrong_length_token_is_still_masked(self):
        assert "50350" not in ec.mask_codes("Your code 50350 for SMART")

    def test_ordinary_subject_is_untouched(self):
        assert ec.mask_codes("Welcome to SMART") == "Welcome to SMART"

    def test_short_number_is_not_code_shaped(self):
        assert ec.mask_codes("Top 10 tips") == "Top 10 tips"


class TestExtractLink:
    def test_confirm_href_from_html(self):
        html = '<a href="https://x.test/verify?token=abc">Confirm</a>'
        assert ec.extract_link("", html) == "https://x.test/verify?token=abc"

    def test_trailing_punctuation_is_stripped(self):
        text = "Please activate at https://x.test/activate/1."
        assert ec.extract_link(text, "") == "https://x.test/activate/1"

    def test_html_entities_in_href_are_unescaped(self):
        html = '<a href="https://x.test/confirm?a=1&amp;b=2">go</a>'
        assert ec.extract_link("", html) == "https://x.test/confirm?a=1&b=2"

    def test_non_confirmation_link_is_ignored(self):
        assert ec.extract_link("Visit https://example.test/home for more", "") is None


class TestStripHtml:
    def test_tags_removed_and_text_kept(self):
        out = ec._strip_html("<p>Hello <b>world</b></p>")
        assert "Hello" in out and "world" in out
        assert "<" not in out and ">" not in out

    def test_script_contents_dropped(self):
        out = ec._strip_html("<script>steal()</script>Visible")
        assert "Visible" in out
        assert "steal" not in out


class TestGenerateAddress:
    def _mailbox(self, domain):
        return ec.ImapMailbox(
            host="imap.gmail.com", port=993,
            user="qa.inbox@gmail.com", password="pw", domain=domain,
        )

    def test_plus_addressing_when_no_catch_all(self):
        assert self._mailbox(None).generate_address("42") == "qa.inbox+qa-42@gmail.com"

    def test_catch_all_domain_when_set(self):
        assert self._mailbox("qa.example.test").generate_address("42") == "qa-42@qa.example.test"


class TestFromEnv:
    def test_none_without_credentials(self):
        assert ec.ImapMailbox.from_env({}) is None

    def test_none_when_password_missing(self):
        assert ec.ImapMailbox.from_env({"QA_IMAP_USER": "qa@gmail.com"}) is None

    def test_defaults(self):
        box = ec.ImapMailbox.from_env({"QA_IMAP_USER": "qa@gmail.com", "QA_IMAP_PASSWORD": "pw"})
        assert box is not None
        assert box.host == "imap.gmail.com"
        assert box.port == 993
        assert box.folders == ["INBOX"]
        assert box.domain is None

    def test_folder_list_is_split_and_trimmed(self):
        box = ec.ImapMailbox.from_env({
            "QA_IMAP_USER": "qa@gmail.com",
            "QA_IMAP_PASSWORD": "pw",
            "QA_IMAP_FOLDERS": "INBOX, [Gmail]/Spam ",
            "QA_MAILBOX_DOMAIN": "qa.example.test",
        })
        assert box is not None
        assert box.folders == ["INBOX", "[Gmail]/Spam"]
        assert box.domain == "qa.example.test"
